import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: {
                    index: resolve("src/main/index.ts"),
                    "voice-worker": resolve("src/main/voice/voice-worker.ts"),
                },
                output: { entryFileNames: "[name].js" },
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        build: { assetsInlineLimit: 0 },
        resolve: {
            alias: {
                "@": resolve("src/renderer/src"),
                "@renderer": resolve("src/renderer/src"),
            },
        },
        plugins: [react(), tailwindcss()],
    },
});
