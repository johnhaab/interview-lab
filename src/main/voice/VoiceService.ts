import { wordErrorRate } from "../../shared/TranscriptProcessor";
import type {
    AutoBenchmarkResult,
    BenchmarkReport,
    CaptureResult,
    ModelId,
    ModelSelectionStatus,
    VadSettings,
    VoiceEvent,
    VoiceResourceStats,
} from "../../shared/voice";
import {
    DEFAULT_VAD,
    MAX_CAPTURE_SECONDS,
    SAMPLE_RATE,
    validateVad,
} from "../../shared/voice";
import { BENCHMARK_REFERENCE, readBenchmarkWave } from "./BenchmarkAudio";
import { BenchmarkService } from "./BenchmarkService";
import { InferenceWorker } from "./InferenceWorker";
import { ModelManager } from "./ModelManager";
import { createResourceMonitor } from "./ResourceMonitor";
import {
    AUTO_SELECTION_THRESHOLDS,
    ENGINE_VERSION,
    benchmarkCandidates,
    detectHardware,
    fallbackOrder,
    isSelectionCacheValid,
    parseSelectionCache,
    selectModel,
    type SelectionCache,
} from "./ModelSelection";

interface VoiceServiceOptions {
    benchmarkSamplePath?: string;
    readSelectionCache?: () => string | null | Promise<string | null>;
    writeSelectionCache?: (value: string) => void | Promise<void>;
}

type VoiceState =
    | "idle"
    | "loading"
    | "ready"
    | "recording"
    | "stopping"
    | "benchmarking"
    | "downloading"
    | "cancelling";

interface LoadedModel {
    modelId: ModelId;
    reason: string;
}

export class VoiceService {
    readonly models: ModelManager;
    readonly benchmarks: BenchmarkService;
    report?: BenchmarkReport;
    private worker?: InferenceWorker;
    private sample?: Float32Array;
    private sampleSettings?: VadSettings;
    private currentModelId: ModelId | null = null;
    private cache: SelectionCache | null = null;
    private selectionTask?: Promise<ModelSelectionStatus>;
    private selectionInitialized = false;
    private failedModels = new Set<ModelId>();
    private poorSegments = 0;
    private recoverAfterCancel = false;
    private sampleResources = createResourceMonitor();
    private status: ModelSelectionStatus = {
        hardware: detectHardware(),
        selectedModelId: null,
        loadedModelId: null,
        overrideModelId: null,
        mode: "automatic",
        reason: "Checking installed models and cached performance...",
        benchmarks: [],
        cacheState: "miss",
        thresholds: AUTO_SELECTION_THRESHOLDS,
    };
    private state: VoiceState = "idle";
    private generation = 0;
    private samples = 0;

    constructor(
        root: string,
        private emit: (event: VoiceEvent) => void,
        private options: VoiceServiceOptions = {},
    ) {
        this.models = new ModelManager(root, emit);
        this.benchmarks = new BenchmarkService(this.models, emit);
    }

    private ensureIdle(): void {
        if (!["idle", "ready"].includes(this.state)) {
            throw new Error("Voice service is busy");
        }
    }

    private async waitForSelection(): Promise<void> {
        if (this.selectionTask != null) {
            await this.selectionTask;
        }
    }

    private async installedModelIds(): Promise<ModelId[]> {
        const models = await this.models.list();
        return models
            .filter((model) => model.installed)
            .map((model) => model.id);
    }

    async selection(): Promise<ModelSelectionStatus> {
        const selectionIsCurrent =
            this.selectionInitialized &&
            (this.status.loadedModelId === null ||
                this.currentModelId === this.status.loadedModelId);
        if (selectionIsCurrent) {
            return structuredClone(this.status);
        }
        return this.runSelection(false);
    }

    resourceUsage(): VoiceResourceStats {
        return this.sampleResources();
    }

    async rerunSelectionBenchmark(): Promise<ModelSelectionStatus> {
        await this.waitForSelection();
        return this.runSelection(true);
    }

