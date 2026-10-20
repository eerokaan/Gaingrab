import { createBridge } from "./app/bridge.js";
import { createBrowserAudio } from "./app/browseraudio.js";
import { createApplicationRuntime, createMainWindow } from "./app/runtime.js";
import { createMediaEngineEnvironment } from "./mediaEngine/environment.js";
import { createMediaEngineSession } from "./mediaEngine/session.js";
import { createSessionController } from "./session/controller.js";
import { createSessionStore } from "./session/store.js";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { optimizer } from "@electron-toolkit/utils";
import appInfo from "./app/info.js";

(async () => {
    let window;
    let bridge;
    let runtime;

    try {
        // Chromium media settings
        const disabledFeatures = app.commandLine.getSwitchValue("disable-features");
        app.commandLine.appendSwitch("allow-loopback-in-peer-connection");
        app.commandLine.appendSwitch("disable-features", [disabledFeatures, "WebRtcHideLocalIpsWithMdns"].filter(Boolean).join(","));
        app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

        // Application identity and readiness
        app.setName(appInfo.name);
        await app.whenReady();

        // Results and stimuli directories
        const resultsRoot = join(app.getPath("home"), "gaingrab");
        const stimuliDirectory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
        await mkdir(resultsRoot, { recursive: true });

        // Media engine executable and environment
        const executableName = process.platform === "win32" ? "gg-mediaengine.exe" : "gg-mediaengine";
        const executablePath = app.isPackaged ? join(process.resourcesPath, "gg-mediaengine", executableName) : join(app.getAppPath(), "build", process.platform === "win32" ? "win" : "linux", executableName);
        const environment = createMediaEngineEnvironment(executablePath, { requireBundledRuntime: app.isPackaged });

        // Main window and renderer bridge
        window = createMainWindow(BrowserWindow, {
            title: appInfo.displayName,
            preloadPath: join(__dirname, "../preload/index.js"),
            devTools: !app.isPackaged
        });
        optimizer.watchWindowShortcuts(window);
        bridge = createBridge(window.webContents, ipcMain);

        // Media session and browser audio
        const media = createMediaEngineSession({
            executablePath,
            environment,
            browserAudio: createBrowserAudio(bridge)
        });

        // Session controller and results storage
        const controller = createSessionController({
            media,
            store: createSessionStore(resultsRoot),
            stimuliDirectory
        });

        // Application runtime and renderer loading
        runtime = createApplicationRuntime({
            app,
            ipcMain,
            electronSession: session.defaultSession,
            window,
            bridge,
            controller,
            media,
            loadContent: async () => {
                if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
                    const rendererUrl = new URL("windowMain.html", process.env.ELECTRON_RENDERER_URL);
                    await window.loadURL(rendererUrl.toString());
                }
                else {
                    await window.loadFile(join(__dirname, "../renderer", "windowMain.html"));
                }
            }
        });
        await runtime.start();
    }
    catch (error) {
        console.error(error);

        if (runtime) {
            await runtime.shutdown(1);
        }
        else {
            if (bridge) bridge.dispose();
            if (window && !window.isDestroyed()) window.destroy();
            app.exit(1);
        }
    }
})();
