import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { WorkerMessage, WorkerRequest, WorkerResult } from "./protocol";
import type { VoiceEvent } from "../../shared/voice";

interface PendingRequest {
    resolve(value: WorkerResult | undefined): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

export class InferenceWorker {
    private worker = new Worker(join(__dirname, "voice-worker.js"));
    private sequence = 0;
    private closed = false;
    private pending = new Map<number, PendingRequest>();
    constructor(emit: (event: VoiceEvent) => void) {
        this.worker.on("message", (message: WorkerMessage) => {
            if (message.type === "event") {
                emit(message.event);
                return;
            }
            const request = this.pending.get(message.id);
            if (request == null) {
                return;
            }
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            if (message.error != null) {
                request.reject(new Error(message.error));
                return;
            }
            request.resolve(message.value);
        });
        this.worker.on("error", (error) => {
            this.fail(error);
            emit({ type: "error", message: error.message });
        });
        this.worker.on("exit", (code) => {
            if (!this.closed) {
                const message = `Inference worker exited (${code}). Reload a model.`;
                this.fail(new Error(message));
                emit({ type: "error", message });
            }
        });
    }
    request(command: WorkerRequest): Promise<WorkerResult | undefined> {
        if (this.closed) {
            return Promise.reject(new Error("Inference worker is closed"));
        }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(new Error("Inference timed out. Reload a model."));
                void this.worker.terminate();
            }, 180_000);
            this.pending.set(id, { resolve, reject, timer });
            if (command.type === "audio") {
                this.worker.postMessage({ ...command, id }, [
                    command.samples.buffer as ArrayBuffer,
                ]);
                return;
            }
            this.worker.postMessage({ ...command, id });
        });
    }
    private fail(error: Error): void {
        this.closed = true;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }
    async dispose(): Promise<void> {
        this.fail(new Error("Cancelled"));
        await this.worker.terminate();
    }
}
