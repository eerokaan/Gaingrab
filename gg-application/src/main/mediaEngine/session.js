import { createMediaEngineProcess } from "./process.js";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";

const handshakeTimeoutMs = 3000;

// ################################################
// ############ PUBLIC API ########################
// ################################################
function createMediaEngineSession(options) {
    // ===== Construction ==========
    const emitter = new EventEmitter();

    const executablePath = options.executablePath;
    const browserAudio = options.browserAudio;
    const createProcess = options.createProcess ?? createMediaEngineProcess;
    const environment = options.environment ?? process.env;

    // Initialize session and playback state
    let playbackNext = 1;
    let playbackCurrent = null;
    let metaGeneration = 0;
    let metaStarted = false;
    let metaAudioRequested = false;
    let mediaEngineProcess;
    let sourcePaths;
    let handshake;
    let handshakeResolve;
    let handshakeReject;
    let handshakeTimer;
    let metaShutdownPromise;
    let metaShuttingDown;

    // ===== Lifecycle API ==========
    async function initialize(configuration) {
        if (metaStarted) {
            throw new Error("The media engine session is already initialized");
        }

        // Begin a new generation so callbacks from an older process cannot affect setup
        metaGeneration++;
        metaAudioRequested = false;
        metaShutdownPromise = null;
        metaShuttingDown = false;
        metaStarted = true;

        // Create and configure the engine before starting renderer audio
        mediaEngineProcess = createProcess(executablePath, {
            environment
        });
        listenToProcess(metaGeneration);

        await mediaEngineProcess.start();
        ensureInitializing();
        metaStarted = true;

        await mediaEngineProcess.configureSession({
            session: configuration.session,
            p501_f1: configuration.p501_f1,
            p501_f2: configuration.p501_f2,
            audio_baseline: configuration.audio_baseline,
            audio_gain_recording: configuration.audio_gain_recording,
            audio_gain_merged: configuration.audio_gain_merged
        });
        ensureInitializing();

        sourcePaths = {
            p501_f1: configuration.p501_f1,
            p501_f2: configuration.p501_f2,
            audio_baseline: configuration.audio_baseline,
            audio_gain_recording: configuration.audio_gain_recording
        };

        // Register both engine readiness conditions before starting renderer audio
        handshake = {
            connected: false,
            microphoneReceived: false
        };
        const engineReady = new Promise((resolve, reject) => {
            handshakeResolve = resolve;
            handshakeReject = reject;
            handshakeTimer = setTimeout(() => reject(new Error("Local WebRTC setup timed out")), handshakeTimeoutMs);
        });

        metaAudioRequested = true;
        const rendererReady = browserAudio.start(configuration.settings);

        // Both renderer setup and engine microphone reception must complete
        try {
            await Promise.all([engineReady, rendererReady]);
        }
        finally {
            clearTimeout(handshakeTimer);
            handshakeResolve = null;
            handshakeReject = null;
        }
    }

    function shutdown() {
        if (!metaShutdownPromise) {
            metaShuttingDown = true;
            metaShutdownPromise = Promise.resolve().then(() => performShutdown());
        }
        return metaShutdownPromise;
    }

    // ===== WebRTC API ==========
    async function setRemoteOffer(offer) {
        return mediaEngineProcess.request("webrtc_remote_offer_set", { sdp: offer.sdp });
    }

    async function addRemoteIceCandidate(candidate) {
        return mediaEngineProcess.request("webrtc_remote_ice_candidate_add", candidate);
    }

    function rendererAudioFailed(message) {
        handleFailure(new Error(message));
    }

    // ===== Gain API ==========
    function setHeadphoneGain(value) {
        return runMediaOperation("setHeadphoneGain", value);
    }

    function setRecordingGain(value) {
        return runMediaOperation("setRecordingGain", value);
    }

    // ===== Playback API ==========
    async function startPlayback(source) {
        await stopPlayback();
        ensureInitializing();

        const id = `playback-${playbackNext++}`;
        playbackCurrent = { id };

        try {
            await mediaEngineProcess.startPlayback(source, id);
        }
        catch (error) {
            if (playbackCurrent && playbackCurrent.id === id) handleFailure(error);
            throw error;
        }
    }

    async function stopPlayback() {
        if (!playbackCurrent) return;

        // Detach playback before stopping so late completion callbacks cannot settle it
        const generation = metaGeneration;
        const playback = playbackCurrent;
        playbackCurrent = null;

        if (playback.reject != null) {
            playback.reject(new Error("Playback was stopped"));
        }

        try {
            await mediaEngineProcess.stopPlayback();
        }
        catch (error) {
            // Tolerate playbackStopFailed during cleanup
            // Other failures must not interrupt a replacement session
            if (error.code !== "playbackStopFailed") {
                if (generation === metaGeneration) handleFailure(error);
                throw error;
            }
        }
    }

    async function playToCompletion(source) {
        await stopPlayback();
        ensureInitializing();

        const id = `rating-${playbackNext++}`;
        let timer;

        const completion = new Promise((resolve, reject) => {
            playbackCurrent = { id, resolve, reject };
        });

        // Observe early rejection during startup without replacing the awaited promise
        completion.catch(() => {});

        // Bound playback completion including the renderer output drain
        try {
            await mediaEngineProcess.startPlayback(source, id);
            const timeoutMs = await playbackDeadline(source);

            timer = setTimeout(() => {
                if (playbackCurrent != null && playbackCurrent.id === id) {
                    handleFailure(new Error(`Playback ${id} did not finish`));
                }
            }, timeoutMs);

            await completion;
        }
        catch (error) {
            if (playbackCurrent != null && playbackCurrent.id === id) {
                handleFailure(error);
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }

    // ===== Recording API ==========
    function startAudioBaseline() {
        return runMediaOperation("startAudioBaseline");
    }

    function stopAudioBaseline() {
        return runMediaOperation("stopAudioBaseline");
    }

    function renderAudioGainRecording() {
        return runMediaOperation("renderAudioGainRecording");
    }

    // ################################################
    // ############ PRIVATE HELPERS ###################
    // ################################################
    // ===== Initialization and Event Helpers ==========
    function ensureInitializing() {
        if (metaShuttingDown) {
            throw new Error("Media session stopped during setup");
        }
    }

    function listenToProcess(generation) {
        const on = (event, handler) => {
            mediaEngineProcess.on(event, (payload) => {
                if (generation === metaGeneration) handler(payload);
            });
        };
        mediaEngineProcess.on("log", (message) => process.stderr.write(message));

        on("webrtc_ice_candidate", (candidate) => {
            browserAudio.addIceCandidate(candidate).catch((error) => {
                if (generation === metaGeneration) handleFailure(error);
            });
        });

        on("webrtc_connected", () => {
            if (handshake) {
                handshake.connected = true;
                finishHandshake();
            }
        });

        on("webrtc_microphone_received", () => {
            if (handshake) {
                handshake.microphoneReceived = true;
                finishHandshake();
            }
        });

        on("webrtc_disconnected", () => {
            handleFailure(new Error("The media engine WebRTC connection disconnected"));
        });

        on("playback_finished", (boundary) => {
            const playback = playbackCurrent;

            // Ignore duplicate or superseded completion events
            if (!playback || playback.id !== boundary.playback_id || playback.draining) return;
            playback.draining = true;

            browserAudio.waitForPlayback(boundary).then(
                () => {
                    // Ignore stale drain callbacks from an older session or playback
                    if (generation !== metaGeneration || playbackCurrent !== playback) return;
                    playbackCurrent = null;

                    process.stderr.write(`Playback finished: ${playback.id}\n`);
                    if (playback.resolve != null) playback.resolve();
                },
                (error) => {
                    // An older drain failure must not interrupt replacement playback
                    if (generation !== metaGeneration || playbackCurrent !== playback) return;
                    handleFailure(error);
                }
            );
        });

        on("fatal_error", (payload) => {
            handleFailure(new Error(payload.message ?? "Media engine reported a fatal error"));
        });

        on("protocolError", (error) => handleFailure(error));

        on("unexpectedExit", ({ code, signal }) => {
            handleFailure(new Error(`Media engine exited unexpectedly (${code ?? signal})`));
        });
    }

    function finishHandshake() {
        if (handshake.connected && handshake.microphoneReceived) {
            if (handshakeResolve != null) {
                handshakeResolve();
            }
        }
    }

    // ===== Operation and Failure Helpers ==========
    async function runMediaOperation(method, ...args) {
        if (!metaStarted || metaShuttingDown) {
            throw new Error("The media session is not active");
        }

        const generation = metaGeneration;
        const engine = mediaEngineProcess;

        try {
            return await engine[method](...args);
        }
        catch (error) {
            if (generation === metaGeneration && !metaShuttingDown) handleFailure(error);
            throw error;
        }
    }

    function handleFailure(error) {
        if (metaShuttingDown) return;

        if (handshakeReject != null) {
            handshakeReject(error);
        }
        if (playbackCurrent != null && playbackCurrent.reject != null) {
            playbackCurrent.reject(error);
        }

        playbackCurrent = null;
        emitter.emit("failure", error);
    }

    // ===== Playback Helpers ==========
    async function playbackDeadline(source) {
        // Estimate duration assuming mono 48 kHz 16 bit PCM at 96 bytes per millisecond
        // Subtract an assumed 44 byte WAV header without validating or parsing WAV chunks
        try {
            const file = await stat(sourcePaths[source]);
            const pcmDurationMs = Math.max(0, file.size - 44) / 96;
            return Math.max(30000, pcmDurationMs * 2 + 15000);
        }
        catch {
            return 600000;
        }
    }

    // ===== Shutdown Helpers ==========
    async function performShutdown() {
        metaShuttingDown = true;
        clearTimeout(handshakeTimer);

        if (handshakeReject != null) {
            handshakeReject(new Error("Media session stopped during setup"));
        }
        if (playbackCurrent != null && playbackCurrent.reject) {
            playbackCurrent.reject(new Error("Media session stopped during playback"));
        }
        playbackCurrent = null;

        const operations = [];
        if (mediaEngineProcess) operations.push(mediaEngineProcess.shutdown());
        if (metaAudioRequested) operations.push(browserAudio.stop());

        try {
            const results = await Promise.allSettled(operations);
            const failure = results.find((result) => result.status === "rejected");

            if (failure) {
                throw failure.reason;
            }
        }
        finally {
            metaAudioRequested = false;
            metaStarted = false;
            handshake = null;
        }
    }

    return Object.assign(emitter, {
        initialize,
        shutdown,
        setRemoteOffer,
        addRemoteIceCandidate,
        rendererAudioFailed,
        setHeadphoneGain,
        setRecordingGain,
        startPlayback,
        stopPlayback,
        playToCompletion,
        startAudioBaseline,
        stopAudioBaseline,
        renderAudioGainRecording
    });
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createMediaEngineSession };