    async setModelOverride(id: ModelId | null): Promise<ModelSelectionStatus> {
        await this.waitForSelection();
        this.ensureIdle();
        if (id != null) {
            this.models.definition(id);
        }
        const cache = (await this.readCache()) ?? this.newCache();
        cache.overrideModelId = id;
        cache.updatedAt = new Date().toISOString();
        this.cache = cache;
        await this.writeCache(cache);
        if (id == null) {
            return this.runSelection(cache.benchmarks.length === 0);
        }

        const installed = await this.installedModelIds();
        if (!installed.includes(id)) {
            throw new Error("The selected model is not installed");
        }
        this.failedModels.delete(id);
        const decision = selectModel(installed, cache.benchmarks, id);
        const loaded = await this.loadWithFallback(
            decision.modelId,
            installed,
            cache.benchmarks,
        );
        const manualLoaded = loaded.modelId === id;
        let mode: ModelSelectionStatus["mode"] = "automatic";
        let reason = `The manual override failed to load. ${loaded.reason}`;
        if (manualLoaded) {
            mode = "manual";
            reason = decision.reason;
        }
        this.status = {
            ...this.status,
            selectedModelId: loaded.modelId,
            loadedModelId: loaded.modelId,
            overrideModelId: id,
            mode,
            reason,
            benchmarks: cache.benchmarks,
        };
        cache.selectedModelId = loaded.modelId;
        cache.reason = this.status.reason;
        await this.writeCache(cache);
        return this.publishStatus();
    }

    private runSelection(force: boolean): Promise<ModelSelectionStatus> {
        if (this.selectionTask != null) {
            return this.selectionTask;
        }
        this.selectionTask = this.selectAndLoad(force).finally(() => {
            this.selectionTask = undefined;
        });
        return this.selectionTask;
    }

    private async selectAndLoad(force: boolean): Promise<ModelSelectionStatus> {
        this.ensureIdle();
        if (force) {
            this.failedModels.clear();
        }
        const hardware = detectHardware();
        const installed = await this.installedModelIds();
        const fingerprints = await this.models.installedFingerprints();
        const previousCache = await this.readCache();
        const overrideModelId = previousCache?.overrideModelId ?? null;
        let validCache = false;
        let cacheState: ModelSelectionStatus["cacheState"] = "miss";
        if (previousCache != null) {
            validCache = isSelectionCacheValid(
                previousCache,
                hardware.fingerprint,
                fingerprints,
                hardware.tier,
            );
            if (validCache) {
                cacheState = "hit";
            } else {
                cacheState = "stale";
            }
        }

        if (installed.length === 0) {
            this.status = {
                hardware,
                selectedModelId: null,
                loadedModelId: null,
                overrideModelId,
                mode: "automatic",
                reason: "No speech recognition model is installed. Download one model to continue.",
                benchmarks: [],
                cacheState,
                thresholds: AUTO_SELECTION_THRESHOLDS,
            };
            return this.publishStatus();
        }

        if (
            overrideModelId != null &&
            installed.includes(overrideModelId) &&
            !force
        ) {
            const cachedBenchmarks = previousCache?.benchmarks ?? [];
            const loaded = await this.loadWithFallback(
                overrideModelId,
                installed,
                cachedBenchmarks,
            );
            const manualLoaded = loaded.modelId === overrideModelId;
            let mode: ModelSelectionStatus["mode"] = "automatic";
            let reason = `The manual override failed to load. ${loaded.reason}`;
            if (manualLoaded) {
                mode = "manual";
                reason = `Using the manual ${this.models.definition(overrideModelId).name} override.`;
            }
            let benchmarks: AutoBenchmarkResult[] = [];
            if (validCache) {
                benchmarks = cachedBenchmarks;
            }
            this.status = {
                hardware,
                selectedModelId: loaded.modelId,
                loadedModelId: loaded.modelId,
                overrideModelId,
                mode,
                reason,
                benchmarks,
                cacheState,
                thresholds: AUTO_SELECTION_THRESHOLDS,
            };
            await this.persistStatus(fingerprints);
            return this.publishStatus();
        }

        let results: AutoBenchmarkResult[] = [];
        if (validCache && !force && previousCache != null) {
            results = previousCache.benchmarks;
        }
        if (results.length === 0 || force) {
            if (this.options.benchmarkSamplePath == null) {
                throw new Error(
                    "The bundled voice benchmark sample is unavailable",
                );
            }
            const candidates = benchmarkCandidates(
                installed,
                hardware.availableMemoryBytes,
            );
            this.state = "benchmarking";
            const previous = this.worker;
            this.worker = undefined;
            this.currentModelId = null;
            await previous?.dispose();
            const sample = await readBenchmarkWave(
                this.options.benchmarkSamplePath,
            );
            try {
                const report = await this.benchmarks.run(
                    sample,
                    DEFAULT_VAD,
                    candidates,
                );
                results = report.rows.map((row): AutoBenchmarkResult => {
                    let errorRate: number | null = null;
                    if (row.error == null) {
                        errorRate = wordErrorRate(BENCHMARK_REFERENCE, row.raw);
                    }
                    return {
                        modelId: row.modelId,
                        processingMs: row.processingMs,
                        realTimeFactor: row.realTimeFactor,
                        wordErrorRate: errorRate,
                        error: row.error,
                    };
                });
            } finally {
                sample.fill(0);
                if (this.state === "benchmarking") {
                    this.state = "idle";
                }
            }
        }

        const decision = selectModel(installed, results, overrideModelId);
        const loaded = await this.loadWithFallback(
            decision.modelId,
            installed,
            results,
        );
        const manualLoaded =
            overrideModelId !== null && loaded.modelId === overrideModelId;
        let mode: ModelSelectionStatus["mode"] = "automatic";
        if (manualLoaded) {
            mode = "manual";
        }
        let reason = decision.reason;
        if (loaded.modelId !== decision.modelId) {
            reason = `${decision.reason} ${loaded.reason}`;
        }
        this.status = {
            hardware,
            selectedModelId: loaded.modelId,
            loadedModelId: loaded.modelId,
            overrideModelId,
            mode,
            reason,
            benchmarks: results,
            cacheState,
            thresholds: AUTO_SELECTION_THRESHOLDS,
        };
        await this.persistStatus(fingerprints);
        return this.publishStatus();
    }

