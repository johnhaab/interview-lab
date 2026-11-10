declare module "sherpa-onnx-node" {
    export class OfflineRecognizer {
        constructor(config: Record<string, unknown>);
        createStream(): {
            acceptWaveform(audio: {
                samples: Float32Array;
                sampleRate: number;
            }): void;
        };
        decodeAsync(
            stream: ReturnType<OfflineRecognizer["createStream"]>,
        ): Promise<Record<string, unknown> & { text: string }>;
    }
    export class Vad {
        constructor(config: Record<string, unknown>, seconds: number);
        acceptWaveform(samples: Float32Array): void;
        isEmpty(): boolean;
        isDetected(): boolean;
        front(copy?: boolean): { start: number; samples: Float32Array };
        pop(): void;
        flush(): void;
        reset(): void;
    }
}
