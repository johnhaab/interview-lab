import { Vad } from "sherpa-onnx-node";
import { SAMPLE_RATE, type Pause, type VadSettings } from "../../shared/voice";

interface DetectedSpeech {
    start: number;
    samples: Float32Array;
}

export class SpeechDetector {
    private vad: Vad;
    private tail = new Float32Array(0);
    private lastEnd: number | null = null;
    readonly pauses: Pause[] = [];

    constructor(
        path: string,
        private settings: VadSettings,
    ) {
        this.vad = new Vad(
            {
                sileroVad: { model: path, ...settings, windowSize: 512 },
                sampleRate: SAMPLE_RATE,
                numThreads: 1,
                provider: "cpu",
                debug: false,
            },
            60,
        );
    }
    get speaking(): boolean {
        return this.vad.isDetected();
    }

    accept(samples: Float32Array): DetectedSpeech[] {
        const merged = new Float32Array(this.tail.length + samples.length);
        merged.set(this.tail);
        merged.set(samples, this.tail.length);
        const end = merged.length - (merged.length % 512);
        for (let offset = 0; offset < end; offset += 512) {
            this.vad.acceptWaveform(merged.subarray(offset, offset + 512));
        }
        this.tail = merged.slice(end);
        return this.drain();
    }

    flush(): DetectedSpeech[] {
        if (this.tail.length) {
            const padded = new Float32Array(512);
            padded.set(this.tail);
            this.vad.acceptWaveform(padded);
        }
        this.tail = new Float32Array(0);
        this.vad.flush();
        return this.drain();
    }

    private drain(): DetectedSpeech[] {
        const segments: DetectedSpeech[] = [];
        while (!this.vad.isEmpty()) {
            const segment = this.vad.front(false);
            this.vad.pop();
            const start = segment.start / SAMPLE_RATE;
            if (
                this.lastEnd !== null &&
                start - this.lastEnd >= this.settings.minSilenceDuration
            ) {
                this.pauses.push({
                    start: this.lastEnd,
                    duration: start - this.lastEnd,
                });
            }
            this.lastEnd =
                (segment.start + segment.samples.length) / SAMPLE_RATE;
            segments.push(segment);
        }
        return segments;
    }
}
