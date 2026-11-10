import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MODELS, VAD_SHA256 } from "./models";
import type { ModelId, ModelInfo, VoiceEvent } from "../../shared/voice";

const MODEL_RELEASE_URL =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";

export async function sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

export class ModelManager {
    private downloadController?: AbortController;
    private downloadDone?: Promise<void>;

    constructor(
        readonly root: string,
        private emit: (event: VoiceEvent) => void,
    ) {}

    directory(id: ModelId): string {
        return join(this.root, id);
    }
    get vadPath(): string {
        return join(this.root, "silero_vad.onnx");
    }
    definition(id: ModelId): (typeof MODELS)[number] {
        const model = MODELS.find((candidate) => candidate.id === id);
        if (model == null) {
            throw new Error("Unknown model");
        }
        return model;
    }
    async list(): Promise<ModelInfo[]> {
        return Promise.all(
            MODELS.map(async (model) => ({
                id: model.id,
                name: model.name,
                license: model.license,
                downloadMB: model.downloadMB,
                supportsPartial: false,
                installed: await this.present(model.id),
            })),
        );
    }
    async installedFingerprints(): Promise<Partial<Record<ModelId, string>>> {
        const fingerprints: Partial<Record<ModelId, string>> = {};
        for (const model of MODELS) {
            if (!(await this.present(model.id))) {
                continue;
            }
            const files: Array<[string, string, number, number]> = [];
            for (const file of model.files) {
                const details = await stat(
                    join(this.directory(model.id), file.name),
                );
                files.push([
                    file.name,
                    file.sha256,
                    details.size,
                    details.mtimeMs,
                ]);
            }
            const vad = await stat(this.vadPath);
            fingerprints[model.id] = createHash("sha256")
                .update(
                    JSON.stringify({
                        files,
                        vad: [VAD_SHA256, vad.size, vad.mtimeMs],
                    }),
                )
                .digest("hex");
        }
        return fingerprints;
    }
    private async present(id: ModelId): Promise<boolean> {
        try {
            for (const file of this.definition(id).files) {
                if (
                    !(await stat(join(this.directory(id), file.name))).isFile()
                ) {
                    return false;
                }
            }
            return (await stat(this.vadPath)).isFile();
        } catch {
            return false;
        }
    }
    async validate(id: ModelId): Promise<void> {
        for (const file of this.definition(id).files) {
            if (
                (await sha256(join(this.directory(id), file.name))) !==
                file.sha256
            ) {
                throw new Error(
                    `Model file checksum mismatch: ${file.name}. Download the model again.`,
                );
            }
        }
        if ((await sha256(this.vadPath)) !== VAD_SHA256) {
            throw new Error(
                "Silero checksum mismatch. Download the model again.",
            );
        }
    }

    async cancel(): Promise<void> {
        this.downloadController?.abort();
        await this.downloadDone?.catch(() => undefined);
    }

    async download(id: ModelId): Promise<void> {
        if (this.downloadController != null) {
            throw new Error("A download is already running");
        }

        const model = this.definition(id);
        const controller = new AbortController();
        this.downloadController = controller;
        const download = this.downloadModel(model, controller);
        this.downloadDone = download;
        try {
            await download;
        } finally {
            if (this.downloadDone === download) {
                this.downloadController = undefined;
                this.downloadDone = undefined;
            }
        }
    }

    private async downloadModel(
        model: (typeof MODELS)[number],
        controller: AbortController,
    ): Promise<void> {
        let temporary: string | undefined;
        try {
            await mkdir(this.root, { recursive: true });
            temporary = await mkdtemp(join(this.root, ".download-"));
            const archive = join(temporary, "model.tar.bz2");
            const notify = (stage: string, progress: number): void =>
                this.emit({
                    type: "download",
                    modelId: model.id,
                    stage,
                    progress,
                });
            await this.fetchFile(
                MODEL_RELEASE_URL + model.archive + ".tar.bz2",
                archive,
                controller.signal,
                (p) => notify("Downloading model", p),
            );
            notify("Verifying archive", 1);
            if ((await sha256(archive)) !== model.sha256) {
                throw new Error(
                    "Archive checksum mismatch; download discarded",
                );
            }
            controller.signal.throwIfAborted();
            notify("Extracting verified model", 0);
            await promisify(execFile)(
                "tar",
                [
                    "-xjf",
                    "model.tar.bz2",
                    ...model.files.map((f) => `${model.archive}/${f.name}`),
                ],
                {
                    cwd: temporary,
                    signal: controller.signal,
                    windowsHide: true,
                },
            );
            for (const file of model.files) {
                if (
                    (await sha256(
                        join(temporary, model.archive, file.name),
                    )) !== file.sha256
                ) {
                    throw new Error(
                        `Extracted checksum mismatch: ${file.name}`,
                    );
                }
            }
            const vad = join(temporary, "silero_vad.onnx");
            await this.fetchFile(
                MODEL_RELEASE_URL + "silero_vad.onnx",
                vad,
                controller.signal,
                (p) => notify("Downloading Silero VAD", p),
            );
            if ((await sha256(vad)) !== VAD_SHA256) {
                throw new Error("Silero checksum mismatch");
            }
            controller.signal.throwIfAborted();
            await rm(this.directory(model.id), {
                recursive: true,
                force: true,
            });
            await rename(
                join(temporary, model.archive),
                this.directory(model.id),
            );
            await rm(this.vadPath, { force: true });
            await rename(vad, this.vadPath);
            notify("Installed and verified", 1);
        } finally {
            if (temporary != null) {
                await rm(temporary, { recursive: true, force: true });
            }
        }
    }
    private async fetchFile(
        url: string,
        target: string,
        signal: AbortSignal,
        progress: (fraction: number) => void,
    ): Promise<void> {
        const response = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
        });
        if (!response.ok || response.body == null) {
            throw new Error(`Model download failed: HTTP ${response.status}`);
        }
        const size = Number(response.headers.get("content-length"));
        let received = 0;
        let lastUpdate = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                received += chunk.length;
                if (Date.now() - lastUpdate > 200) {
                    let fraction = 0;
                    if (size > 0) {
                        fraction = received / size;
                    }
                    progress(fraction);
                    lastUpdate = Date.now();
                }
                callback(null, chunk);
            },
        });
        await pipeline(
            Readable.fromWeb(
                response.body as import("node:stream/web").ReadableStream,
            ),
            meter,
            createWriteStream(target),
            { signal },
        );
    }
}
