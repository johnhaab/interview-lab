# Local voice service

Interview Lab runs speech recognition entirely on the local machine. Audio is captured through an AudioWorklet, segmented with Silero VAD, and transcribed by sherpa-onnx in a worker thread so native inference does not block Electron's main process.

The voice playground is enabled automatically during development. Production builds hide it unless `VITE_ENABLE_VOICE_PLAYGROUND=true` is set at build time. The voice service itself is independent of the playground.

## Architecture

- `VoiceService` owns recording, model, benchmark, and cancellation lifecycle.
- `ModelManager` downloads models, verifies checksums, and manages installed files.
- `SherpaTranscriber` creates the model-specific sherpa-onnx recognizer.
- `SpeechDetector` handles Silero VAD, segmentation, and pause measurements.
- `InferenceWorker` keeps VAD and native inference outside the main thread.
- `TranscriptProcessor` preserves verbatim output and produces cleaned text.
- `BenchmarkService` runs identical PCM through installed models and calculates timing and accuracy metrics.
- `ModelSelection` detects local hardware, caches benchmark results, and selects a suitable installed model.

The preload exposes a small typed API. Main-process handlers validate the sender, model IDs, VAD settings, PCM packets, and export requests. Recording is cancelled when the renderer closes, navigates away, or crashes.

## Models

| Model | License | Approximate download |
| --- | --- | ---: |
| Moonshine Tiny English, int8 | MIT, Useful Sensors | 108 MB |
| Whisper Tiny English, int8 | MIT, OpenAI | 118 MB |
| Parakeet TDT 0.6B v2 English, int8 | CC BY 4.0, NVIDIA | 482 MB |
| Silero VAD | MIT, Silero Team | 0.6 MB |

Models come from the official sherpa-onnx releases. Archive and extracted-file SHA-256 values are pinned in `models.ts`. Downloads are staged in a temporary directory and installed only after verification. Model files live under Electron's `userData/voice-models` directory and remain outside ASAR.

All three recognizers are offline models and currently report completed VAD segments rather than native partial transcripts. Adding another compatible model only requires a pinned model definition and sherpa configuration.

## Automatic selection

Automatic selection uses hardware information as an initial suitability check, then relies on measured real-time factor (RTF):

- Below `0.3` RTF is excellent.
- `0.3` through `0.7` RTF is acceptable.
- Above `0.7` RTF favors the fastest measured fallback.

Only installed models are benchmarked, and nothing is downloaded automatically. Load or inference failures fall back to another installed model.

The selected model, hardware fingerprint, engine version, installed-file fingerprints, and benchmark results are cached in the existing `app_kv` table. No database migration is required. Manual overrides remain active until automatic selection is restored.

## Audio and metrics

Microphone audio stays in memory and is never written to disk or stored in SQLite. Normal recording retains only the buffers needed by VAD and pending transcription. Benchmark mode may retain one complete sample for comparison, limited to 120 seconds; it is zeroed after comparison, cancellation, reset, or replacement.

Pause measurements come from gaps between VAD speech segments. Filler counts come from lexical matches in model output; VAD is not used as a filler detector. Original model text remains separate from cleaned text.

Benchmark exports include transcripts, timing, RTF, WER, filler retention, model metadata, VAD settings, and a hash of the sample. Audio is excluded from JSON and CSV exports.

## Development

```powershell
npm.cmd run dev
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Native integration tests use local official model fixtures:

```powershell
$env:VOICE_FIXTURES="C:\path\to\fixtures"
npm.cmd run test:voice
```

The Electron smoke test uses Chromium's fake microphone and the same fixture audio. Windows is the verified packaging target. Native sherpa binaries are unpacked from ASAR by the electron-builder configuration.

The bundled automatic-selection sample is an official sherpa-onnx LibriSpeech fixture. Source, license, transcript, and checksum information are recorded in `resources/VOICE_BENCHMARK_NOTICE.md`.
