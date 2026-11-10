import { contextBridge, ipcRenderer } from "electron";
import type { DatabaseStatus } from "../shared/database";
import type { VoiceApi, VoiceEvent } from "../shared/voice";

const voice: VoiceApi = {
    models: () => ipcRenderer.invoke("voice:models"),
    download: (id) => ipcRenderer.invoke("voice:download", id),
    load: (id) => ipcRenderer.invoke("voice:load", id),
    start: (settings, benchmark) =>
        ipcRenderer.invoke("voice:start", settings, benchmark),
    audio: (samples) => ipcRenderer.invoke("voice:audio", samples),
    stop: () => ipcRenderer.invoke("voice:stop"),
    cancel: () => ipcRenderer.invoke("voice:cancel"),
    benchmark: () => ipcRenderer.invoke("voice:benchmark"),
    selection: () => ipcRenderer.invoke("voice:selection"),
    setModelOverride: (id) => ipcRenderer.invoke("voice:model-override", id),
    rerunSelectionBenchmark: () => ipcRenderer.invoke("voice:selection-rerun"),
    resources: () => ipcRenderer.invoke("voice:resources"),
    export: (format, reference) =>
        ipcRenderer.invoke("voice:export", format, reference),
    onEvent: (callback) => {
        const listener = (
            _event: Electron.IpcRendererEvent,
            event: VoiceEvent,
        ): void => callback(event);
        ipcRenderer.on("voice:event", listener);
        return () => ipcRenderer.removeListener("voice:event", listener);
    },
};

const api = {
    voice,
    database: {
        getStatus: (): Promise<DatabaseStatus> =>
            ipcRenderer.invoke("database:status"),
        get: (key: string): Promise<string | null> =>
            ipcRenderer.invoke("database:get", key),
        set: (key: string, value: string): Promise<void> =>
            ipcRenderer.invoke("database:set", key, value),
    },
};

contextBridge.exposeInMainWorld("api", api);

export type AppApi = typeof api;
