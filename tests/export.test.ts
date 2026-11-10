import { test } from "node:test";
import assert from "node:assert/strict";
import { exportReport } from "../src/main/voice/BenchmarkService";
import { DEFAULT_VAD, type BenchmarkReport } from "../src/shared/voice";

const report: BenchmarkReport = {
    schemaVersion: 1,
    createdAt: "2026-11-08",
    sampleSha256: "test-only",
    sampleRate: 16000,
    duration: 1,
    vad: DEFAULT_VAD,
    runtime: { platform: "win32", arch: "x64", sherpa: "2.0.1", threads: 2 },
    rows: [
        {
            modelId: "moonshine-tiny",
            modelName: "Test fixture",
            loadMs: 1,
            processingMs: 2,
            realTimeFactor: 0.002,
            raw: "um hello",
            cleaned: "hello",
            fillers: [{ word: "um", count: 1 }],
            segments: [],
        },
    ],
};
test("exports derived reference scores and metadata without audio", () => {
    const output = JSON.parse(exportReport(report, "um hello", "json"));
    assert.equal(output.rows[0].wordErrorRate, 0);
    assert.equal(output.rows[0].fillerRetention, 1);
    assert.equal("audio" in output, false);
    assert.equal("sample" in output, false);
});
test("CSV quotes text, escapes quotes, preserves lines, and neutralizes formulas", () => {
    const csv = exportReport(report, '=1,"hello"\nworld', "csv");
    assert.ok(csv.includes('"\'=1,""hello""\nworld"'));
    assert.equal(csv.split("\r\n").length, 2);
});
test("failed model rows export unavailable measurements and scores", () => {
    const failed: BenchmarkReport = {
        ...report,
        rows: [
            {
                ...report.rows[0],
                error: "Test failure",
                processingMs: null,
                loadMs: null,
                realTimeFactor: null,
            },
        ],
    };
    const row = JSON.parse(exportReport(failed, "um hello", "json")).rows[0];
    assert.equal(row.wordErrorRate, null);
    assert.equal(row.fillerRetention, null);
    assert.equal(row.processingMs, null);
});
