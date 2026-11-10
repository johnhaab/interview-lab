import { readFile } from "node:fs/promises";

export const BENCHMARK_REFERENCE =
    "after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels";

export async function readBenchmarkWave(path: string): Promise<Float32Array> {
    const wave = await readFile(path);
    if (
        wave.toString("ascii", 0, 4) !== "RIFF" ||
        wave.toString("ascii", 8, 12) !== "WAVE"
    ) {
        throw new Error("Invalid benchmark WAV");
    }
    let offset = 12;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let audioFormat = 0;
    let data: Buffer | undefined;
    while (offset + 8 <= wave.length) {
        const id = wave.toString("ascii", offset, offset + 4);
        const size = wave.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = start + size;
        if (end > wave.length) {
            throw new Error("Truncated benchmark WAV");
        }
        if (id === "fmt ") {
            if (size < 16) {
                throw new Error("Invalid benchmark WAV format");
            }
            audioFormat = wave.readUInt16LE(start);
            channels = wave.readUInt16LE(start + 2);
            sampleRate = wave.readUInt32LE(start + 4);
            bitsPerSample = wave.readUInt16LE(start + 14);
        } else if (id === "data") {
            data = wave.subarray(start, end);
        }
        offset = end + (size % 2);
    }
    if (
        audioFormat !== 1 ||
        channels !== 1 ||
        sampleRate !== 16000 ||
        bitsPerSample !== 16 ||
        !data
    ) {
        throw new Error("Benchmark WAV must be mono 16 kHz PCM16");
    }
    const samples = new Float32Array(data.length / 2);
    for (let index = 0; index < samples.length; index++) {
        samples[index] = data.readInt16LE(index * 2) / 32768;
    }
    return samples;
}
