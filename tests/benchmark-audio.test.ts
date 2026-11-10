import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BENCHMARK_REFERENCE,
    readBenchmarkWave,
} from "../src/main/voice/BenchmarkAudio";
import { SAMPLE_RATE } from "../src/shared/voice";

const fixture = join(process.cwd(), "resources", "voice-benchmark.wav");

test("bundled benchmark fixture is pinned mono 16 kHz speech", async () => {
    const bytes = await readFile(fixture);
    assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        "6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f",
    );
    const samples = await readBenchmarkWave(fixture);
    assert.equal(samples.length, 106000);
    assert.equal(samples.length / SAMPLE_RATE, 6.625);
    assert.ok(samples.some((sample) => Math.abs(sample) > 0.01));
    assert.match(BENCHMARK_REFERENCE, /early nightfall/);
    samples.fill(0);
});
