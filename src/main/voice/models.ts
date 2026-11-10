import type { ModelId } from "../../shared/voice";

export interface ModelFile {
    name: string;
    sha256: string;
}

export interface ModelDefinition {
    id: ModelId;
    name: string;
    license: string;
    kind: "moonshine" | "whisper" | "transducer";
    archive: string;
    sha256: string;
    downloadMB: number;
    accuracyRank: number;
    minimumAvailableMemoryMB: number;
    config: Record<string, string>;
    files: ModelFile[];
}

// Official release archives. SHA-256 checked against downloaded bytes; Parakeet also matches GitHub's asset digest.
export const MODELS: ModelDefinition[] = [
    {
        id: "moonshine-tiny",
        name: "Moonshine Tiny English (int8)",
        license: "MIT · Useful Sensors",
        kind: "moonshine",
        archive: "sherpa-onnx-moonshine-tiny-en-int8",
        sha256: "d5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2",
        downloadMB: 108,
        accuracyRank: 1,
        minimumAvailableMemoryMB: 512,
        config: {
            tokens: "tokens.txt",
            preprocessor: "preprocess.onnx",
            encoder: "encode.int8.onnx",
            uncachedDecoder: "uncached_decode.int8.onnx",
            cachedDecoder: "cached_decode.int8.onnx",
        },
        files: [
            {
                name: "tokens.txt",
                sha256: "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea",
            },
            {
                name: "preprocess.onnx",
                sha256: "f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e",
            },
            {
                name: "encode.int8.onnx",
                sha256: "8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb",
            },
            {
                name: "uncached_decode.int8.onnx",
                sha256: "216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41",
            },
            {
                name: "cached_decode.int8.onnx",
                sha256: "2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6",
            },
            {
                name: "LICENSE",
                sha256: "29f60769d1779eb7e196d96b8d2dd471d0263cf8200c79e55c0c00183971ee1b",
            },
            {
                name: "README.md",
                sha256: "47c3767ed840f4176000cd6b8bab82c6c5e0acfc1c702d93cdefe85ee48d7d89",
            },
        ],
    },
    {
        id: "whisper-tiny",
        name: "Whisper Tiny English (int8)",
        license: "MIT · OpenAI",
        kind: "whisper",
        archive: "sherpa-onnx-whisper-tiny.en",
        sha256: "2bd6cf965c8bb3e068ef9fa2191387ee63a9dfa2a4e37582a8109641c20005dd",
        downloadMB: 118,
        accuracyRank: 2,
        minimumAvailableMemoryMB: 768,
        config: {
            tokens: "tiny.en-tokens.txt",
            encoder: "tiny.en-encoder.int8.onnx",
            decoder: "tiny.en-decoder.int8.onnx",
        },
        files: [
            {
                name: "tiny.en-tokens.txt",
                sha256: "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930",
            },
            {
                name: "tiny.en-encoder.int8.onnx",
                sha256: "0ce578b827c94a961aacb8fa14b02f096504b337e5c94be37c36238cbe3e8bc6",
            },
            {
                name: "tiny.en-decoder.int8.onnx",
                sha256: "06c0e6ff6348d427e51839219d1c886c18cfdf411e629e33f5e1679bff9c1527",
            },
        ],
    },
    {
        id: "parakeet-en",
        name: "Parakeet TDT 0.6B v2 English (int8)",
        license: "CC-BY-4.0 · NVIDIA; ONNX export by sherpa-onnx",
        kind: "transducer",
        archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        sha256: "6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714",
        downloadMB: 482,
        accuracyRank: 3,
        minimumAvailableMemoryMB: 2048,
        config: {
            tokens: "tokens.txt",
            encoder: "encoder.int8.onnx",
            decoder: "decoder.int8.onnx",
            joiner: "joiner.int8.onnx",
        },
        files: [
            {
                name: "tokens.txt",
                sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
            },
            {
                name: "encoder.int8.onnx",
                sha256: "92a10bd9c23936ea0566c29f963bc57c2a5df4261b6a8921c39abea66557ca8b",
            },
            {
                name: "decoder.int8.onnx",
                sha256: "4d097bae3bac5c96018d5293ba39f1b657296102b142affda40378f38b020f41",
            },
            {
                name: "joiner.int8.onnx",
                sha256: "77a29f3e5ac7d37074e0af465391b80f314015d5b97f0f90c6c7767f1d56f428",
            },
            {
                name: "README.md",
                sha256: "4843729c2dda1634a44fbca7be2d01dc69c4c1ccc7cbd76d9c72435a236cb513",
            },
        ],
    },
];

export const VAD_SHA256 =
    "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";
