import { randomUUID } from "node:crypto";

const requestTimeoutMs = 5000;
const validRequestChannels = ["ipc:storeSetValueRequest", "ipc:startAudioSessionRequest", "ipc:stopAudioSessionRequest", "ipc:waitForPlaybackRequest", "ipc:engineIceCandidateRequest"];
const validResponseChannels = ["ipc:storeSetValueResponse", "ipc:startAudioSessionResponse", "ipc:stopAudioSessionResponse", "ipc:waitForPlaybackResponse", "ipc:engineIceCandidateResponse"];

// ################################################
// ############ PUBLIC API ########################
// ################################################
function createBridge(webContents, ipcMain) {
    // ===== Construction ==========
    const pendingRequests = new Map();
    const responseListeners = new Map();
    let disposed = false;
    let ready = false;

    for (const responseChannel of validResponseChannels) {
        const listener = (ipcEvent, response) => {
            handleResponse(responseChannel, ipcEvent, response);
        };

        responseListeners.set(responseChannel, listener);
        ipcMain.on(responseChannel, listener);
    }

    const handleDestroyed = () => {
        dispose(createError("Renderer became unavailable", "rendererUnavailable"));
    };
    const handleNavigation = (event, url, isInPlace, isMainFrame) => {
        // A replacement document must complete its own readiness handshake
        if (isMainFrame && !isInPlace) {
            ready = false;
            rejectAll(createError("Renderer is reloading", "rendererReloading"));
        }
    };

    webContents.once("destroyed", handleDestroyed);
    webContents.on("did-start-navigation", handleNavigation);

    // ===== Bridge API ==========
    function request(requestChannel, responseChannel, payload, { timeoutMs = requestTimeoutMs } = {}) {
        if (!validRequestChannels.includes(requestChannel)) {
            return Promise.reject(createError("Unknown renderer request event", "ipcUnknownEvent"));
        }
        if (disposed || webContents.isDestroyed()) {
            return Promise.reject(createError("Renderer is unavailable", "rendererUnavailable"));
        }
        if (!responseListeners.has(responseChannel)) {
            return Promise.reject(createError("Unknown renderer request event", "ipcUnknownEvent"));
        }
        if (!ready) {
            return Promise.reject(createError("Renderer is reloading", "rendererReloading"));
        }

        const requestId = randomUUID();

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                takePending(requestId);
                reject(createError(`Renderer request timed out: ${requestChannel}`, "ipcTimeout"));
            }, timeoutMs);

            pendingRequests.set(requestId, {
                reject,
                resolve,
                responseChannel,
                timer
            });

            try {
                webContents.send(requestChannel, { requestId, payload });
            }
            catch (error) {
                takePending(requestId);
                reject(error);
            }
        });
    }

    function setReady() {
        if (disposed || webContents.isDestroyed()) {
            throw createError("Renderer is unavailable", "rendererUnavailable");
        }
        ready = true;
    }

    function dispose(error = createError("Renderer bridge was disposed", "rendererUnavailable")) {
        if (disposed) return;
        disposed = true;

        webContents.removeListener("destroyed", handleDestroyed);
        webContents.removeListener("did-start-navigation", handleNavigation);

        for (const [channel, listener] of responseListeners) {
            ipcMain.removeListener(channel, listener);
        }

        responseListeners.clear();
        rejectAll(error);
    }

    // ################################################
    // ############ PRIVATE HELPERS ###################
    // ################################################
    // ===== Response Helpers ==========
    function handleResponse(responseChannel, event, response) {
        if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) return;
        if (!response || typeof response !== "object" || typeof response.requestId !== "string") return;

        const pending = takePending(response.requestId);
        if (!pending) return;

        if (pending.responseChannel !== responseChannel || !isResponseEnvelope(response)) {
            pending.reject(createError("Invalid renderer response envelope", "ipcProtocolError"));
            return;
        }
        if (response.success) {
            pending.resolve(response.value);
            return;
        }

        pending.reject(deserializeError(response.error));
    }

    function isResponseEnvelope(response) {
        if (!Object.hasOwn(response, "value") || typeof response.success !== "boolean" || !Object.hasOwn(response, "error")) return false;
        return response.success || (response.error !== null && typeof response.error === "object" && typeof response.error.name === "string" && typeof response.error.message === "string");
    }

    // ===== Pending Request Helpers ==========
    function takePending(requestId) {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;

        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);

        return pending;
    }

    function rejectAll(error) {
        for (const requestId of pendingRequests.keys()) {
            takePending(requestId).reject(error);
        }
    }

    return { request, setReady, dispose };
}

// ===== Error Helpers ==========
function createError(message, code) {
    const error = new Error(message);
    if (code !== undefined && code !== null) error.code = code;
    return error;
}

function deserializeError(value) {
    const error = createError(value.message, value.code);
    error.name = value.name;
    return error;
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createBridge };
