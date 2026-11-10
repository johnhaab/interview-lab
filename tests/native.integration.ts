import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { VoiceService } from "../src/main/voice/VoiceService";
import { MODELS } from "../src/main/voice/models";
import { DEFAULT_VAD, SAMPLE_RATE, type VoiceEvent } from "../src/shared/voice";

// Run with VOICE_FIXTURES set to the directory containing official extracted
// archives, silero_vad.onnx and Obama.wav. Never uses a user's microphone.
const fixtureRoot = process.env.VOICE_FIXTURES;
test(
    "real native models: segment while capturing, flush, benchmark identical PCM, release and cancel",
    { skip: !fixtureRoot, timeout: 180_000 },
    async () => {
        const root = resolve(fixtureRoot!);
        const modelRoot = join(root, "installed");
        await mkdir(modelRoot, { recursive: true });
        for (const model of MODELS) {
            await mkdir(join(modelRoot, model.id), { recursive: true });
            for (const file of model.files) {
                await copyFile(
                    join(root, model.archive, file.name),
                    join(modelRoot, model.id, file.name),
                );
            }
        }
        await copyFile(
            join(root, "silero_vad.onnx"),
            join(modelRoot, "silero_vad.onnx"),
        );
        const native = require("sherpa-onnx-node") as {
            readWave(path: string): {
                samples: Float32Array;
                sampleRate: number;
            };
        };
        const wave = native.readWave(join(root, "Obama.wav"));
        assert.equal(wave.sampleRate, SAMPLE_RATE);
        // Include trailing silence and a non-window-aligned tail to exercise VAD drain.
        const sample = new Float32Array(SAMPLE_RATE * 13 + 137);
        sample.set(wave.samples.subarray(0, SAMPLE_RATE * 12));
        const sampleHash = createHash("sha256")
            .update(new Uint8Array(sample.buffer))
            .digest("hex");
        const events: VoiceEvent[] = [];
        const service = new VoiceService(modelRoot, (event) =>
            events.push(event),
        );
        try {
            assert.equal(
                (await service.models.list()).filter((m) => m.installed).length,
                3,
            );
            await assert.rejects(
                service.start(DEFAULT_VAD, false),
                /Load a model/,
            );
            await service.load("moonshine-tiny");
            await service.start(DEFAULT_VAD, true);
            await assert.rejects(
                service.audio(new Float32Array([NaN])),
                /Invalid PCM/,
            );
            for (let i = 0; i < sample.length; i += 2048) {
                await service.audio(sample.slice(i, i + 2048));
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
            assert.ok(
                events.some((event) => event.type === "segment"),
                "segments arrive before capture stops",
            );
            const capture = await service.stop();
            assert.equal(capture.duration, sample.length / SAMPLE_RATE);
            assert.ok(capture.segments.length);
            console.log(
                "Live capture:",
                capture.segments.map((s) => s.raw).join(" "),
            );
            assert.ok(capture.segments.map((s) => s.raw).join(" ").length > 10);
            assert.ok(
                capture.segments
                    .map((s) => s.raw)
                    .join(" ")
                    .toLowerCase()
                    .includes("everybody"),
            );
            assert.ok(
                capture.segments.every(
                    (s) => s.processingMs > 0 && s.latencyMs >= s.processingMs,
                ),
            );
            assert.ok(capture.segments.at(-1)!.end <= capture.duration);
            const report = await service.benchmark();
            assert.equal(report.sampleSha256, sampleHash);
            assert.equal(report.rows.length, 3);
            for (const row of report.rows) {
                assert.equal(
                    row.error,
                    undefined,
                    `${row.modelName}: ${row.error}`,
                );
                assert.ok(row.raw.length > 10, row.modelName);
                assert.ok(
                    row.processingMs !== null &&
                        row.loadMs !== null &&
                        row.processingMs > 0 &&
                        row.loadMs > 0,
                );
                console.log(
                    JSON.stringify({
                        model: row.modelName,
                        transcript: row.raw,
                        processingMs: row.processingMs,
                        loadMs: row.loadMs,
                        rtf: row.realTimeFactor,
                    }),
                );
            }
            await assert.rejects(
                service.benchmark(),
                /Capture a benchmark sample/,
            );
            assert.equal(events.filter((e) => e.type === "error").length, 0);
            await service.load("whisper-tiny");
            await service.start(DEFAULT_VAD, false);
            await service.audio(new Float32Array(2048));
            const silence = await service.stop();
            assert.deepEqual(silence.segments, []);
            assert.deepEqual(silence.pauses, []);
            await service.start(DEFAULT_VAD, false);
            await service.audio(new Float32Array(2048));
            await service.cancel();
            await assert.rejects(service.stop(), /Recording is not active/);
        } finally {
            await service.cancel();
            sample.fill(0);
        }
    },
);

test(
    "official download verifies the archive and required files without installing sample recordings",
    {
        skip: !fixtureRoot || !process.env.VOICE_TEST_DOWNLOAD,
        timeout: 180_000,
    },
    async () => {
        const service = new VoiceService(
            join(resolve(fixtureRoot!), "download-smoke"),
            () => undefined,
        );
        try {
            await service.download("moonshine-tiny");
            await service.models.validate("moonshine-tiny");
            const { readdir } = await import("node:fs/promises");
            const files = await readdir(
                service.models.directory("moonshine-tiny"),
                { recursive: true },
            );
            assert.ok(!files.some((file) => file.endsWith(".wav")));
            assert.ok(
                (await service.models.list()).find(
                    (m) => m.id === "moonshine-tiny",
                )!.installed,
            );
        } finally {
            await service.cancel();
        }
    },
);