    private async loadWithFallback(
        preferred: ModelId | null,
        installed: ModelId[],
        benchmarks: AutoBenchmarkResult[],
    ): Promise<LoadedModel> {
        const failures: string[] = [];
        for (const id of fallbackOrder(
            preferred,
            installed,
            benchmarks,
            this.failedModels,
        )) {
            try {
                await this.loadInternal(id);
                let reason = "";
                if (failures.length > 0) {
                    reason = `${this.models.definition(id).name} loaded as the next available fallback.`;
                }
                return {
                    modelId: id,
                    reason,
                };
            } catch (error) {
                this.failedModels.add(id);
                failures.push(
                    `${this.models.definition(id).name}: ${errorText(error)}`,
                );
            }
        }
        throw new Error(
            `No installed model could be loaded. ${failures.join(" ")}`,
        );
    }

    private async loadInternal(id: ModelId): Promise<void> {
        this.state = "loading";
        const previous = this.worker;
        this.worker = undefined;
        this.currentModelId = null;
        await previous?.dispose();
        try {
            await this.models.validate(id);
            const worker = new InferenceWorker((event) =>
                this.handleInferenceEvent(event),
            );
            this.worker = worker;
            await worker.request({
                type: "load",
                modelId: id,
                directory: this.models.directory(id),
            });
            this.currentModelId = id;
            this.failedModels.delete(id);
            this.poorSegments = 0;
            this.state = "ready";
        } catch (error) {
            await this.worker?.dispose();
            this.worker = undefined;
            this.currentModelId = null;
            this.state = "idle";
            throw error;
        }
    }

