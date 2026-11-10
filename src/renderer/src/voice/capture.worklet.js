// AudioContext converts device-rate audio to 16 kHz before this worklet.
class PcmCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(2048);
        this.offset = 0;
        this.active = true;
        this.port.onmessage = ({ data }) => {
            if (data === "stop") {
                this.active = false;
                this.flush();
                this.port.postMessage({ type: "flushed" });
            }
        };
    }
    flush() {
        if (this.offset === 0) {
            return;
        }
        const samples = this.buffer.slice(0, this.offset);
        this.port.postMessage({ type: "audio", samples }, [samples.buffer]);
        this.offset = 0;
    }
    process(inputs, outputs) {
        // A muted destination keeps Chromium's graph running without mic monitoring.
        for (const channel of outputs[0] ?? []) {
            channel.fill(0);
        }
        const channels = inputs[0];
        if (!this.active || channels == null || channels.length === 0) {
            return this.active;
        }
        for (let i = 0; i < channels[0].length; i++) {
            let sample = 0;
            for (const channel of channels)
                sample += channel[i] / channels.length;
            this.buffer[this.offset++] = Math.max(-1, Math.min(1, sample));
            if (this.offset === this.buffer.length) {
                this.flush();
            }
        }
        return true;
    }
}
registerProcessor("pcm-capture", PcmCapture);
