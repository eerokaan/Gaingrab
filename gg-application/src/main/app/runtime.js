// ################################################
// ############ PUBLIC API ########################
// ################################################
function createMainWindow(BrowserWindow, { title, preloadPath, devTools }) {
    return new BrowserWindow({
        x: 100,
        y: 100,
        width: 1366,
        height: 768,
        title,
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            devTools,
            preload: preloadPath
        }
    });
}

function createApplicationRuntime(options) {
    // ===== Construction ==========
    const { app, ipcMain, electronSession, window, bridge, controller, media, loadContent } = options;
    const exit =
        options.exit ??
        ((code) => {
            setImmediate(() => {
                setTimeout(() => process.exit(code), 500);
                app.exit(code);
            });
        });

    const listeners = [];
    const channels = [];
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10000;
    const drainTimeoutMs = options.drainTimeoutMs ?? 2000;

    let started = false;
    let shutdownPromise = null;
    let rendererHasBeenReady = false;
    let navigating = true;
    let navigationCommitted = false;

    // ===== Lifecycle API ==========
    async function start() {
        if (started || shutdownPromise) {
            throw new Error("Application runtime cannot be started again");
        }
        started = true;

        // Configure renderer permissions and window restrictions
        electronSession.setPermissionCheckHandler((webContents, permission, origin, details) => permissionGranted(webContents, permission, details));
        electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(permissionGranted(webContents, permission, details)));
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

        // Listener: Report media failures and notify the session controller
        listen(media, "failure", (error) => {
            console.error(error);
            controller.handleMediaFailure(error);
        });

        // Listener: Deliver session snapshots and handle renderer delivery failures
        listen(controller, "state", (snapshot) => {
            updateRenderer(snapshot).catch((error) => {
                if (error.code === "rendererReloading") return;
                console.error(error);

                if (!shutdownPromise) stopAfterRendererFailure("Renderer snapshot delivery failed");
            });
        });

        // Listener: Prevent immediate window closure and shut down cleanly
        listen(window, "close", (event) => {
            event.preventDefault();
            shutdown();
        });

        // Listener: Shut down after the renderer becomes unresponsive
        listen(window, "unresponsive", () => stopAfterRendererFailure("Renderer process became unresponsive"));

        // Listener: Block navigation to a different URL
        listen(window.webContents, "will-navigate", (event, url) => {
            if (url !== window.webContents.getURL()) event.preventDefault();
        });

        // Listener: Gate IPC during navigation and report loss of a previously ready renderer
        listen(window.webContents, "did-start-navigation", (event, url, isInPlace, isMainFrame) => {
            if (!isMainFrame || isInPlace) return;
            navigating = true;
            navigationCommitted = false;
            if (rendererHasBeenReady) controller.handleRendererLoss();
        });

        // Listener: Mark navigation as committed so the renderer can complete its readiness handshake
        listen(window.webContents, "did-navigate", () => {
            navigationCommitted = true;
        });

        // Listener: Show the main window once it is ready for display
        listen(
            window,
            "ready-to-show",
            () => {
                console.log("Gaingrab application ready");
                window.show();
            },
            true
        );

        // Listener: Forward renderer console errors in development
        if (!app.isPackaged) {
            listen(window.webContents, "console-message", ({ level, message, sourceId, lineNumber }) => {
                if (level === "error") console.error(`${message} (${sourceId}:${lineNumber})`);
            });
        }

        // Listener: Shut down on main frame load failures other than aborted navigation
        listen(window.webContents, "did-fail-load", (event, errorCode, errorDescription, url, isMainFrame) => {
            if (isMainFrame !== false && errorCode !== -3) stopAfterRendererFailure(`Renderer load failed (${errorCode}): ${errorDescription}`);
        });

        // Listener: Shut down when the renderer process exits unexpectedly
        listen(window.webContents, "render-process-gone", (event, details) => {
            stopAfterRendererFailure(`Renderer process ended unexpectedly: ${details.reason}`);
        });

        // IPC renderer call: Complete renderer readiness and deliver the current session snapshot
        rendererCall("ipc:rendererReadyCall", async () => {
            if (navigating && !navigationCommitted) {
                throw new Error("Renderer navigation has not committed");
            }

            bridge.setReady();
            rendererHasBeenReady = true;
            navigating = false;

            await updateRenderer(controller.snapshot());
        });

        // IPC renderer call: Start a session with the supplied settings
        rendererCall("ipc:sessionStartCall", async (settings) => {
            await controller.start(settings);
        });

        // IPC renderer call: Dispatch a participant action through the session controller
        rendererCall("ipc:participantActionCall", async (action) => {
            await controller.dispatch(action);
        });

        // IPC renderer call: Forward the renderer WebRTC offer to the media session
        rendererCall("ipc:webrtcOfferCall", (offer) => media.setRemoteOffer(offer));

        // IPC renderer call: Forward a renderer ICE candidate to the media session
        rendererCall("ipc:webrtcIceCandidateCall", (candidate) => media.addRemoteIceCandidate(candidate));

        // IPC renderer call: Report renderer audio failure to the media session
        rendererCall("ipc:rendererAudioFailureCall", (message) => media.rendererAudioFailed(message));

        // Load content after all listeners and IPC handlers are registered
        try {
            await loadContent();
        }
        catch (error) {
            if (error.errno === -3 || error.code === "ERR_ABORTED") return;
            if (!shutdownPromise) console.error(error);
            await shutdown();
        }
    }

    function shutdown(exitCode = 0) {
        if (!shutdownPromise) {
            shutdownPromise = Promise.resolve().then(() => performShutdown(exitCode));
        }
        return shutdownPromise;
    }

    // ################################################
    // ############ PRIVATE HELPERS ###################
    // ################################################
    // ===== Renderer Integration Helpers ==========
    function listen(target, event, listener, once = false) {
        if (once) target.once(event, listener);
        else target.on(event, listener);
        listeners.push({ target, event, listener });
    }

    function rendererCall(channel, handler) {
        ipcMain.handle(channel, (event, ...args) => {
            if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
                throw new Error("Unauthorized renderer IPC sender");
            }
            if (shutdownPromise || (channel !== "ipc:rendererReadyCall" && navigating)) {
                throw new Error("Renderer IPC is unavailable during navigation or shutdown");
            }
            return handler(...args);
        });
        channels.push(channel);
    }

    function updateRenderer(snapshot) {
        return bridge.request("ipc:storeSetValueRequest", "ipc:storeSetValueResponse", snapshot);
    }

    function permissionGranted(webContents, permission, details = {}) {
        if (window.isDestroyed() || webContents !== window.webContents || details.isMainFrame === false) return false;
        if (permission === "speaker-selection") return true;
        if (permission !== "media") return false;

        const mediaTypes = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : []);
        return mediaTypes.length > 0 && mediaTypes.every((mediaType) => mediaType === "audio");
    }

    // ===== Failure and Shutdown Helpers ==========
    function stopAfterRendererFailure(message) {
        console.error(message);
        controller.handleRendererLoss(new Error(message));
        bridge.dispose(new Error(message));
        if (!shutdownPromise) shutdown(1);
    }

    async function performShutdown(exitCode) {
        let timer;
        let drainTimer;

        try {
            // Give active work a bounded chance to finish before forcing media cleanup
            drainTimer = setTimeout(() => {
                controller.stopMedia().catch((error) => console.error(error));
            }, drainTimeoutMs);

            // Bound the complete shutdown even if cleanup itself stalls
            await Promise.race([
                controller.shutdown(),
                new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        controller.stopMedia().catch((error) => console.error(error));
                        reject(new Error("Application shutdown timed out"));
                    }, shutdownTimeoutMs);
                })
            ]);
        }
        catch (error) {
            exitCode = 1;
            console.error(error);
        }
        finally {
            clearTimeout(timer);
            clearTimeout(drainTimer);

            for (const channel of channels) ipcMain.removeHandler(channel);
            for (const { target, event, listener } of listeners) target.removeListener(event, listener);

            electronSession.setPermissionCheckHandler(null);
            electronSession.setPermissionRequestHandler(null);
            bridge.dispose();

            if (!window.isDestroyed()) window.destroy();
            exit(exitCode);
        }
    }

    return { start, shutdown };
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createApplicationRuntime, createMainWindow };
