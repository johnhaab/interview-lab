import { test } from "node:test";
import assert from "node:assert/strict";
import type {
    AutoBenchmarkResult,
    HardwareProfile,
    ModelId,
} from "../src/shared/voice";
import {
    ENGINE_VERSION,
    benchmarkCandidates,
    estimateHardwareTier,
    fallbackOrder,
    isSelectionCacheValid,
    parseSelectionCache,
    selectModel,
    type SelectionCache,
} from "../src/main/voice/ModelSelection";

const hardware = (
    logicalCores: number,
    totalGB: number,
    availableGB: number,
): Omit<HardwareProfile, "tier" | "fingerprint"> => ({
    platform: "win32",
    operatingSystem: "Windows_NT",
    release: "10.0",
    arch: "x64",
    cpuModel: "Test CPU",
    logicalCores,
    totalMemoryBytes: totalGB * 1024 ** 3,
    availableMemoryBytes: availableGB * 1024 ** 3,
});

const result = (
    modelId: ModelId,
    realTimeFactor: number,
): AutoBenchmarkResult => ({
    modelId,
    processingMs: realTimeFactor * 6000,
    realTimeFactor,
    wordErrorRate: 0.1,
});

test("hardware tiers combine architecture, cores, total memory and available memory", () => {
    assert.equal(estimateHardwareTier(hardware(2, 16, 12)), "low");
    assert.equal(estimateHardwareTier(hardware(8, 16, 1)), "low");
    assert.equal(estimateHardwareTier(hardware(6, 8, 4)), "mid");
    assert.equal(estimateHardwareTier(hardware(12, 32, 12)), "high");
});

test("selection chooses an installed model that meets the RTF target", () => {
    const decision = selectModel(
        ["moonshine-tiny", "whisper-tiny", "parakeet-en"],
        [
            result("moonshine-tiny", 0.1),
            result("whisper-tiny", 0.25),
            result("parakeet-en", 0.6),
        ],
        null,
    );
    assert.equal(decision.modelId, "parakeet-en");
    assert.equal(decision.mode, "automatic");
});

test("selection uses the fastest measured installed model when every result is slow", () => {
    const decision = selectModel(
        ["moonshine-tiny", "whisper-tiny"],
        [result("moonshine-tiny", 0.82), result("whisper-tiny", 1.1)],
        null,
    );
    assert.equal(decision.modelId, "moonshine-tiny");
    assert.match(decision.reason, /fastest installed model/);
});

test("manual override wins without inventing benchmark data for the model", () => {
    const decision = selectModel(
        ["moonshine-tiny", "parakeet-en"],
        [result("moonshine-tiny", 0.1)],
        "parakeet-en",
    );
    assert.equal(decision.modelId, "parakeet-en");
    assert.equal(decision.mode, "manual");
});

test("benchmark candidates respect available memory but keep one installed fallback", () => {
    assert.deepEqual(
        benchmarkCandidates(
            ["moonshine-tiny", "whisper-tiny", "parakeet-en"],
            1024 ** 3,
        ),
        ["moonshine-tiny", "whisper-tiny"],
    );
    assert.deepEqual(benchmarkCandidates(["parakeet-en"], 256 * 1024 ** 2), [
        "parakeet-en",
    ]);
});

test("fallback order tries the selected model, measured alternatives, then untested models", () => {
    assert.deepEqual(
        fallbackOrder(
            "parakeet-en",
            ["moonshine-tiny", "whisper-tiny", "parakeet-en"],
            [result("moonshine-tiny", 0.2), result("whisper-tiny", 0.4)],
            new Set(["parakeet-en"]),
        ),
        ["moonshine-tiny", "whisper-tiny"],
    );
});

test("cache parser rejects malformed data and validation covers hardware, files, engine and staleness", () => {
    const cache: SelectionCache = {
        schemaVersion: 1,
        hardwareFingerprint: "hardware-a",
        hardwareTier: "mid",
        engineVersion: ENGINE_VERSION,
        modelFingerprints: { "moonshine-tiny": "model-a" },
        selectedModelId: "moonshine-tiny",
        overrideModelId: null,
        reason: "measured",
        benchmarks: [result("moonshine-tiny", 0.2)],
        needsBenchmark: false,
        updatedAt: new Date(0).toISOString(),
    };
    assert.deepEqual(parseSelectionCache(JSON.stringify(cache)), cache);
    assert.equal(parseSelectionCache("{nope"), null);
    assert.equal(
        isSelectionCacheValid(
            cache,
            "hardware-a",
            { "moonshine-tiny": "model-a" },
            "mid",
        ),
        true,
    );
    assert.equal(
        isSelectionCacheValid(
            cache,
            "hardware-b",
            { "moonshine-tiny": "model-a" },
            "mid",
        ),
        false,
    );
    assert.equal(
        isSelectionCacheValid(
            cache,
            "hardware-a",
            { "moonshine-tiny": "model-b" },
            "mid",
        ),
        false,
    );
    assert.equal(
        isSelectionCacheValid(
            { ...cache, engineVersion: "old" },
            "hardware-a",
            {},
            "mid",
        ),
        false,
    );
    assert.equal(
        isSelectionCacheValid(
            cache,
            "hardware-a",
            { "moonshine-tiny": "model-a" },
            "low",
        ),
        false,
    );
    assert.equal(
        isSelectionCacheValid(
            { ...cache, needsBenchmark: true },
            "hardware-a",
            {
                "moonshine-tiny": "model-a",
            },
            "mid",
        ),
        false,
    );
});
