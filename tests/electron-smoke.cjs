// Exercises the shipped renderer, preload, AudioWorklet, IPC and native worker.
// Uses Chromium's fake microphone with an official test fixture, never a real mic.
const { app, dialog } = require("electron");
const {
    mkdirSync,
    cpSync,
    writeFileSync,
    readFileSync,
    existsSync,
} = require("node:fs");
const { resolve, join } = require("node:path");
const assert = require("node:assert/strict");
const root = resolve(process.env.VOICE_FIXTURES || ".voice-validation");
const userData = join(root, "electron-smoke");
mkdirSync(userData, { recursive: true });
cpSync(join(root, "installed"), join(userData, "voice-models"), {
    recursive: true,
});
app.setPath("userData", userData);
// Electron's development app path must remain the repository for migrations.
app.setAppPath(resolve("."));
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch(
    "use-file-for-fake-audio-capture",
    join(root, "Obama.wav"),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on("browser-window-created", (_event, window) => {
    window.webContents.on("console-message", (_event, ...args) =>
        console.log("renderer", ...args),
    );
    window.webContents.once("did-finish-load", () => {
        void run(window).catch((error) => {
            console.error(error);
            app.exit(1);
        });
    });
});
async function run(window) {
    const js = (code) => window.webContents.executeJavaScript(code, true);
    const until = async (expression) => {
        const end = Date.now() + 30_000;
        while (Date.now() < end) {
            if (await js(expression)) {
                return;
            }
            await sleep(100);
        }
        throw new Error(
            "Timed out: " +
                expression +
                "\n" +
                (await js("document.body.innerText")),
        );
    };
    await until(`document.body.innerText.includes('HELLO WORLD')`);
    await js(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Voice playground')).click()`,
    );
    await until(`document.body.innerText.includes('Recognition model')`);
    const models = await js("window.api.voice.models()");
    assert.equal(models.filter((m) => m.installed).length, 3);
    await until(`document.querySelector('.talk-button').disabled === false`);
    const selection = await js("window.api.voice.selection()");
    assert.equal(selection.mode, "automatic");
    assert.ok(selection.loadedModelId);
    assert.ok(
        selection.benchmarks.some((result) => result.realTimeFactor !== null),
    );
    await sleep(1100);
    const resources = await js("window.api.voice.resources()");
    assert.ok(Number.isFinite(resources.voiceCpuPercent));
    assert.ok(Number.isFinite(resources.systemCpuPercent));
    assert.ok(resources.voiceMemoryBytes > 0);
    assert.ok(resources.totalMemoryBytes > resources.availableMemoryBytes);
    await js(`document.querySelector('[role=checkbox]').click()`);
    await js(
        `document.querySelector('.talk-button').focus(); document.querySelector('.talk-button').dispatchEvent(new KeyboardEvent('keydown', {key:' ', bubbles:true}))`,
    );
    await until(
        `document.querySelector('.talk-button').textContent.includes('Release')`,
    );
    await sleep(14000);
    await js(
        `document.querySelector('.talk-button').dispatchEvent(new KeyboardEvent('keyup', {key:' ', bubbles:true}))`,
    );
    await until(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Compare models')).disabled === false`,
    );
    const raw = await js(
        `document.querySelector('.transcript-grid p').textContent`,
    );
    assert.ok(raw.toLowerCase().includes("everybody"), raw);
    assert.equal(
        await js(`document.querySelector('[role=alert]')?.textContent ?? ''`),
        "",
    );
    writeFileSync(
        join(root, "playground.png"),
        (await window.webContents.capturePage()).toPNG(),
    );
    console.log("ELECTRON SMOKE PASSED:", raw);
    await js(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Compare models')).click()`,
    );
    await until(`document.querySelectorAll('.comparison').length === 3`);
    assert.equal(
        await js(`document.querySelector('[role=alert]')?.textContent ?? ''`),
        "",
    );
    assert.ok(
        !(
            await js(
                `Array.from(document.querySelectorAll('.comparison')).map(e => e.textContent).join(' ')`,
            )
        ).includes("Failed:"),
    );
    for (const format of ["json", "csv"]) {
        const filePath = join(root, `electron-smoke-export.${format}`);
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
        await js(
            `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('${format.toUpperCase()}')).click()`,
        );
        for (let i = 0; !existsSync(filePath) && i < 100; i++) {
            await sleep(50);
        }
        assert.ok(existsSync(filePath));
        if (format === "json") {
            const exported = JSON.parse(readFileSync(filePath, "utf8"));
            assert.equal(exported.rows.length, 3);
            assert.equal(exported.audio, undefined);
            assert.equal(exported.sample, undefined);
        }
    }
    console.log("ELECTRON BENCHMARK + EXPORT PASSED");
    await js("window.api.voice.cancel()");
    app.quit();
}
require(
    process.env.VOICE_TEST_PACKAGED
        ? "../release/win-unpacked/resources/app.asar/out/main/index.js"
        : "../out/main/index.js",
);
setTimeout(() => {
    console.error("Electron smoke timeout");
    app.exit(1);
}, 60_000);
