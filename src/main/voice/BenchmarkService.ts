import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { InferenceWorker } from "./InferenceWorker";
import { ModelManager } from "./ModelManager";
import {
    processTranscript,
    fillerRetention,
    wordErrorRate,
} from "../../shared/TranscriptProcessor";
import {
    SAMPLE_RATE,
    type BenchmarkReport,
    type ModelId,
    type VadSettings,
    type VoiceEvent,
} from "../../shared/voice";

export class BenchmarkService {
    private worker?: InferenceWorker;
    private cancelled = false;
    constructor(
        private models: ModelManager,
        private emit: (event: VoiceEvent) => void,
    ) {}
    async cancel(): Promise<void> {
        this.cancelled = true;
        await this.worker?.dispose();
        this.worker = undefined;
    }
    async run(
        sample: Float32Array,
        vad: VadSettings,
        modelIds?: readonly ModelId[],
    ): Promise<BenchmarkReport> {
        this.cancelled = false;
        const report: BenchmarkReport = {
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sampleSha256: createHash("sha256")
                .update(
                    new Uint8Array(
                        sample.buffer,
                        sample.byteOffset,
                        sample.byteLength,
                    ),
                )
                .digest("hex"),
            sampleRate: SAMPLE_RATE,
            duration: sample.length / SAMPLE_RATE,
            vad,
            runtime: {
                platform: process.platform,
                arch: process.arch,
                sherpa: "2.0.1",
                threads: 2,
            },
            rows: [],
        };
        const installed = (await this.models.list()).filter(
            (model) =>
                model.installed && (!modelIds || modelIds.includes(model.id)),
        );
        if (installed.length === 0) {
            throw new Error("Download at least one model");
        }
        for (const model of installed) {
            if (this.cancelled) {
                throw new Error("Cancelled");
            }
            this.emit({ type: "benchmark-progress", modelId: model.id });
            const worker = new InferenceWorker((event) => {
                if (event.type === "error") {
                    this.emit(event);
                }
            });
            this.worker = worker;
            let loadMs: number | null = null;
            try {
                await this.models.validate(model.id);
                const before = performance.now();
                await worker.request({
                    type: "load",
                    modelId: model.id,
                    directory: this.models.directory(model.id),
                });
                loadMs = performance.now() - before;
                await worker.request({
                    type: "start",
                    vadPath: this.models.vadPath,
                    settings: vad,
                    retain: false,
                });
                const started = performance.now();
                // Same PCM, same VAD settings and same packet boundaries for every model.
                for (let i = 0; i < sample.length; i += 2048) {
                    if (this.cancelled) {
                        throw new Error("Cancelled");
                    }
                    await worker.request({
                        type: "audio",
                        samples: sample.slice(i, i + 2048),
                    });
                }
                const output = await worker.request({ type: "stop" });
                if (output == null) {
                    throw new Error("Worker returned no result");
                }
                const processingMs = performance.now() - started;
                report.rows.push({
                    modelId: model.id,
                    modelName: model.name,
                    loadMs,
                    processingMs,
                    realTimeFactor: processingMs / 1000 / report.duration,
                    ...processTranscript(
                        output.result.segments.map((s) => s.raw).join(" "),
                    ),
                    segments: output.result.segments,
                });
            } catch (error) {
                if (this.cancelled) {
                    throw new Error("Cancelled");
                }
                report.rows.push({
                    modelId: model.id,
                    modelName: model.name,
                    loadMs,
                    processingMs: null,
                    realTimeFactor: null,
                    raw: "",
                    cleaned: "",
                    fillers: [],
                    segments: [],
                    error: errorMessage(error),
                });
            } finally {
                await worker.dispose();
                this.worker = undefined;
            }
        }
        return report;
    }
}
export function exportReport(
    report: BenchmarkReport,
    reference: string,
    format: "json" | "csv",
): string {
    const rows = report.rows.map((row) => {
        let errorRate: number | null = null;
        let retention: number | null = null;
        if (row.error == null) {
            errorRate = wordErrorRate(reference, row.raw);
            retention = fillerRetention(reference, row.raw);
        }
        return {
            ...row,
            wordErrorRate: errorRate,
            fillerRetention: retention,
        };
    });
    if (format === "json") {
        return JSON.stringify({ ...report, reference, rows }, null, 2);
    }
    const columns = [
        "modelId",
        "modelName",
        "raw",
        "cleaned",
        "fillers",
        "processingMs",
        "loadMs",
        "realTimeFactor",
        "wordErrorRate",
        "fillerRetention",
        "error",
        "reference",
        "sampleSha256",
        "sampleRate",
        "duration",
        "vad",
        "runtime",
    ] as const;
    return [
        columns.join(","),
        ...rows.map((row) => {
            const data = {
                ...row,
                fillers: JSON.stringify(row.fillers),
                reference,
                sampleSha256: report.sampleSha256,
                sampleRate: report.sampleRate,
                duration: report.duration,
                vad: JSON.stringify(report.vad),
                runtime: JSON.stringify(report.runtime),
            };
            return columns.map((key) => quoteCsvValue(data[key])).join(",");
        }),
    ].join("\r\n");
}

function quoteCsvValue(value: unknown): string {
    let text = String(value ?? "");
    if (/^[=+@\-\t\r]/.test(text)) {
        text = "'" + text;
    }
    return `"${text.replace(/"/g, "\u0022\u0022")}"`;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
