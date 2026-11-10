export const SAMPLE_RATE = 16000;
export const MAX_CAPTURE_SECONDS = 120;
export const DEFAULT_VAD: VadSettings = {
    threshold: 0.5,
    minSpeechDuration: 0.15,
    minSilenceDuration: 0.5,
    maxSpeechDuration: 15,
};
export type ModelId = "moonshine-tiny" | "whisper-tiny" | "parakeet-en";
export type HardwareTier = "low" | "mid" | "high";
export interface HardwareProfile {
    platform: string;
    operatingSystem: string;
    release: string;
    arch: string;
    cpuModel: string;
    logicalCores: number;
    totalMemoryBytes: number;
    availableMemoryBytes: number;
    tier: HardwareTier;
    fingerprint: string;
}
export interface AutoBenchmarkResult {
    modelId: ModelId;
    processingMs: number | null;
    realTimeFactor: number | null;
    wordErrorRate: number | null;
    error?: string;
}
export interface SelectionThresholds {
    excellent: number;
    acceptable: number;
}
export interface ModelSelectionStatus {
    hardware: HardwareProfile;
    selectedModelId: ModelId | null;
    loadedModelId: ModelId | null;
    overrideModelId: ModelId | null;
    mode: "automatic" | "manual";
    reason: string;
    benchmarks: AutoBenchmarkResult[];
    cacheState: "hit" | "miss" | "stale";
    thresholds: SelectionThresholds;
}
export interface VoiceResourceStats {
    sampledAt: number;
    voiceCpuPercent: number;
    systemCpuPercent: number;
    voiceMemoryBytes: number;
    totalMemoryBytes: number;
    availableMemoryBytes: number;
    systemMemoryPercent: number;
}
export interface VadSettings {
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    maxSpeechDuration: number;
}
export interface ModelInfo {
    id: ModelId;
    name: string;
    license: string;
    downloadMB: number;
    installed: boolean;
    supportsPartial: boolean;
}
export interface Filler {
    word: string;
    count: number;
}
export interface Segment {
    start: number;
    end: number;
    raw: string;
    cleaned: string;
    fillers: Filler[];
    processingMs: number;
    latencyMs: number;
    result: Record<string, unknown>;
}
export interface Pause {
    start: number;
    duration: number;
}
export interface CaptureResult {
    segments: Segment[];
    pauses: Pause[];
    duration: number;
    processingMs: number;
}
export interface BenchmarkRow {
    modelId: ModelId;
    modelName: string;
    loadMs: number | null;
    processingMs: number | null;
    realTimeFactor: number | null;
    raw: string;
    cleaned: string;
    fillers: Filler[];
    segments: Segment[];
    error?: string;
}
export interface BenchmarkRuntime {
    platform: string;
    arch: string;
    sherpa: string;
    threads: number;
}
export interface BenchmarkReport {
    schemaVersion: 1;
    createdAt: string;
    sampleSha256: string;
    sampleRate: number;
    duration: number;
    vad: VadSettings;
    runtime: BenchmarkRuntime;
    rows: BenchmarkRow[];
}
export type VoiceEvent =
    | { type: "download"; modelId: ModelId; progress: number; stage: string }
    | { type: "segment"; segment: Segment }
    | { type: "activity"; speaking: boolean; pauses: Pause[] }
    | { type: "benchmark-progress"; modelId: ModelId }
    | { type: "selection"; status: ModelSelectionStatus }
    | { type: "error"; message: string };
export interface VoiceApi {
    models(): Promise<ModelInfo[]>;
    download(id: ModelId): Promise<void>;
    load(id: ModelId): Promise<void>;
    start(settings: VadSettings, benchmark: boolean): Promise<void>;
    audio(samples: Float32Array): Promise<void>;
    stop(): Promise<CaptureResult>;
    cancel(): Promise<void>;
    benchmark(): Promise<BenchmarkReport>;
    selection(): Promise<ModelSelectionStatus>;
    setModelOverride(id: ModelId | null): Promise<ModelSelectionStatus>;
    rerunSelectionBenchmark(): Promise<ModelSelectionStatus>;
    resources(): Promise<VoiceResourceStats>;
    export(format: "json" | "csv", reference: string): Promise<boolean>;
    onEvent(callback: (event: VoiceEvent) => void): () => void;
}

export function validateVad(value: VadSettings): void {
    const ranges: Record<keyof VadSettings, [number, number]> = {
        threshold: [0.05, 0.95],
        minSpeechDuration: [0.05, 1],
        minSilenceDuration: [0.1, 2],
        maxSpeechDuration: [3, 30],
    };
    if (value == null || typeof value !== "object") {
        throw new Error("Invalid VAD settings");
    }
    for (const [key, [min, max]] of Object.entries(ranges)) {
        const setting = value[key as keyof VadSettings];
        if (!Number.isFinite(setting) || setting < min || setting > max) {
            throw new Error(`Invalid VAD setting: ${key}`);
        }
    }
}
