import { useCallback, useEffect, useRef, useState } from "react";
import {
    IconActivity,
    IconAlertCircle,
    IconArrowDown,
    IconCheck,
    IconChevronRight,
    IconClockPause,
    IconCpu,
    IconDownload,
    IconFileText,
    IconFlask,
    IconGauge,
    IconLoader2,
    IconMicrophone,
    IconRefresh,
} from "@tabler/icons-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
    fillerRetention,
    processTranscript,
    wordErrorRate,
} from "../../shared/TranscriptProcessor";
import {
    DEFAULT_VAD,
    type BenchmarkReport,
    type ModelId,
    type ModelInfo,
    type ModelSelectionStatus,
    type Pause,
    type Segment,
    type VadSettings,
    type VoiceResourceStats,
} from "../../shared/voice";
import { MicrophoneCapture } from "./voice/MicrophoneCapture";

type Phase =
    | "idle"
    | "loading"
    | "starting"
    | "recording"
    | "stopping"
    | "benchmarking"
    | "downloading";

function ms(value: number | null): string {
    if (value == null) {
        return "—";
    }
    return `${Math.round(value)} ms`;
}

function percent(value: number | null): string {
    if (value == null) {
        return "—";
    }
    return `${(value * 100).toFixed(1)}%`;
}

