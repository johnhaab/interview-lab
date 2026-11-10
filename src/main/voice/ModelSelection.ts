import { createHash } from "node:crypto";
import {
    arch,
    cpus,
    freemem,
    platform,
    release,
    totalmem,
    type,
} from "node:os";
import type {
    AutoBenchmarkResult,
    HardwareProfile,
    HardwareTier,
    ModelId,
} from "../../shared/voice";
import { MODELS } from "./models";

export const ENGINE_VERSION = "sherpa-onnx-node@2.0.1";
export const AUTO_SELECTION_THRESHOLDS = {
    excellent: 0.3,
    acceptable: 0.7,
} as const;

export interface SelectionCache {
    schemaVersion: 1;
    hardwareFingerprint: string;
    hardwareTier: HardwareTier;
    engineVersion: string;
    modelFingerprints: Partial<Record<ModelId, string>>;
    selectedModelId: ModelId | null;
    overrideModelId: ModelId | null;
    reason: string;
    benchmarks: AutoBenchmarkResult[];
    needsBenchmark: boolean;
    updatedAt: string;
}

interface HardwareMeasurements {
    platform: string;
    operatingSystem: string;
    release: string;
    arch: string;
    cpuModel: string;
    logicalCores: number;
    totalMemoryBytes: number;
    availableMemoryBytes: number;
}

interface ModelSelection {
    modelId: ModelId | null;
    mode: "automatic" | "manual";
    reason: string;
}

interface MeasuredBenchmark extends AutoBenchmarkResult {
    realTimeFactor: number;
}

const modelIds = new Set<ModelId>(MODELS.map((model) => model.id));
const gibibyte = 1024 ** 3;

export function estimateHardwareTier(
    hardware: HardwareMeasurements,
): HardwareTier {
    const totalGB = hardware.totalMemoryBytes / gibibyte;
    const availableGB = hardware.availableMemoryBytes / gibibyte;
    if (
        !["x64", "arm64"].includes(hardware.arch) ||
        hardware.logicalCores < 4 ||
        totalGB < 6 ||
        availableGB < 2
    ) {
        return "low";
    }
    if (hardware.logicalCores >= 8 && totalGB >= 12 && availableGB >= 6) {
        return "high";
    }
    return "mid";
}

export function hardwareFingerprint(hardware: HardwareMeasurements): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                platform: hardware.platform,
                operatingSystem: hardware.operatingSystem,
                release: hardware.release,
                arch: hardware.arch,
                cpuModel: hardware.cpuModel,
                logicalCores: hardware.logicalCores,
                totalMemoryBytes: hardware.totalMemoryBytes,
            }),
        )
        .digest("hex");
}

export function detectHardware(): HardwareProfile {
    const processors = cpus();
    const measurements: HardwareMeasurements = {
        platform: platform(),
        operatingSystem: type(),
        release: release(),
        arch: arch(),
        cpuModel: processors[0]?.model.trim() || "Unknown CPU",
        logicalCores: Math.max(1, processors.length),
        totalMemoryBytes: totalmem(),
        availableMemoryBytes: freemem(),
    };
    return {
        ...measurements,
        tier: estimateHardwareTier(measurements),
        fingerprint: hardwareFingerprint(measurements),
    };
}

export function benchmarkCandidates(
    installed: ModelId[],
    availableMemoryBytes: number,
): ModelId[] {
    const availableMB = availableMemoryBytes / 1024 ** 2;
    const suitable = MODELS.filter(
        (model) =>
            installed.includes(model.id) &&
            model.minimumAvailableMemoryMB <= availableMB,
    ).map((model) => model.id);

    let candidates = suitable;
    if (candidates.length === 0) {
        candidates = MODELS.filter((model) => installed.includes(model.id))
            .sort(
                (a, b) =>
                    a.minimumAvailableMemoryMB - b.minimumAvailableMemoryMB,
            )
            .slice(0, 1)
            .map((model) => model.id);
    }

    return candidates.sort((a, b) => {
        if (a === "moonshine-tiny") {
            return -1;
        }
        if (b === "moonshine-tiny") {
            return 1;
        }
        return definition(b).accuracyRank - definition(a).accuracyRank;
    });
}

