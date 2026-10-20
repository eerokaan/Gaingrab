import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const readyTimeoutMs = 3000;
const requestTimeoutMs = 3000;
const shutdownTimeoutMs = 3000;

// ################################################
// ############ PUBLIC API ########################
// ################################################
function createMediaEngineProcess(executablePath, options = {}) {
    // ===== Construction ==========
    const emitter = new EventEmitter();
    const requestPending = new Map();
    const environment = options.environment ?? process.env;

    let requestNext = 1;
    let stdoutBuffer = "";
    let metaState = "idle";
    let metaShuttingDown = false;
    let child;
    let exitPromise;
    let resolveExit;
    let resolveReady;
    let rejectReady;
    let readyTimer;
    let metaShutdownPromise;

    // ===== Lifecycle API ==========
    function start() {
        if (metaState !== "idle") {
            return Promise.reject(new Error("Media engine has already been started"));
        }
        metaState = "starting";

        child = spawn(executablePath, {
            env: environment,
            stdio: ["pipe", "pipe", "pipe"]
        });

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => handleStdout(chunk));
        child.stderr.on("data", (chunk) => emitter.emit("log", chunk));
        child.stdin.on("error", (error) => handleStdinError(error));
        child.once("error", (error) => handleSpawnError(error));
        child.once("close", (code, signal) => handleExit(code, signal));

        exitPromise = new Promise((resolve) => {
            resolveExit = resolve;
        });

        // Startup completes on the protocol ready event rather than process creation
        // Terminate the child if it never reaches that boundary
        return new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;

            readyTimer = setTimeout(() => {
                metaState = "failed";
                rejectReady = null;
                resolveReady = null;
                reject(new Error(`Media engine ready timed out after ${readyTimeoutMs} ms`));
                child.kill();
            }, readyTimeoutMs);
        });
    }

    async function shutdown() {
        if (metaShutdownPromise) {
            return metaShutdownPromise;
        }

        metaShutdownPromise = performShutdown();
        return metaShutdownPromise;
    }

    // ===== Request API ==========
    function request(command, payload = {}) {
        if (metaState !== "ready") {
            return Promise.reject(new Error("Media engine is not ready"));
        }

        const id = requestNext++;
        const message = JSON.stringify({ type: "request", id, command, payload });

        // Register the request before writing and bound how long it can remain pending
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                requestPending.delete(id);
                reject(new Error(`Media engine request ${id} timed out after ${requestTimeoutMs} ms`));
            }, requestTimeoutMs);

            requestPending.set(id, { resolve, reject, timer });

            child.stdin.write(`${message}\n`, (error) => {
                if (error) {
                    const pending = requestPending.get(id);

                    if (pending) {
                        clearTimeout(pending.timer);
                        requestPending.delete(id);
                        pending.reject(error);
                    }
                }
            });
        });
    }

    // ===== Media Command API ==========
    function configureSession(configuration) {
        return request("session_configure", configuration);
    }

    function setHeadphoneGain(value) {
        return request("gain_headphone_set", { value });
    }

    function setRecordingGain(value) {
        return request("gain_recording_set", { value });
    }

    function startPlayback(source, playbackId) {
        return request("playback_start", { source, playback_id: playbackId });
    }

    function stopPlayback() {
        return request("playback_stop");
    }

    function startAudioBaseline() {
        return request("audio_baseline_start");
    }

    function stopAudioBaseline() {
        return request("audio_baseline_stop");
    }

    function renderAudioGainRecording() {
        return request("audio_gain_recording_render");
    }

    // ################################################
    // ############ PRIVATE HELPERS ###################
    // ################################################
    // ===== Shutdown Helpers ==========
    async function performShutdown() {
        if (metaState === "idle" || metaState === "stopped") {
            return;
        }
        metaShuttingDown = true;

        try {
            if (metaState === "ready") {
                await request("mediaengine_shutdown");
            }

            child.stdin.end();
            await waitForExit(shutdownTimeoutMs, "Media engine shutdown timed out");
        }
        catch (error) {
            await forceKill();
            throw error;
        }
    }

    async function forceKill() {
        if (metaState === "stopped") {
            return;
        }

        // SIGTERM: Allow a brief termination window before using an unconditional kill
        child.kill("SIGTERM");
        try {
            await waitForExit(Math.min(shutdownTimeoutMs, 500));
            return;
        }
        catch {
            // A termination timeout falls through to SIGKILL
        }

        // SIGKILL: Now kill without mercy
        child.kill("SIGKILL");
        try {
            await waitForExit(1000);
        }
        catch {
            // Keep cleanup bounded without replacing the original shutdown failure
        }
    }

    async function waitForExit(timeoutMs, message = "Child process did not exit") {
        let timer;

        try {
            await Promise.race([
                exitPromise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                })
            ]);
        }
        finally {
            clearTimeout(timer);
        }
    }

    // ===== Protocol Helpers ==========
    function handleStdout(chunk) {
        stdoutBuffer += chunk;

        // Bound buffering when the child does not supply a complete protocol line
        if (stdoutBuffer.length > 1024 * 1024) {
            emitter.emit("protocolError", new Error("Media engine protocol buffer exceeded 1 MiB"));
            stdoutBuffer = "";
            return;
        }

        // Retain partial lines until a later stream chunk completes them
        let newlineIndex;

        while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
            const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

            if (line.length > 0) {
                handleLine(line);
            }
        }
    }

    function handleLine(line) {
        let message;

        try {
            message = JSON.parse(line);
        }
        catch {
            emitter.emit("protocolError", new Error("Media engine stdout contained invalid JSON"));
            return;
        }

        if (message != null && message.type === "response") {
            handleResponse(message);
            return;
        }
        if (message != null && message.type === "event" && typeof message.event === "string") {
            handleEvent(message);
            return;
        }
        emitter.emit("protocolError", new Error("Media engine emitted an invalid protocol message"));
    }

    function handleResponse(message) {
        const pending = requestPending.get(message.id);

        if (!pending) {
            emitter.emit("protocolError", new Error(`Unexpected media engine response id: ${message.id}`));
            return;
        }

        clearTimeout(pending.timer);
        requestPending.delete(message.id);

        if (message.ok === true) {
            pending.resolve(message.payload ?? {});
        }
        else {
            let errorCode = "requestFailed";
            let errorMessage = "Media engine request failed";

            if (message.error != null) {
                errorCode = message.error.code ?? "requestFailed";
                errorMessage = message.error.message ?? "Media engine request failed";
            }

            pending.reject(createMediaEngineRequestError(errorCode, errorMessage));
        }
    }

    function handleEvent(message) {
        const payload = message.payload ?? {};

        if (message.event === "ready" && metaState === "starting") {
            clearTimeout(readyTimer);
            metaState = "ready";

            const resolve = resolveReady;
            resolveReady = null;
            rejectReady = null;

            resolve(payload);
        }

        emitter.emit("event", message);
        emitter.emit(message.event, payload);
    }

    // ===== Process Event Helpers ==========
    function handleSpawnError(error) {
        if (rejectReady) {
            metaState = "failed";
            clearTimeout(readyTimer);
            rejectReady(error);
            rejectReady = null;
            resolveReady = null;
        }

        emitter.emit("spawnError", error);
    }

    function handleStdinError(error) {
        // Suppress stream errors once process failure or exit is already known
        if (metaState === "failed" || metaState === "stopped") {
            return;
        }
        metaState = "failed";

        clearTimeout(readyTimer);
        if (rejectReady) {
            rejectReady(error);
            rejectReady = null;
            resolveReady = null;
        }

        for (const pending of requestPending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        requestPending.clear();

        // Observe cleanup rejection without replacing the stream error reported below
        shutdown().catch(() => {});
        emitter.emit("protocolError", error);
    }

    function handleExit(code, signal) {
        if (stdoutBuffer.trim().length > 0) {
            emitter.emit("protocolError", new Error("Media engine exited with an incomplete protocol line"));
        }

        clearTimeout(readyTimer);
        if (rejectReady) {
            rejectReady(new Error(`Media engine exited before ready (${code ?? signal})`));
            rejectReady = null;
            resolveReady = null;
        }

        const exitError = new Error(`Media engine exited (${code ?? signal})`);
        for (const pending of requestPending.values()) {
            clearTimeout(pending.timer);
            pending.reject(exitError);
        }

        requestPending.clear();
        metaState = "stopped";
        resolveExit({ code, signal });
        emitter.emit("exit", { code, signal });

        if (!metaShuttingDown) {
            emitter.emit("unexpectedExit", { code, signal });
        }
    }

    return Object.assign(emitter, {
        start,
        shutdown,
        request,
        configureSession,
        setHeadphoneGain,
        setRecordingGain,
        startPlayback,
        stopPlayback,
        startAudioBaseline,
        stopAudioBaseline,
        renderAudioGainRecording
    });
}

function createMediaEngineRequestError(code, message) {
    const error = new Error(message);
    error.name = "MediaEngineRequestError";
    error.code = code;
    return error;
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createMediaEngineProcess };
