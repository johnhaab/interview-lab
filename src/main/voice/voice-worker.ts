import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";
import { processTranscript } from "../../shared/TranscriptProcessor";
import {
    MAX_CAPTURE_SECONDS,
    SAMPLE_RATE,
    type Segment,
} from "../../shared/voice";
import { SherpaTranscriber } from "./SherpaTranscriber";
import { SpeechDetector } from "./SpeechDetector";
import type {
    AudioWorkerCommand,
    StartWorkerCommand,
    StopWorkerCommand,
    WorkerCommand,
    WorkerMessage,
    WorkerResult,
} from "./protocol";

if (parentPort == null) {
    throw new Error("Voice inference requires a worker");
}

const port = parentPort;
let transcriber: SherpaTranscriber | undefined;
let detector: SpeechDetector | undefined;
let segments: Segment[] = [];
let retainedAudio: Float32Array[] = [];
let retainAudio = false;
let totalSamples = 0;
let transcriptionQueue = Promise.resolve();
let transcriptionFailure: Error | undefined;

interface SpeechSegment {
    start: number;
    samples: Float32Array;
}

interface QueuedSpeechSegment extends SpeechSegment {
    readyAt: number;
}

function send(message: WorkerMessage): void {
    port.postMessage(message);
}

function sendReply(id: number): void {
    send({ type: "reply", id });
}

function sendError(id: number, error: unknown): void {
    send({ type: "reply", id, error: errorMessage(error) });
}

async function transcribeSegment(item: QueuedSpeechSegment): Promise<void> {
    if (transcriptionFailure != null) {
        item.samples.fill(0);
        return;
    }
    if (transcriber == null) {
        item.samples.fill(0);
        throw new Error("Load a model first");
    }

    const startedAt = performance.now();
    try {
        const result = await transcriber.transcribe(item.samples);
        const segment: Segment = {
            start: item.start / SAMPLE_RATE,
            end:
                Math.min(totalSamples, item.start + item.samples.length) /
                SAMPLE_RATE,
            ...processTranscript(result.text),
            result,
            processingMs: performance.now() - startedAt,
            latencyMs: performance.now() - item.readyAt,
        };
        segments.push(segment);
        send({ type: "event", event: { type: "segment", segment } });
    } finally {
        item.samples.fill(0);
    }
}

function handleTranscriptionFailure(error: unknown): void {
    transcriptionFailure = toError(error);
    send({
        type: "event",
        event: { type: "error", message: transcriptionFailure.message },
    });
}

function enqueue(items: SpeechSegment[]): void {
    for (const item of items) {
        const queuedItem: QueuedSpeechSegment = {
            ...item,
            readyAt: performance.now(),
        };
        transcriptionQueue = transcriptionQueue
            .then(() => transcribeSegment(queuedItem))
            .catch(handleTranscriptionFailure);
    }
}

function startCapture(command: StartWorkerCommand): void {
    if (transcriber == null) {
        throw new Error("Load a model first");
    }
    releaseRetainedAudio();
    detector = new SpeechDetector(command.vadPath, command.settings);
    segments = [];
    totalSamples = 0;
    retainAudio = command.retain;
    transcriptionFailure = undefined;
    transcriptionQueue = Promise.resolve();
}

function releaseRetainedAudio(): void {
    for (const chunk of retainedAudio) {
        chunk.fill(0);
    }
    retainedAudio = [];
}

function acceptAudio(command: AudioWorkerCommand): void {
    if (detector == null) {
        throw new Error("Recording is not active");
    }

    totalSamples += command.samples.length;
    if (totalSamples > MAX_CAPTURE_SECONDS * SAMPLE_RATE) {
        throw new Error("Capture exceeds 120 seconds");
    }
    if (retainAudio) {
        retainedAudio.push(command.samples.slice());
    }

    enqueue(detector.accept(command.samples));
    command.samples.fill(0);
    send({
        type: "event",
        event: {
            type: "activity",
            speaking: detector.speaking,
            pauses: detector.pauses,
        },
    });
}

function combineRetainedAudio(): Float32Array | undefined {
    if (!retainAudio) {
        return undefined;
    }

    const sample = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of retainedAudio) {
        sample.set(chunk, offset);
        offset += chunk.length;
        chunk.fill(0);
    }
    return sample;
}

async function stopCapture(command: StopWorkerCommand): Promise<void> {
    if (detector == null) {
        throw new Error("Recording is not active");
    }

    enqueue(detector.flush());
    const pauses = detector.pauses;
    detector = undefined;
    await transcriptionQueue;
    if (transcriptionFailure != null) {
        releaseRetainedAudio();
        throw transcriptionFailure;
    }

    const sample = combineRetainedAudio();
    retainedAudio = [];
    const value: WorkerResult = {
        result: {
            segments,
            pauses,
            duration: totalSamples / SAMPLE_RATE,
            processingMs: segments.reduce(
                (total, segment) => total + segment.processingMs,
                0,
            ),
        },
        sample,
    };
    const message: WorkerMessage = { type: "reply", id: command.id, value };
    if (sample != null) {
        port.postMessage(message, [sample.buffer as ArrayBuffer]);
        return;
    }
    port.postMessage(message);
}

async function handleCommand(command: WorkerCommand): Promise<void> {
    switch (command.type) {
        case "load":
            transcriber = new SherpaTranscriber(
                command.modelId,
                command.directory,
            );
            sendReply(command.id);
            return;
        case "start":
            startCapture(command);
            sendReply(command.id);
            return;
        case "audio":
            acceptAudio(command);
            sendReply(command.id);
            return;
        case "stop":
            await stopCapture(command);
            return;
    }
}

port.on("message", (command: WorkerCommand) => {
    void handleCommand(command).catch((error: unknown) => {
        sendError(command.id, error);
    });
});

function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    return new Error(String(error));
}

function errorMessage(error: unknown): string {
    return toError(error).message;
}
