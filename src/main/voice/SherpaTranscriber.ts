import { OfflineRecognizer } from "sherpa-onnx-node";
import { join } from "node:path";
import { SAMPLE_RATE, type ModelId } from "../../shared/voice";
import { MODELS } from "./models";

type TranscriptResult = Record<string, unknown> & { text: string };

export class SherpaTranscriber {
    private recognizer: OfflineRecognizer;

    constructor(id: ModelId, directory: string) {
        const model = MODELS.find((candidate) => candidate.id === id);
        if (model == null) {
            throw new Error("Unknown model");
        }

        const files = Object.fromEntries(
            Object.entries(model.config).map(([key, file]) => [
                key,
                join(directory, file),
            ]),
        );
        const { tokens, ...graphs } = files;
        const modelGraphs: Record<string, string> = { ...graphs };
        if (model.kind === "whisper") {
            modelGraphs.language = "en";
            modelGraphs.task = "transcribe";
        }

        const modelConfig: Record<string, unknown> = {
            tokens,
            numThreads: 2,
            provider: "cpu",
            debug: 0,
            [model.kind]: modelGraphs,
        };
        if (model.kind === "transducer") {
            modelConfig.modelType = "nemo_transducer";
        }

        this.recognizer = new OfflineRecognizer({
            featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
            modelConfig,
            decodingMethod: "greedy_search",
        });
    }

    async transcribe(samples: Float32Array): Promise<TranscriptResult> {
        const stream = this.recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        return this.recognizer.decodeAsync(stream);
    }
}
