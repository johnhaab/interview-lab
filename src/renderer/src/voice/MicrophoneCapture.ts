import workletUrl from "./capture.worklet.js?url";
import {
    MAX_CAPTURE_SECONDS,
    SAMPLE_RATE,
    type CaptureResult,
    type VadSettings,
} from "../../../shared/voice";

export class MicrophoneCapture {
    private stream?: MediaStream;
    private context?: AudioContext;
    private node?: AudioWorkletNode;
    private source?: MediaStreamAudioSourceNode;
    private setup?: Promise<void>;
    private stopping = false;
    private active = false;
    private chain = Promise.resolve();
    private pending = 0;
    private failure?: Error;
    private flushDone?: () => void;
    private limitTimer?: ReturnType<typeof setTimeout>;
    constructor(
        private activity: (rms: number) => void,
        private onLimit: () => void,
        private onError: (error: Error) => void,
    ) {}
    start(settings: VadSettings, benchmark: boolean): Promise<void> {
        this.setup = this.open(settings, benchmark);
        return this.setup;
    }
    private async open(
        settings: VadSettings,
        benchmark: boolean,
    ): Promise<void> {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: SAMPLE_RATE,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                video: false,
            });
            if (this.stopping) {
                return;
            }
            this.context = new AudioContext({
                sampleRate: SAMPLE_RATE,
                latencyHint: "interactive",
            });
            if (this.context.sampleRate !== SAMPLE_RATE) {
                throw new Error("This audio device cannot provide 16 kHz PCM");
            }
            await this.context.audioWorklet.addModule(workletUrl);
            if (this.stopping) {
                return;
            }
            await window.api.voice.start(settings, benchmark);
            this.active = true;
            this.node = new AudioWorkletNode(this.context, "pcm-capture");
            this.node.onprocessorerror = () =>
                this.fail(new Error("AudioWorklet failed; recording stopped"));
            this.node.port.onmessage = (event) =>
                this.handleWorkletMessage(event);
            this.source = this.context.createMediaStreamSource(this.stream);
            this.source.connect(this.node);
            this.node.connect(this.context.destination);
            await this.context.resume();
            this.limitTimer = setTimeout(
                this.onLimit,
                (MAX_CAPTURE_SECONDS - 1) * 1000,
            );
            const audioTrack = this.stream.getAudioTracks()[0];
            if (audioTrack == null) {
                throw new Error(
                    "The microphone did not provide an audio track",
                );
            }
            audioTrack.onended = () =>
                this.fail(new Error("Microphone disconnected"));
        } catch (error) {
            await window.api.voice.cancel();
            await this.cleanup();
            throw error;
        }
    }

    private handleWorkletMessage(
        event: MessageEvent<{ type: string; samples?: Float32Array }>,
    ): void {
        const { data } = event;
        if (data.type === "flushed") {
            this.flushDone?.();
            return;
        }
        if (data.samples == null || this.failure != null) {
            return;
        }

        const samples = data.samples;
        let squaredTotal = 0;
        for (const sample of samples) {
            squaredTotal += sample * sample;
        }
        this.activity(Math.sqrt(squaredTotal / samples.length));

        this.pending += 1;
        if (this.pending > 32) {
            this.pending -= 1;
            samples.fill(0);
            this.fail(
                new Error(
                    "Audio processing cannot keep up. Recording stopped.",
                ),
            );
            return;
        }
        this.chain = this.chain
            .then(() => window.api.voice.audio(samples))
            .catch((error: unknown) => {
                this.fail(toError(error));
            })
            .finally(() => {
                samples.fill(0);
                this.pending -= 1;
            });
    }

    private fail(error: Error): void {
        if (this.failure != null) {
            return;
        }
        this.failure = error;
        this.onError(error);
    }
    async stop(): Promise<CaptureResult | undefined> {
        this.stopping = true;
        try {
            await this.setup;
            if (!this.active) {
                return;
            }
            if (this.node != null && this.failure == null) {
                const node = this.node;
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error("AudioWorklet flush timed out")),
                        3000,
                    );
                    this.flushDone = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                    node.port.postMessage("stop");
                });
            }
            this.source?.disconnect();
            for (const track of this.stream?.getTracks() ?? []) {
                track.stop();
            }
            await this.chain;
            if (this.failure != null) {
                throw this.failure;
            }
            return await window.api.voice.stop();
        } catch (error) {
            await window.api.voice.cancel();
            throw error;
        } finally {
            await this.cleanup();
        }
    }
    async cancel(): Promise<void> {
        this.stopping = true;
        await this.cleanup();
        await this.setup?.catch(() => undefined);
        await this.cleanup();
        await window.api.voice.cancel();
    }
    private async cleanup(): Promise<void> {
        clearTimeout(this.limitTimer);
        this.active = false;
        this.source?.disconnect();
        this.node?.disconnect();
        this.node?.port.close();
        for (const track of this.stream?.getTracks() ?? []) {
            track.onended = null;
            track.stop();
        }
        if (this.context != null && this.context.state !== "closed") {
            await this.context.close();
        }
        this.activity(0);
    }
}

function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    return new Error(String(error));
}