    private handleInferenceEvent(event: VoiceEvent): void {
        if (event.type === "error" && this.currentModelId != null) {
            this.failedModels.add(this.currentModelId);
            this.recoverAfterCancel = true;
            this.emit(event);
            return;
        }

        if (
            event.type !== "segment" ||
            this.currentModelId == null ||
            this.status.mode !== "automatic"
        ) {
            this.emit(event);
            return;
        }

        const duration = event.segment.end - event.segment.start;
        let realTimeFactor = 0;
        if (duration > 0) {
            realTimeFactor = event.segment.processingMs / 1000 / duration;
        }
        if (realTimeFactor > AUTO_SELECTION_THRESHOLDS.acceptable) {
            this.poorSegments += 1;
        } else {
            this.poorSegments = 0;
        }

        if (
            this.poorSegments >= 3 &&
            this.cache != null &&
            !this.cache.needsBenchmark
        ) {
            this.cache.needsBenchmark = true;
            this.cache.reason =
                "Live inference repeatedly exceeded the acceptable RTF threshold.";
            this.status.reason = `${this.cache.reason} Performance will be reevaluated before the next automatic load.`;
            void this.writeCache(this.cache);
            this.emit({ type: "selection", status: this.status });
        }
        this.emit(event);
    }

    private async readCache(): Promise<SelectionCache | null> {
        if (this.cache != null) {
            return this.cache;
        }
        try {
            this.cache = parseSelectionCache(
                (await this.options.readSelectionCache?.()) ?? null,
            );
        } catch {
            this.cache = null;
        }
        return this.cache;
    }

    private newCache(): SelectionCache {
        return {
            schemaVersion: 1,
            hardwareFingerprint: this.status.hardware.fingerprint,
            hardwareTier: this.status.hardware.tier,
            engineVersion: ENGINE_VERSION,
            modelFingerprints: {},
            selectedModelId: this.status.selectedModelId,
            overrideModelId: this.status.overrideModelId,
            reason: this.status.reason,
            benchmarks: this.status.benchmarks,
            needsBenchmark: false,
            updatedAt: new Date().toISOString(),
        };
    }

    private async persistStatus(
        modelFingerprints: Partial<Record<ModelId, string>>,
    ): Promise<void> {
        const cache: SelectionCache = {
            schemaVersion: 1,
            hardwareFingerprint: this.status.hardware.fingerprint,
            hardwareTier: this.status.hardware.tier,
            engineVersion: ENGINE_VERSION,
            modelFingerprints,
            selectedModelId: this.status.selectedModelId,
            overrideModelId: this.status.overrideModelId,
            reason: this.status.reason,
            benchmarks: this.status.benchmarks,
            needsBenchmark: false,
            updatedAt: new Date().toISOString(),
        };
        this.cache = cache;
        await this.writeCache(cache);
    }

    private async writeCache(cache: SelectionCache): Promise<void> {
        try {
            await this.options.writeSelectionCache?.(JSON.stringify(cache));
        } catch {
            // Selection remains functional when preference storage is unavailable.
        }
    }

    private publishStatus(): ModelSelectionStatus {
        this.selectionInitialized = true;
        const status = structuredClone(this.status);
        this.emit({ type: "selection", status });
        return status;
    }

    async download(id: ModelId): Promise<void> {
        await this.waitForSelection();
        this.ensureIdle();
        this.state = "downloading";
        const generation = this.generation;
        const previous = this.worker;
        this.worker = undefined;
        this.currentModelId = null;
        await previous?.dispose();
        try {
            if (generation !== this.generation) {
                throw new Error("Cancelled");
            }
            await this.models.download(id);
        } finally {
            if (generation === this.generation) {
                this.state = "idle";
            }
        }
        if (generation === this.generation) {
            await this.rerunSelectionBenchmark();
        }
    }

    async load(id: ModelId): Promise<void> {
        await this.waitForSelection();
        this.ensureIdle();
        this.models.definition(id);
        const generation = this.generation;
        try {
            await this.loadInternal(id);
            if (generation !== this.generation) {
                throw new Error("Cancelled");
            }
        } catch (error) {
            if (generation === this.generation) {
                await this.worker?.dispose();
                this.worker = undefined;
                this.currentModelId = null;
                this.state = "idle";
            }
            throw error;
        }
    }