export function selectModel(
    installed: ModelId[],
    benchmarks: AutoBenchmarkResult[],
    overrideModelId: ModelId | null,
): ModelSelection {
    if (overrideModelId != null && installed.includes(overrideModelId)) {
        return {
            modelId: overrideModelId,
            mode: "manual",
            reason: `Using the manual ${definition(overrideModelId).name} override.`,
        };
    }

    const successful = benchmarks.filter(
        (result): result is MeasuredBenchmark =>
            installed.includes(result.modelId) &&
            result.realTimeFactor !== null &&
            Number.isFinite(result.realTimeFactor) &&
            !result.error,
    );
    const acceptable = successful
        .filter(
            (result) =>
                result.realTimeFactor <= AUTO_SELECTION_THRESHOLDS.acceptable,
        )
        .sort(
            (a, b) =>
                definition(b.modelId).accuracyRank -
                    definition(a.modelId).accuracyRank ||
                a.realTimeFactor - b.realTimeFactor,
        );
    if (acceptable[0]) {
        const result = acceptable[0];
        let performance = "acceptable";
        if (result.realTimeFactor < AUTO_SELECTION_THRESHOLDS.excellent) {
            performance = "excellent";
        }
        return {
            modelId: result.modelId,
            mode: "automatic",
            reason: `${definition(result.modelId).name} was selected with ${performance} measured performance (${result.realTimeFactor.toFixed(2)} RTF).`,
        };
    }
    const fastest = successful.sort(
        (a, b) => a.realTimeFactor - b.realTimeFactor,
    )[0];
    if (fastest) {
        return {
            modelId: fastest.modelId,
            mode: "automatic",
            reason: `${definition(fastest.modelId).name} was the fastest installed model (${fastest.realTimeFactor.toFixed(2)} RTF), although it exceeded the ${AUTO_SELECTION_THRESHOLDS.acceptable.toFixed(1)} RTF target.`,
        };
    }

    const fallback =
        benchmarkCandidates(installed, Number.POSITIVE_INFINITY)[0] ?? null;
    if (fallback == null) {
        return {
            modelId: null,
            mode: "automatic",
            reason: "No speech recognition model is installed.",
        };
    }

    return {
        modelId: fallback,
        mode: "automatic",
        reason: `No benchmark completed successfully; using ${definition(fallback).name} as the safest installed fallback.`,
    };
}

export function fallbackOrder(
    preferred: ModelId | null,
    installed: ModelId[],
    benchmarks: AutoBenchmarkResult[],
    failed: ReadonlySet<ModelId> = new Set(),
): ModelId[] {
    const performance = new Map<ModelId, number>();
    for (const result of benchmarks) {
        if (result.realTimeFactor != null && result.error == null) {
            performance.set(result.modelId, result.realTimeFactor);
        }
    }

    return [...installed]
        .filter((id) => !failed.has(id))
        .sort((a, b) => {
            if (a === preferred) {
                return -1;
            }
            if (b === preferred) {
                return 1;
            }
            const aRtf = performance.get(a);
            const bRtf = performance.get(b);
            if (aRtf !== undefined && bRtf !== undefined) {
                return aRtf - bRtf;
            }
            if (aRtf !== undefined) {
                return -1;
            }
            if (bRtf !== undefined) {
                return 1;
            }
            return (
                definition(a).minimumAvailableMemoryMB -
                definition(b).minimumAvailableMemoryMB
            );
        });
}

export function parseSelectionCache(
    value: string | null,
): SelectionCache | null {
    if (value == null) {
        return null;
    }

    try {
        const cache = JSON.parse(value) as Partial<SelectionCache>;
        if (cache.schemaVersion !== 1) {
            return null;
        }
        if (typeof cache.hardwareFingerprint !== "string") {
            return null;
        }
        if (!isHardwareTier(cache.hardwareTier)) {
            return null;
        }
        if (typeof cache.engineVersion !== "string") {
            return null;
        }
        if (
            cache.modelFingerprints == null ||
            typeof cache.modelFingerprints !== "object"
        ) {
            return null;
        }
        if (!nullableModelId(cache.selectedModelId)) {
            return null;
        }
        if (!nullableModelId(cache.overrideModelId)) {
            return null;
        }
        if (typeof cache.reason !== "string") {
            return null;
        }
        if (!Array.isArray(cache.benchmarks)) {
            return null;
        }
        if (!cache.benchmarks.every(validBenchmarkResult)) {
            return null;
        }
        if (typeof cache.needsBenchmark !== "boolean") {
            return null;
        }
        if (typeof cache.updatedAt !== "string") {
            return null;
        }
        return cache as SelectionCache;
    } catch {
        return null;
    }
}

export function isSelectionCacheValid(
    cache: SelectionCache,
    hardwareFingerprintValue: string,
    modelFingerprints: Partial<Record<ModelId, string>>,
    hardwareTier: HardwareTier,
): boolean {
    return (
        !cache.needsBenchmark &&
        cache.hardwareFingerprint === hardwareFingerprintValue &&
        cache.hardwareTier === hardwareTier &&
        cache.engineVersion === ENGINE_VERSION &&
        JSON.stringify(cache.modelFingerprints) ===
            JSON.stringify(modelFingerprints)
    );
}

function definition(id: ModelId): (typeof MODELS)[number] {
    const model = MODELS.find((candidate) => candidate.id === id);
    if (model == null) {
        throw new Error(`Unknown voice model: ${id}`);
    }
    return model;
}

function isModelId(value: unknown): value is ModelId {
    return typeof value === "string" && modelIds.has(value as ModelId);
}

function nullableModelId(value: unknown): value is ModelId | null {
    return value === null || isModelId(value);
}

function isHardwareTier(value: unknown): value is HardwareTier {
    return value === "low" || value === "mid" || value === "high";
}

function validBenchmarkResult(result: AutoBenchmarkResult): boolean {
    if (result == null || !isModelId(result.modelId)) {
        return false;
    }
    if (!nullableFinite(result.processingMs)) {
        return false;
    }
    if (!nullableFinite(result.realTimeFactor)) {
        return false;
    }
    if (!nullableFinite(result.wordErrorRate)) {
        return false;
    }
    return result.error === undefined || typeof result.error === "string";
}

function nullableFinite(value: unknown): boolean {
    return (
        value === null || (typeof value === "number" && Number.isFinite(value))
    );
}
