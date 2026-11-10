import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { VoiceService } from "./voice/VoiceService";
import { exportReport } from "./voice/BenchmarkService";
import type { ModelId, VadSettings, VoiceEvent } from "../shared/voice";
import {
    closeDatabase,
    getDatabaseStatus,
    getValue,
    initializeDatabase,
    setValue,
} from "./database";

let voice: VoiceService;
let voiceWindow: BrowserWindow | undefined;
const rendererFile = join(__dirname, "../renderer/index.html");
const selectionCacheKey = "voice:model-selection-v1";

function benchmarkSamplePath(): string {
    if (app.isPackaged) {
        return join(process.resourcesPath, "voice-benchmark.wav");
    }
    return join(app.getAppPath(), "resources", "voice-benchmark.wav");
}

function trustedFrame(event: Electron.IpcMainInvokeEvent): void {
    const expected = new URL(
        process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(rendererFile).href,
    ).href;
    if (
        voiceWindow == null ||
        event.sender !== voiceWindow.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== expected
    ) {
        throw new Error("Untrusted IPC sender");
    }
}

function createWindow(): void {
    const mainWindow = new BrowserWindow({
        width: 1240,
        height: 900,
        minWidth: 760,
        minHeight: 520,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, "../preload/index.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    voiceWindow = mainWindow;
    mainWindow.on("closed", () => {
        voiceWindow = undefined;
        void voice.cancel();
    });
    mainWindow.webContents.on("render-process-gone", () => {
        void voice.cancel();
    });
    mainWindow.webContents.on(
        "did-start-navigation",
        (_event, _url, _inPlace, isMainFrame) => {
            if (isMainFrame) {
                void voice.cancel();
            }
        },
    );
    mainWindow.webContents.on("will-navigate", (event, url) => {
        const expected = new URL(
            process.env.ELECTRON_RENDERER_URL ??
                pathToFileURL(rendererFile).href,
        ).href;
        if (url !== expected) {
            event.preventDefault();
        }
    });
    const session = mainWindow.webContents.session;
    session.setPermissionCheckHandler(
        (contents, permission) =>
            contents === mainWindow.webContents && permission === "media",
    );
    session.setPermissionRequestHandler(
        (contents, permission, callback, details) => {
            callback(
                contents === mainWindow.webContents &&
                    details.isMainFrame &&
                    permission === "media" &&
                    "mediaTypes" in details &&
                    details.mediaTypes?.every((type) => type === "audio") ===
                        true,
            );
        },
    );

    mainWindow.on("ready-to-show", () => mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https://")) {
            void shell.openExternal(url);
        }
        return { action: "deny" };
    });

    if (process.env.ELECTRON_RENDERER_URL) {
        void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        void mainWindow.loadFile(rendererFile);
    }
}

function registerIpcHandlers(): void {
    const registerVoiceHandler = (
        channel: string,
        action: (...args: unknown[]) => unknown,
    ): void => {
        ipcMain.handle(channel, (event, ...args: unknown[]) => {
            trustedFrame(event);
            return action(...args);
        });
    };
    const parseModelId = (value: unknown): ModelId => {
        if (typeof value !== "string") {
            throw new Error("Invalid model ID");
        }
        voice.models.definition(value as ModelId);
        return value as ModelId;
    };
    registerVoiceHandler("voice:models", () => voice.models.list());
    registerVoiceHandler("voice:download", (id) =>
        voice.download(parseModelId(id)),
    );
    registerVoiceHandler("voice:load", (id) => voice.load(parseModelId(id)));
    registerVoiceHandler("voice:start", (settings, benchmark) => {
        if (typeof benchmark !== "boolean") {
            throw new Error("Invalid capture mode");
        }
        return voice.start(settings as VadSettings, benchmark);
    });
    registerVoiceHandler("voice:audio", (samples) =>
        voice.audio(samples as Float32Array),
    );
    registerVoiceHandler("voice:stop", () => voice.stop());
    registerVoiceHandler("voice:cancel", () => voice.cancel());
    registerVoiceHandler("voice:benchmark", () => voice.benchmark());
    registerVoiceHandler("voice:selection", () => voice.selection());
    registerVoiceHandler("voice:selection-rerun", () =>
        voice.rerunSelectionBenchmark(),
    );
    registerVoiceHandler("voice:resources", () => voice.resourceUsage());
    registerVoiceHandler("voice:model-override", (id) => {
        if (id === null) {
            return voice.setModelOverride(null);
        }
        return voice.setModelOverride(parseModelId(id));
    });
    registerVoiceHandler("voice:export", async (format, reference) => {
        if (
            (format !== "json" && format !== "csv") ||
            typeof reference !== "string" ||
            reference.length > 30_000
        ) {
            throw new Error("Invalid export request");
        }
        if (voice.report == null || voiceWindow == null) {
            throw new Error("No benchmark results to export");
        }
        const content = exportReport(voice.report, reference, format);
        const { canceled, filePath } = await dialog.showSaveDialog(
            voiceWindow,
            {
                defaultPath: `voice-benchmark.${format}`,
                filters: [{ name: format.toUpperCase(), extensions: [format] }],
            },
        );
        if (canceled || filePath == null) {
            return false;
        }
        await writeFile(filePath, content, "utf8");
        return true;
    });
    ipcMain.handle("database:status", () => getDatabaseStatus());
    ipcMain.handle("database:get", (_event, key: string) => getValue(key));
    ipcMain.handle("database:set", (_event, key: string, value: string) =>
        setValue(key, value),
    );
}

app.whenReady().then(() => {
    initializeDatabase();
    voice = new VoiceService(
        join(app.getPath("userData"), "voice-models"),
        (event) => {
            if (voiceWindow && !voiceWindow.isDestroyed())
                voiceWindow.webContents.send("voice:event", event);
        },
        {
            benchmarkSamplePath: benchmarkSamplePath(),
            readSelectionCache: () => getValue(selectionCacheKey),
            writeSelectionCache: (value) => setValue(selectionCacheKey, value),
        },
    );
    registerIpcHandlers();
    createWindow();
    void voice.selection().catch((error: unknown) => {
        if (voiceWindow && !voiceWindow.isDestroyed())
            voiceWindow.webContents.send("voice:event", {
                type: "error",
                message: errorMessage(error),
            } satisfies VoiceEvent);
    });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", closeDatabase);
app.on("before-quit", () => {
    void voice?.cancel();
});

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