    async start(settings: VadSettings, benchmark: boolean): Promise<void> {
        validateVad(settings);
        if (this.state !== "ready" || this.worker == null) {
            throw new Error("Load a model first");
        }
        this.state = "recording";
        this.samples = 0;
        const generation = this.generation;
        this.releaseSample();
        this.report = undefined;
        this.sampleSettings = { ...settings };
        try {
            await this.worker.request({
                type: "start",
                vadPath: this.models.vadPath,
                settings,
                retain: benchmark,
            });
        } catch (error) {
            if (generation === this.generation) {
                await this.cancel();
            }
            throw error;
        }
    }

    async audio(samples: Float32Array): Promise<void> {
        if (this.state !== "recording" || this.worker == null) {
            throw new Error("Recording is not active");
        }
        if (!validAudioPacket(samples)) {
            throw new Error("Invalid PCM packet");
        }
        this.samples += samples.length;
        if (this.samples > MAX_CAPTURE_SECONDS * SAMPLE_RATE) {
            throw new Error("Maximum capture length is 120 seconds");
        }
        await this.worker.request({ type: "audio", samples });
    }

    async stop(): Promise<CaptureResult> {
        if (this.state !== "recording" || this.worker == null) {
            throw new Error("Recording is not active");
        }
        this.state = "stopping";
        const generation = this.generation;
        try {
            const output = await this.worker.request({ type: "stop" });
            if (generation !== this.generation) {
                throw new Error("Cancelled");
            }
            if (output == null) {
                throw new Error("No capture result");
            }
            this.sample = output.sample;
            this.state = "ready";
            return output.result;
        } catch (error) {
            if (generation === this.generation) {
                await this.cancel();
            }
            throw error;
        }
    }

    async benchmark(): Promise<BenchmarkReport> {
        this.ensureIdle();
        if (!this.sample?.length || this.sampleSettings == null) {
            throw new Error("Capture a benchmark sample first");
        }
        this.state = "benchmarking";
        const generation = this.generation;
        const previous = this.worker;
        this.worker = undefined;
        this.currentModelId = null;
        await previous?.dispose();
        try {
            if (generation !== this.generation) {
                throw new Error("Cancelled");
            }
            const report = await this.benchmarks.run(
                this.sample,
                this.sampleSettings,
            );
            if (generation !== this.generation) {
                throw new Error("Cancelled");
            }
            this.report = report;
            return report;
        } finally {
            this.releaseSample();
            if (generation === this.generation) {
                this.state = "idle";
            }
        }
    }

    private releaseSample(): void {
        this.sample?.fill(0);
        this.sample = undefined;
    }

    async cancel(): Promise<void> {
        const generation = ++this.generation;
        const shouldRecover = this.recoverAfterCancel;
        this.recoverAfterCancel = false;
        this.state = "cancelling";
        const downloadCancellation = this.models.cancel();
        this.releaseSample();
        this.report = undefined;
        const worker = this.worker;
        this.worker = undefined;
        this.currentModelId = null;
        await Promise.all([
            worker?.dispose(),
            this.benchmarks.cancel(),
            downloadCancellation,
        ]);
        if (generation === this.generation) {
            this.state = "idle";
        }
        if (shouldRecover && generation === this.generation) {
            await this.recoverFromInferenceFailure();
        }
    }

    private async recoverFromInferenceFailure(): Promise<void> {
        try {
            const installed = await this.installedModelIds();
            const loaded = await this.loadWithFallback(
                this.status.selectedModelId,
                installed,
                this.status.benchmarks,
            );
            let recoveryReason = loaded.reason;
            if (recoveryReason.length === 0) {
                recoveryReason = `${this.models.definition(loaded.modelId).name} was reloaded.`;
            }
            this.status = {
                ...this.status,
                selectedModelId: loaded.modelId,
                loadedModelId: loaded.modelId,
                mode: "automatic",
                reason: `Inference failed; ${recoveryReason}`,
            };
            this.publishStatus();
        } catch (error) {
            this.emit({
                type: "error",
                message: `Automatic fallback failed: ${errorText(error)}`,
            });
        }
    }
}

function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function validAudioPacket(samples: Float32Array): boolean {
    if (!(samples instanceof Float32Array)) {
        return false;
    }
    if (samples.length < 1 || samples.length > 4096) {
        return false;
    }
    return !samples.some((sample) => {
        return !Number.isFinite(sample) || Math.abs(sample) > 1.01;
    });
}