function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function memory(bytes: number): string {
    if (bytes >= 1024 ** 3) {
        return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    }
    return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function recordingStatus(phase: Phase, speaking: boolean): string {
    if (phase !== "recording") {
        return "Idle";
    }
    if (speaking) {
        return "Speech detected";
    }
    return "Listening";
}

function talkButtonLabel(phase: Phase): string {
    if (phase === "starting") {
        return "Opening microphone…";
    }
    if (phase === "recording") {
        return "Release to finish";
    }
    if (phase === "stopping") {
        return "Finishing…";
    }
    return "Hold to talk";
}

interface VadControl {
    key: keyof VadSettings;
    label: string;
    description: string;
    minimum: number;
    maximum: number;
    step: number;
    unit: string;
}

const vadControls: VadControl[] = [
    {
        key: "threshold",
        label: "Speech threshold",
        description: "How confident Silero must be before speech starts.",
        minimum: 0.05,
        maximum: 0.95,
        step: 0.05,
        unit: "",
    },
    {
        key: "minSilenceDuration",
        label: "Pause threshold",
        description: "Silence required to close a segment.",
        minimum: 0.1,
        maximum: 2,
        step: 0.1,
        unit: " s",
    },
    {
        key: "minSpeechDuration",
        label: "Minimum speech",
        description: "Reject speech events shorter than this.",
        minimum: 0.05,
        maximum: 1,
        step: 0.05,
        unit: " s",
    },
    {
        key: "maxSpeechDuration",
        label: "Maximum segment",
        description: "Split long speech at this duration.",
        minimum: 3,
        maximum: 30,
        step: 1,
        unit: " s",
    },
];

const voicePlaygroundEnabled =
    import.meta.env.DEV ||
    import.meta.env.VITE_ENABLE_VOICE_PLAYGROUND === "true";

export default function App(): React.JSX.Element {
    const [screen, setScreen] = useState<"home" | "voice">("home");

    if (screen === "voice" && voicePlaygroundEnabled) {
        return <VoicePlayground />;
    }

    return (
        <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
            <div className="text-center">
                <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                    HELLO WORLD
                </h1>
                {voicePlaygroundEnabled && (
                    <Button className="mt-6" onClick={() => setScreen("voice")}>
                        <IconMicrophone /> Voice playground
                    </Button>
                )}
            </div>
        </main>
    );
}

function VoicePlayground(): React.JSX.Element {
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [selected, setSelected] = useState<ModelId>("moonshine-tiny");
    const [loaded, setLoaded] = useState<ModelId | null>(null);
    const [selectionInfo, setSelectionInfo] =
        useState<ModelSelectionStatus | null>(null);
    const [resourceStats, setResourceStats] =
        useState<VoiceResourceStats | null>(null);
    const [peakVoiceCpu, setPeakVoiceCpu] = useState(0);
    const [phase, setPhase] = useState<Phase>("loading");
    const [status, setStatus] = useState("Checking local models…");
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [error, setError] = useState("");
    const [segments, setSegments] = useState<Segment[]>([]);
    const [pauses, setPauses] = useState<Pause[]>([]);
    const [speaking, setSpeaking] = useState(false);
    const [rms, setRms] = useState(0);
    const [vad, setVad] = useState<VadSettings>(DEFAULT_VAD);
    const [benchmarkMode, setBenchmarkMode] = useState(false);
    const [hasSample, setHasSample] = useState(false);
    const [report, setReport] = useState<BenchmarkReport | null>(null);
    const [reference, setReference] = useState("");
    const [duration, setDuration] = useState(0);
    const recorder = useRef<MicrophoneCapture | null>(null);
    const holding = useRef(false);
    const stopping = useRef(false);
    const operation = useRef(0);
    const bootstrapped = useRef(false);
    const phaseRef = useRef(phase);
    phaseRef.current = phase;

    const busy = phase !== "idle";
    const selectedModel = models.find((model) => model.id === selected);
    const transcript = processTranscript(
        segments.map((segment) => segment.raw).join(" "),
    );
    const processingMs = segments.reduce(
        (total, segment) => total + segment.processingMs,
        0,
    );
    const pauseDuration = pauses.reduce(
        (total, pause) => total + pause.duration,
        0,
    );
    const fillerCount = transcript.fillers.reduce(
        (total, filler) => total + filler.count,
        0,
    );

    const refresh = useCallback(async (): Promise<ModelInfo[]> => {
        const catalog = await window.api.voice.models();
        setModels(catalog);
        return catalog;
    }, []);

    const applySelection = useCallback(
        (selection: ModelSelectionStatus): void => {
            setSelectionInfo(selection);
            setLoaded(selection.loadedModelId);
            if (selection.selectedModelId != null) {
                setSelected(selection.selectedModelId);
            }
            setStatus(selection.reason);
        },
        [],
    );

    useEffect(() => {
        const unsubscribe = window.api.voice.onEvent((event) => {
            switch (event.type) {
                case "segment":
                    setSegments((previous) => [...previous, event.segment]);
                    return;
                case "activity":
                    setSpeaking(event.speaking);
                    setPauses(event.pauses);
                    return;
                case "download": {
                    const progress = Math.round(event.progress * 100);
                    setDownloadProgress(progress);
                    if (event.stage.startsWith("Downloading")) {
                        setStatus(`${event.stage} · ${progress}%`);
                    } else if (event.stage === "Installed and verified") {
                        setStatus(event.stage);
                    } else {
                        setStatus(`${event.stage}…`);
                    }
                    return;
                }
                case "benchmark-progress":
                    setStatus(`Benchmarking ${event.modelId}…`);
                    return;
                case "selection":
                    applySelection(event.status);
                    return;
                case "error": {
                    setError(event.message);
                    setLoaded(null);
                    const current = recorder.current;
                    if (current == null) {
                        return;
                    }
                    operation.current += 1;
                    holding.current = false;
                    recorder.current = null;
                    void current.cancel().finally(() => {
                        setPhase("idle");
                        setRms(0);
                        setSpeaking(false);
                        setHasSample(false);
                    });
                    return;
                }
            }
        });
        return () => {
            unsubscribe();
            void recorder.current?.cancel();
        };
    }, [applySelection]);

    useEffect(() => {
        let active = true;
        let pending = false;
        const sample = async (): Promise<void> => {
            if (pending) {
                return;
            }
            pending = true;
            try {
                const resources = await window.api.voice.resources();
                if (active) {
                    setResourceStats(resources);
                    setPeakVoiceCpu((previous) =>
                        Math.max(previous, resources.voiceCpuPercent),
                    );
                }
            } catch {
                if (active) {
                    setResourceStats(null);
                }
            } finally {
                pending = false;
            }
        };
        void sample();
        const timer = window.setInterval(() => void sample(), 250);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, []);

    useEffect(() => setPeakVoiceCpu(0), [loaded]);

    useEffect(() => {
        if (bootstrapped.current) {
            return;
        }
        bootstrapped.current = true;
        void (async () => {
            try {
                const [catalog, selection] = await Promise.all([
                    refresh(),
                    window.api.voice.selection(),
                ]);
                applySelection(selection);
                if (selection.selectedModelId == null && catalog[0] != null) {
                    setSelected(catalog[0].id);
                }
                if (catalog.length === 0) {
                    setStatus("No voice models are configured");
                }
            } catch (reason) {
                setError(errorText(reason));
                setStatus("Could not initialize the voice model");
            } finally {
                setPhase("idle");
            }
        })();
    }, [applySelection, refresh]);

    const stop = useCallback(async () => {
        holding.current = false;
        if (recorder.current == null || stopping.current) {
            return;
        }
        stopping.current = true;
        setPhase("stopping");
        setStatus("Flushing remaining audio…");
        const current = recorder.current;
        const token = operation.current;
        try {
            const result = await current.stop();
            if (operation.current !== token) {
                return;
            }
            if (result) {
                setSegments(result.segments);
                setPauses(result.pauses);
                setDuration(result.duration);
                setHasSample(benchmarkMode && result.duration > 0);
                setStatus(
                    benchmarkMode
                        ? "Benchmark sample ready in memory"
                        : "Ready for another recording",
                );
            } else {
                setStatus("Ready");
            }
        } catch (reason) {
            if (operation.current === token) {
                setError(errorText(reason));
                setLoaded(null);
                setHasSample(false);
            }
        } finally {
            if (operation.current === token) {
                recorder.current = null;
                setSpeaking(false);
                setRms(0);
                setPhase("idle");
            }
            stopping.current = false;
        }
    }, [benchmarkMode]);

    const start = (): void => {
        if (
            holding.current ||
            phaseRef.current !== "idle" ||
            loaded !== selected
        )
            return;
        holding.current = true;
        setPhase("starting");
        setError("");
        setSegments([]);
        setPauses([]);
        setDuration(0);
        setHasSample(false);
        setReport(null);
        setStatus("Opening microphone…");
        const current = new MicrophoneCapture(
            setRms,
            () => void stop(),
            (reason) => {
                setError(reason.message);
                void stop();
            },
        );
        const token = ++operation.current;
        recorder.current = current;
        void current
            .start(vad, benchmarkMode)
            .then(() => {
                if (holding.current && operation.current === token) {
                    setPhase("recording");
                    setStatus("Listening — release to finish");
                }
            })
            .catch((reason) => {
                if (operation.current === token) {
                    setError(errorText(reason));
                    holding.current = false;
                    recorder.current = null;
                    setLoaded(null);
                    setPhase("idle");
                }
            });
    };

    useEffect(() => {
        const release = (): void => {
            if (holding.current) {
                void stop();
            }
        };
        const visibility = (): void => {
            if (document.hidden) {
                release();
            }
        };
        window.addEventListener("blur", release);
        document.addEventListener("visibilitychange", visibility);
        return () => {
            window.removeEventListener("blur", release);
            document.removeEventListener("visibilitychange", visibility);
        };
    }, [stop]);

    const load = async (): Promise<void> => {
        const token = ++operation.current;
        setPhase("loading");
        setLoaded(null);
        setError("");
        setStatus("Verifying files and loading model…");
        try {
            const selection = await window.api.voice.setModelOverride(selected);
            if (operation.current === token) {
                applySelection(selection);
            }
        } catch (reason) {
            if (operation.current === token) {
                setError(errorText(reason));
            }
        } finally {
            if (operation.current === token) {
                setPhase("idle");
            }
        }
    };

    const download = async (): Promise<void> => {
        const token = ++operation.current;
        setPhase("downloading");
        setLoaded(null);
        setDownloadProgress(0);
        setError("");
        try {
            await window.api.voice.download(selected);
            await refresh();
            const selection = await window.api.voice.selection();
            if (operation.current === token) {
                applySelection(selection);
            }
        } catch (reason) {
            if (operation.current === token) {
                setError(errorText(reason));
            }
        } finally {
            if (operation.current === token) {
                setPhase("idle");
            }
        }
    };

    const benchmark = async (): Promise<void> => {
        const token = ++operation.current;
        setPhase("benchmarking");
        setLoaded(null);
        setError("");
        setReport(null);
        try {
            const result = await window.api.voice.benchmark();
            if (operation.current === token) {
                setReport(result);
                const selection = await window.api.voice.selection();
                if (operation.current === token) {
                    applySelection(selection);
                }
            }
        } catch (reason) {
            if (operation.current === token) {
                setError(errorText(reason));
            }
        } finally {
            if (operation.current === token) {
                setHasSample(false);
                setPhase("idle");
            }
        }
    };

    const rerunSelection = async (): Promise<void> => {
        const token = ++operation.current;
        setPhase("benchmarking");
        setError("");
        setStatus("Running the local hardware benchmark…");
        try {
            const selection = await window.api.voice.rerunSelectionBenchmark();
            if (operation.current === token) {
                applySelection(selection);
            }
        } catch (reason) {
            if (operation.current === token) {
                setError(errorText(reason));
            }
        } finally {
            if (operation.current === token) {
                setPhase("idle");
            }
        }
    };

    const useAutomaticSelection = async (): Promise<void> => {
        const token = ++operation.current;
        setPhase("loading");
        setError("");
        try {
            const selection = await window.api.voice.setModelOverride(null);
            if (operation.current === token) {
                applySelection(selection);
            }
        } catch (reason) {
            if (operation.current === token) {
                setError(errorText(reason));
            }
        } finally {
            if (operation.current === token) {
                setPhase("idle");
            }
        }
    };

    const exportResults = async (format: "json" | "csv"): Promise<void> => {
        try {
            if (await window.api.voice.export(format, reference)) {
                setStatus(`Exported ${format.toUpperCase()} — audio excluded`);
            }
        } catch (reason) {
            setError(errorText(reason));
        }
    };

    const selectionMode = selectionInfo?.mode ?? "automatic";
    const selectionModeLabel =
        selectionMode === "manual" ? "Manual" : "Automatic";
    const recorderStatus = recordingStatus(phase, speaking);
    const recorderActive = phase === "recording" && speaking;
    const talkLabel = talkButtonLabel(phase);
    const talkTransitioning = phase === "starting" || phase === "stopping";
    let loadIcon: React.ReactNode = <IconChevronRight />;
    if (phase === "loading") {
        loadIcon = <IconLoader2 className="animate-spin" />;
    } else if (loaded === selected) {
        loadIcon = <IconCheck />;
    }

    return (
        <div className="min-h-svh bg-background text-foreground">
            <main className="mx-auto max-w-[1600px] space-y-4 p-4 lg:p-5">
                {error && (
                    <Alert variant="destructive">
                        <IconAlertCircle />
                        <AlertTitle>Voice service error</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <aside className="space-y-4">
                        <Card>
                            <CardHeader>
                                <CardTitle>Recognition model</CardTitle>
                                <CardDescription>
                                    Selected locally for this computer.
                                </CardDescription>
                                <CardAction>
                                    <Badge
                                        variant={
                                            selectionMode === "manual"
                                                ? "outline"
                                                : "secondary"
                                        }
                                    >
                                        {selectionModeLabel}
                                    </Badge>
                                </CardAction>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {selectionInfo && (
                                    <div className="space-y-3 rounded-lg border bg-muted/40 p-3 text-xs">
                                        <div className="flex items-center gap-2">
                                            <IconCpu className="size-4 shrink-0" />
                                            <span
                                                className="min-w-0 truncate font-medium"
                                                title={
                                                    selectionInfo.hardware
                                                        .cpuModel
                                                }
                                            >
                                                {
                                                    selectionInfo.hardware
                                                        .cpuModel
                                                }
                                            </span>
                                            <Badge
                                                variant="outline"
                                                className="ml-auto capitalize"
                                            >
                                                {selectionInfo.hardware.tier}
                                            </Badge>
                                        </div>
                                        <p className="leading-5 text-muted-foreground">
                                            {
                                                selectionInfo.hardware
                                                    .logicalCores
                                            }{" "}
                                            logical cores ·{" "}
                                            {(
                                                selectionInfo.hardware
                                                    .availableMemoryBytes /
                                                1024 ** 3
                                            ).toFixed(1)}{" "}
                                            of{" "}
                                            {(
                                                selectionInfo.hardware
                                                    .totalMemoryBytes /
                                                1024 ** 3
                                            ).toFixed(1)}{" "}
                                            GB available ·{" "}
                                            {
                                                selectionInfo.hardware
                                                    .operatingSystem
                                            }{" "}
                                            {selectionInfo.hardware.release} ·{" "}
                                            {selectionInfo.hardware.arch}
                                        </p>
                                        <div
                                            className="rounded-md border bg-background p-2.5"
                                            aria-label="Live voice resource utilization"
                                        >
                                            <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 gap-y-1.5 tabular-nums">
                                                <span className="text-muted-foreground">
                                                    Live usage
                                                </span>
                                                <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                                                    Voice
                                                </span>
                                                <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                                                    System
                                                </span>
                                                <span>CPU</span>
                                                <span className="text-right font-medium">
                                                    {resourceStats
                                                        ? `${resourceStats.voiceCpuPercent.toFixed(0)}%`
                                                        : "—"}
                                                </span>
                                                <span className="text-right">
                                                    {resourceStats
                                                        ? `${resourceStats.systemCpuPercent.toFixed(0)}%`
                                                        : "—"}
                                                </span>
                                                <span>RAM</span>
                                                <span className="text-right font-medium">
                                                    {resourceStats
                                                        ? memory(
                                                              resourceStats.voiceMemoryBytes,
                                                          )
                                                        : "—"}
                                                </span>
                                                <span className="text-right">
                                                    {resourceStats
                                                        ? `${resourceStats.systemMemoryPercent.toFixed(0)}%`
                                                        : "—"}
                                                </span>
                                            </div>
                                            <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground tabular-nums">
                                                <span>
                                                    Peak CPU{" "}
                                                    {peakVoiceCpu.toFixed(0)}%
                                                </span>
                                                <span>
                                                    {resourceStats
                                                        ? `${memory(resourceStats.availableMemoryBytes)} free`
                                                        : "—"}
                                                </span>
                                            </div>
                                        </div>
                                        <Separator />
                                        <p className="leading-5 text-muted-foreground">
                                            {selectionInfo.reason}
                                        </p>
                                        {selectionInfo.benchmarks.length >
                                            0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                                {selectionInfo.benchmarks.map(
                                                    (result) => (
                                                        <Badge
                                                            key={result.modelId}
                                                            variant="outline"
                                                            className="font-mono font-normal"
                                                        >
                                                            {result.modelId}:{" "}
                                                            {result.realTimeFactor?.toFixed(
                                                                2,
                                                            ) ?? "failed"}{" "}
                                                            RTF
                                                        </Badge>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                        <div className="grid grid-cols-2 gap-2">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={busy}
                                                onClick={() =>
                                                    void rerunSelection()
                                                }
                                            >
                                                <IconRefresh /> Benchmark
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={
                                                    busy ||
                                                    selectionInfo.mode ===
                                                        "automatic"
                                                }
                                                onClick={() =>
                                                    void useAutomaticSelection()
                                                }
                                            >
                                                Automatic
                                            </Button>
                                        </div>
                                    </div>
                                )}
                                <Select
                                    value={selected}
                                    disabled={busy}
                                    onValueChange={(value) => {
                                        setSelected(value as ModelId);
                                        setLoaded(null);
                                        setError("");
                                    }}
                                >
                                    <SelectTrigger className="h-10 w-full">
                                        <SelectValue placeholder="Select a model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {models.map((model) => (
                                            <SelectItem
                                                key={model.id}
                                                value={model.id}
                                            >
                                                {model.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <div className="rounded-lg border bg-muted/40 p-3 text-xs">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-muted-foreground">
                                            Download size
                                        </span>
                                        <span className="font-medium">
                                            {selectedModel?.downloadMB ?? "—"}{" "}
                                            MB
                                        </span>
                                    </div>
                                    <Separator className="my-2.5" />
                                    <p className="leading-5 text-muted-foreground">
                                        {selectedModel?.license}
                                    </p>
                                </div>
                                {phase === "downloading" && (
                                    <div className="space-y-2">
                                        <Progress value={downloadProgress} />
                                        <p className="text-xs text-muted-foreground">
                                            {status}
                                        </p>
                                    </div>
                                )}
                                <div className="grid grid-cols-2 gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={busy || !selectedModel}
                                        onClick={() => void download()}
                                    >
                                        {phase === "downloading" ? (
                                            <IconLoader2 className="animate-spin" />
                                        ) : (
                                            <IconDownload />
                                        )}
                                        {selectedModel?.installed
                                            ? "Re-download"
                                            : "Download"}
                                    </Button>
                                    <Button
                                        disabled={
                                            busy || !selectedModel?.installed
                                        }
                                        onClick={() => void load()}
                                    >
                                        {loadIcon}
                                        {loaded === selected
                                            ? "Loaded"
                                            : "Load model"}
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Voice activity detection</CardTitle>
                                <CardDescription>
                                    Silero settings apply to the next recording.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                {vadControls.map((control) => (
                                    <div
                                        className="space-y-2.5"
                                        key={control.key}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <label
                                                    className="text-sm font-medium"
                                                    htmlFor={control.key}
                                                >
                                                    {control.label}
                                                </label>
                                                <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                                                    {control.description}
                                                </p>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className="font-mono font-normal tabular-nums"
                                            >
                                                {vad[control.key].toFixed(
                                                    control.key ===
                                                        "maxSpeechDuration"
                                                        ? 0
                                                        : 2,
                                                )}
                                                {control.unit}
                                            </Badge>
                                        </div>
                                        <Slider
                                            id={control.key}
                                            min={control.minimum}
                                            max={control.maximum}
                                            step={control.step}
                                            value={[vad[control.key]]}
                                            disabled={busy}
                                            onValueChange={(value) =>
                                                setVad((previous) => ({
                                                    ...previous,
                                                    [control.key]: value[0],
                                                }))
                                            }
                                        />
                                    </div>
                                ))}
                            </CardContent>
                            <CardFooter className="items-start gap-3 bg-muted/30">
                                <Checkbox
                                    id="benchmark-mode"
                                    checked={benchmarkMode}
                                    disabled={busy || hasSample}
                                    onCheckedChange={(checked) =>
                                        setBenchmarkMode(checked === true)
                                    }
                                />
                                <label
                                    htmlFor="benchmark-mode"
                                    className="cursor-pointer"
                                >
                                    <span className="block text-sm font-medium">
                                        Capture for benchmark
                                    </span>
                                    <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                                        Retain one sample in memory, up to 120
                                        seconds.
                                    </span>
                                </label>
                            </CardFooter>
                        </Card>
                    </aside>

                    <section className="min-w-0 space-y-4">
                        <Card>
                            <CardHeader>
                                <CardTitle>Recorder</CardTitle>
                                <CardDescription>
                                    Hold the button or Space key to record.
                                </CardDescription>
                                <CardAction>
                                    <Badge
                                        variant={
                                            recorderActive
                                                ? "default"
                                                : "outline"
                                        }
                                    >
                                        {recorderStatus}
                                    </Badge>
                                </CardAction>
                            </CardHeader>
                            <CardContent>
                                <div className="grid min-h-32 items-center gap-5 rounded-xl border bg-muted/20 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                                    <div className="min-w-0 space-y-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-xs font-medium text-muted-foreground">
                                                Microphone activity
                                            </span>
                                            <span className="text-xs tabular-nums text-muted-foreground">
                                                {Math.round(rms * 100)}%
                                            </span>
                                        </div>
                                        <div
                                            className="audio-meter justify-start"
                                            aria-label={`Microphone activity ${Math.round(rms * 100)}%`}
                                        >
                                            {Array.from(
                                                { length: 25 },
                                                (_, index) => (
                                                    <span
                                                        key={index}
                                                        style={{
                                                            height: `${5 + Math.min(1, rms * 9) * (8 + ((index * 13) % 30))}px`,
                                                        }}
                                                    />
                                                ),
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            Audio stays in memory and is never
                                            saved to disk.
                                        </p>
                                    </div>
                                    <Button
                                        size="lg"
                                        className="talk-button h-14 min-w-56 rounded-full px-7 text-base"
                                        variant={
                                            phase === "recording"
                                                ? "destructive"
                                                : "default"
                                        }
                                        disabled={
                                            loaded !== selected ||
                                            (busy &&
                                                ![
                                                    "starting",
                                                    "recording",
                                                ].includes(phase))
                                        }
                                        onPointerDown={(event) => {
                                            if (event.button !== 0) {
                                                return;
                                            }
                                            event.currentTarget.setPointerCapture(
                                                event.pointerId,
                                            );
                                            start();
                                        }}
                                        onPointerUp={() => void stop()}
                                        onPointerCancel={() => void stop()}
                                        onLostPointerCapture={() => {
                                            if (holding.current) {
                                                void stop();
                                            }
                                        }}
                                        onBlur={() => {
                                            if (holding.current) {
                                                void stop();
                                            }
                                        }}
                                        onKeyDown={(event) => {
                                            if (
                                                [" ", "Enter"].includes(
                                                    event.key,
                                                )
                                            ) {
                                                event.preventDefault();
                                                if (!event.repeat) {
                                                    start();
                                                }
                                            }
                                        }}
                                        onKeyUp={(event) => {
                                            if (
                                                [" ", "Enter"].includes(
                                                    event.key,
                                                )
                                            ) {
                                                event.preventDefault();
                                                void stop();
                                            }
                                        }}
                                        onContextMenu={(event) =>
                                            event.preventDefault()
                                        }
                                    >
                                        {talkTransitioning ? (
                                            <IconLoader2 className="animate-spin" />
                                        ) : (
                                            <IconMicrophone />
                                        )}
                                        {talkLabel}
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>

                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                            <MetricCard
                                icon={<IconClockPause />}
                                label="Pauses"
                                value={String(pauses.length)}
                                detail={`${pauseDuration.toFixed(2)} s total`}
                            />
                            <MetricCard
                                icon={<IconFileText />}
                                label="Fillers retained"
                                value={String(fillerCount)}
                                detail={
                                    transcript.fillers
                                        .map(
                                            (filler) =>
                                                `${filler.word} ×${filler.count}`,
                                        )
                                        .join(", ") || "None in model output"
                                }
                            />
                            <MetricCard
                                icon={<IconActivity />}
                                label="Latest latency"
                                value={
                                    segments.length
                                        ? ms(segments.at(-1)!.latencyMs)
                                        : "—"
                                }
                                detail="Queue plus inference"
                            />
                            <MetricCard
                                icon={<IconGauge />}
                                label="Decode time"
                                value={segments.length ? ms(processingMs) : "—"}
                                detail={
                                    duration
                                        ? `${(processingMs / 1000 / duration).toFixed(3)} real-time factor`
                                        : "Native inference"
                                }
                            />
                        </div>

                        <Card>
                            <CardHeader>
                                <CardTitle>Transcript</CardTitle>
                                <CardDescription>
                                    Original model output and conservative
                                    cleanup remain separate.
                                </CardDescription>
                                <CardAction>
                                    <Badge variant="outline">
                                        {segments.length} segments
                                    </Badge>
                                </CardAction>
                            </CardHeader>
                            <CardContent>
                                <Tabs defaultValue="verbatim">
                                    <TabsList variant="line" className="mb-4">
                                        <TabsTrigger value="verbatim">
                                            Verbatim
                                        </TabsTrigger>
                                        <TabsTrigger value="cleaned">
                                            Cleaned
                                        </TabsTrigger>
                                        <TabsTrigger value="pauses">
                                            Pauses
                                        </TabsTrigger>
                                    </TabsList>
                                    <div className="transcript-grid min-h-28 rounded-lg border bg-muted/20 p-4">
                                        <TabsContent value="verbatim">
                                            <p
                                                className={
                                                    transcript.raw
                                                        ? "whitespace-pre-wrap leading-7"
                                                        : "text-muted-foreground"
                                                }
                                            >
                                                {transcript.raw ||
                                                    "Completed speech segments will appear here."}
                                            </p>
                                        </TabsContent>
                                        <TabsContent value="cleaned">
                                            <p
                                                className={
                                                    transcript.cleaned
                                                        ? "whitespace-pre-wrap leading-7"
                                                        : "text-muted-foreground"
                                                }
                                            >
                                                {transcript.cleaned ||
                                                    "Cleaned text will appear here."}
                                            </p>
                                        </TabsContent>
                                        <TabsContent value="pauses">
                                            {pauses.length ? (
                                                <div className="space-y-2">
                                                    {pauses.map((pause) => (
                                                        <div
                                                            key={pause.start}
                                                            className="flex items-center justify-between rounded-md border bg-background px-3 py-2"
                                                        >
                                                            <span>
                                                                {pause.start.toFixed(
                                                                    2,
                                                                )}{" "}
                                                                s from start
                                                            </span>
                                                            <Badge variant="secondary">
                                                                {pause.duration.toFixed(
                                                                    2,
                                                                )}{" "}
                                                                s
                                                            </Badge>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-muted-foreground">
                                                    No internal pauses measured
                                                    yet.
                                                </p>
                                            )}
                                        </TabsContent>
                                    </div>
                                </Tabs>
                            </CardContent>
                            <CardFooter className="bg-muted/30 text-xs leading-5 text-muted-foreground">
                                Filler counts describe words retained by the
                                model. VAD does not detect fillers.
                            </CardFooter>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Model benchmark</CardTitle>
                                <CardDescription>
                                    Run one in-memory sample through every
                                    installed model using identical VAD
                                    settings.
                                </CardDescription>
                                <CardAction className="flex gap-2">
                                    {report && (
                                        <>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() =>
                                                    void exportResults("json")
                                                }
                                            >
                                                <IconArrowDown /> JSON
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() =>
                                                    void exportResults("csv")
                                                }
                                            >
                                                <IconArrowDown /> CSV
                                            </Button>
                                        </>
                                    )}
                                    <Button
                                        size="sm"
                                        disabled={busy || !hasSample}
                                        onClick={() => void benchmark()}
                                    >
                                        {phase === "benchmarking" ? (
                                            <IconLoader2 className="animate-spin" />
                                        ) : (
                                            <IconFlask />
                                        )}
                                        {phase === "benchmarking"
                                            ? "Comparing…"
                                            : "Compare models"}
                                    </Button>
                                </CardAction>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                <div className="space-y-2">
                                    <label
                                        htmlFor="reference"
                                        className="text-sm font-medium"
                                    >
                                        Verified reference transcript
                                    </label>
                                    <Textarea
                                        id="reference"
                                        maxLength={30000}
                                        rows={2}
                                        value={reference}
                                        onChange={(event) =>
                                            setReference(event.target.value)
                                        }
                                        placeholder="Type exactly what was spoken, including filler words, to calculate WER and filler retention."
                                    />
                                </div>
                                {report ? (
                                    <div className="rounded-lg border">
                                        <Table>
                                            <TableHeader>
                                                <TableRow>
                                                    <TableHead>Model</TableHead>
                                                    <TableHead>
                                                        Transcript
                                                    </TableHead>
                                                    <TableHead className="text-right">
                                                        Processing
                                                    </TableHead>
                                                    <TableHead className="text-right">
                                                        Load
                                                    </TableHead>
                                                    <TableHead className="text-right">
                                                        RTF
                                                    </TableHead>
                                                    <TableHead className="text-right">
                                                        WER
                                                    </TableHead>
                                                    <TableHead className="text-right">
                                                        Fillers
                                                    </TableHead>
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {report.rows.map((row) => (
                                                    <TableRow
                                                        className="comparison"
                                                        key={row.modelId}
                                                    >
                                                        <TableCell className="font-medium">
                                                            {row.modelName}
                                                        </TableCell>
                                                        <TableCell className="max-w-md whitespace-normal text-muted-foreground">
                                                            {row.error ? (
                                                                <span className="text-destructive">
                                                                    Failed:{" "}
                                                                    {row.error}
                                                                </span>
                                                            ) : (
                                                                row.raw ||
                                                                "No speech recognized"
                                                            )}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {ms(
                                                                row.processingMs,
                                                            )}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {ms(row.loadMs)}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {row.realTimeFactor?.toFixed(
                                                                3,
                                                            ) ?? "—"}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {row.error
                                                                ? "—"
                                                                : percent(
                                                                      wordErrorRate(
                                                                          reference,
                                                                          row.raw,
                                                                      ),
                                                                  )}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {row.error
                                                                ? "—"
                                                                : percent(
                                                                      fillerRetention(
                                                                          reference,
                                                                          row.raw,
                                                                      ),
                                                                  )}
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </div>
                                ) : (
                                    <div className="flex min-h-24 flex-col items-center justify-center rounded-lg border border-dashed px-6 py-4 text-center">
                                        <IconFlask className="mb-3 size-6 text-muted-foreground" />
                                        <p className="text-sm font-medium">
                                            No benchmark sample yet
                                        </p>
                                        <p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">
                                            Enable “Capture for benchmark,”
                                            record once, then compare the
                                            installed models.
                                        </p>
                                    </div>
                                )}
                            </CardContent>
                            {report && (
                                <CardFooter className="bg-muted/30 text-xs text-muted-foreground">
                                    {report.duration.toFixed(2)} s sample ·
                                    lower RTF and WER are better · audio
                                    released after comparison
                                </CardFooter>
                            )}
                        </Card>
                    </section>
                </div>
            </main>
        </div>
    );
}

function MetricCard({
    icon,
    label,
    value,
    detail,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    detail: string;
}): React.JSX.Element {
    return (
        <Card size="sm">
            <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-2">
                <CardDescription>{label}</CardDescription>
                <span className="text-muted-foreground [&_svg]:size-4">
                    {icon}
                </span>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">
                    {value}
                </div>
                <p
                    className="mt-1 truncate text-xs text-muted-foreground"
                    title={detail}
                >
                    {detail}
                </p>
            </CardContent>
        </Card>
    );
}
