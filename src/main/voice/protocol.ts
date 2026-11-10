import type {
    CaptureResult,
    ModelId,
    VadSettings,
    VoiceEvent,
} from "../../shared/voice";

export interface LoadWorkerCommand {
    id: number;
    type: "load";
    modelId: ModelId;
    directory: string;
}

export interface StartWorkerCommand {
    id: number;
    type: "start";
    vadPath: string;
    settings: VadSettings;
    retain: boolean;
}

export interface AudioWorkerCommand {
    id: number;
    type: "audio";
    samples: Float32Array;
}

export interface StopWorkerCommand {
    id: number;
    type: "stop";
}

export type WorkerCommand =
    | LoadWorkerCommand
    | StartWorkerCommand
    | AudioWorkerCommand
    | StopWorkerCommand;

export type WorkerRequest =
    | { type: "load"; modelId: ModelId; directory: string }
    | { type: "start"; vadPath: string; settings: VadSettings; retain: boolean }
    | { type: "audio"; samples: Float32Array }
    | { type: "stop" };

export interface WorkerResult {
    result: CaptureResult;
    sample?: Float32Array;
}

export type WorkerMessage =
    | { type: "reply"; id: number; value?: WorkerResult; error?: string }
    | { type: "event"; event: VoiceEvent };
