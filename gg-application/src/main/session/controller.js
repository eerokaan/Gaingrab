import { createSessionModel, initialGain } from "./model.js";
import { resolveStimuli, validateGain, validateSettings } from "./validation.js";
import { EventEmitter } from "node:events";
import { join } from "node:path";

// ################################################
// ############ PUBLIC API ########################
// ################################################
function createSessionController(options) {
    // ===== Construction ==========
    const emitter = new EventEmitter();
    const model = createSessionModel();

    const { media, store, stimuliDirectory } = options;
    const recordingActions = new Set(["startMicrophoneRecording", "rerecordMicrophone", "stopMicrophoneRecording"]);

    let lifecycle = "idle";
    let sessionPaths = null;
    let startup = null;
    let currentAction = null;
    let stopPromise = null;
    let shutdownPromise = null;
    let interruptionCause = null;
    let drainingRecording = false;

    // ===== Action Definitions ==========
    const actionDefinitions = {
        confirmWelcome: {
            view: "viewWelcome",
            run: (action) => update({ flowViewCurrent: "viewSettings", sessionLanguage: action.language, sessionGender: action.gender, flowBusy: true })
        },
        commitHeadphoneGain: {
            view: "viewHeadphoneCalibration",
            gainType: "headphone",
            run: (action, operation) => commitGain(operation, "headphone", action.value)
        },
        replayHeadphoneGain: {
            view: "viewHeadphoneCalibration",
            run: (action, operation) => restartPlayback(operation, "p501_f1")
        },
        confirmHeadphoneGain: {
            view: "viewHeadphoneCalibration",
            gainType: "headphone",
            run: (action, operation) => confirmHeadphoneGain(operation, action.value)
        },
        acknowledgeVolumeWarning: {
            view: "viewHeadphoneCalibration",
            run: () => publish(model.acknowledgeVolumeWarning())
        },
        startMicrophoneRecording: {
            view: "viewMicrophoneRecording",
            run: (action, operation) => startRecording(operation, action.type)
        },
        stopMicrophoneRecording: {
            view: "viewMicrophoneRecording",
            run: (action, operation) => stopRecording(operation)
        },
        replayMicrophoneRecording: {
            view: "viewMicrophoneRecording",
            run: (action, operation) => {
                model.validateRecordingContinuation();
                return restartPlayback(operation, "audio_baseline_replay");
            }
        },
        rerecordMicrophone: {
            view: "viewMicrophoneRecording",
            run: (action, operation) => startRecording(operation, action.type)
        },
        continueMicrophoneRecording: {
            view: "viewMicrophoneRecording",
            run: (action, operation) => continueFromRecording(operation)
        },
        commitRecordedVoiceGain: {
            view: "viewRecordingAdjustment",
            gainType: "recording",
            run: (action, operation) => commitGain(operation, "recording", action.value)
        },
        replayRecordedVoice: {
            view: "viewRecordingAdjustment",
            run: (action, operation) => restartPlayback(operation, "audio_baseline")
        },
        confirmRecordedVoiceGain: {
            view: "viewRecordingAdjustment",
            gainType: "recording",
            run: (action, operation) => confirmRecordingGain(operation, action.value)
        },
        continueToRatingTrials: {
            view: "viewRatingInstructions",
            run: (action, operation) => startRatingTrial(operation)
        },
        playRatingTrial: {
            view: "viewRatingMain",
            run: (action, operation) => playRatingTrial(operation)
        },
        submitRating: {
            view: "viewRatingMain",
            run: (action, operation) => submitRating(operation, action.response, action.trialIndex)
        }
    };

    // ===== Session API ==========
    function snapshot() {
        return model.snapshot();
    }

    // Register identity and promises before any side effect can synchronously reenter us
    function start(settings) {
        const state = snapshot();
        if (lifecycle !== "idle" || startup || currentAction || state.flowViewCurrent !== "viewSettings" || state.flowBusy) {
            return Promise.reject(new Error("A session can only be started from Settings"));
        }

        settings = { ...settings };
        validateSettings(settings);

        if (settings.language !== state.sessionLanguage || settings.gender !== state.sessionGender) {
            throw new TypeError("Session selectors must match the confirmed Welcome language and gender");
        }

        const attempt = { cancelled: false, error: null, promise: null };
        lifecycle = "starting";
        stopPromise = null;
        startup = attempt;
        attempt.promise = Promise.resolve().then(() => performStart(attempt, settings));

        const clear = () => {
            if (startup === attempt) {
                startup = null;
            }
        };

        attempt.promise.then(clear, clear);
        update({ flowBusy: true, flowRatingSaveFailed: false });

        return attempt.promise;
    }

    function dispatch(action) {
        const state = snapshot();
        if ((lifecycle !== "idle" && lifecycle !== "active") || currentAction || state.flowBusy) {
            return Promise.reject(new Error("Participant actions are currently unavailable"));
        }

        let definition;

        if (action && typeof action.type === "string" && Object.hasOwn(actionDefinitions, action.type)) {
            definition = actionDefinitions[action.type];
        }
        if (!definition || definition.view !== state.flowViewCurrent) {
            return Promise.reject(new Error(`Action ${action ? action.type : "unknown"} is not valid in this view`));
        }

        try {
            action = { ...action };
            if (action.type === "confirmWelcome") resolveStimuli(action.language, action.gender);
            if (definition.gainType) validateGain(definition.gainType, action.value);
        }
        catch (error) {
            return Promise.reject(error);
        }

        const operation = { type: action.type, promise: null };
        currentAction = operation;
        operation.promise = Promise.resolve().then(() => performDispatch(operation, action, definition));

        const clear = () => {
            if (currentAction === operation) currentAction = null;
        };

        operation.promise.then(clear, clear);
        update({ flowBusy: true });

        return operation.promise;
    }

    function handleMediaFailure(error) {
        if (lifecycle === "starting") {
            if (!startup.error) startup.error = error;
            startup.cancelled = true;
            return stopMedia();
        }

        if (lifecycle === "interrupted") return stopPromise;
        if (lifecycle !== "active" && lifecycle !== "finalizing") return;

        interruptionCause = error;
        lifecycle = "interrupted";

        const cleanup = stopMedia();
        report("Session interrupted", interruptionCause);
        publish(model.interrupt());

        return cleanup;
    }

    function handleRendererLoss(error = new Error("The renderer document was replaced")) {
        return handleMediaFailure(error);
    }

    function shutdown() {
        if (shutdownPromise) return shutdownPromise;

        const previous = lifecycle;
        drainingRecording = previous === "active" && !interruptionCause && (snapshot().mediaRecordingState === "recording" || (currentAction && recordingActions.has(currentAction.type)));
        lifecycle = "closing";

        if (startup && previous === "starting") startup.cancelled = true;
        shutdownPromise = Promise.resolve().then(() => performShutdown(previous));
        if (previous !== "completed" && previous !== "interrupted") update({ flowBusy: true });

        return shutdownPromise;
    }

    function stopMedia() {
        if (!stopPromise) {
            if (lifecycle === "closing") drainingRecording = false;
            stopPromise = Promise.resolve().then(() => media.shutdown());
            stopPromise.catch((error) => report("Session media cleanup failed", error));
        }

        return stopPromise;
    }

    // ################################################
    // ############ PRIVATE HELPERS ###################
    // ################################################
    // ===== State and Reporting Helpers ==========
    function update(values) {
        publish(model.update(values));
    }

    function publish(state) {
        emitter.emit("state", state);
    }

    function report(message, error) {
        (options.logError ?? console.error)(`${message} (session ${snapshot().sessionId ?? "setup"})`, error);
    }

    // ===== Operation Guards ==========
    function actionActive(operation) {
        return currentAction === operation && (lifecycle === "idle" || lifecycle === "active");
    }

    function ensureAction(operation) {
        if (actionActive(operation)) return;
        if (currentAction === operation && lifecycle === "closing" && drainingRecording && recordingActions.has(operation.type)) return;
        throw new Error("Participant action was cancelled");
    }

    function updateAction(operation, values) {
        ensureAction(operation);
        if (lifecycle === "closing") model.update(values);
        else update(values);
    }

    function ensureStartup(attempt) {
        if (attempt.error) {
            throw attempt.error;
        }
        if (startup !== attempt || attempt.cancelled || lifecycle !== "starting") {
            throw new Error("Session startup was cancelled");
        }
    }

    // ===== Startup Helpers ==========
    async function performStart(attempt, settings) {
        try {
            // Build date string
            ensureStartup(attempt);

            const dateNow = new Date();
            const dateParts = [dateNow.getFullYear(), dateNow.getMonth() + 1, dateNow.getDate(), dateNow.getHours(), dateNow.getMinutes(), dateNow.getSeconds()];

            for (let dateIndex = 0; dateIndex < dateParts.length; dateIndex++) {
                dateParts[dateIndex] = String(dateParts[dateIndex]).padStart(dateIndex === 0 ? 4 : 2, "0");
            }

            const dateSession = dateParts.join("-");

            sessionPaths = await store.create(dateSession);

            // Resolve the selected stimuli and persist the initial session metadata
            ensureStartup(attempt);
            const stimuli = model.initializeMetadata(dateSession, settings);
            await store.write(model.getMetadata());

            // Initialize media with the selected stimuli and session recording paths
            ensureStartup(attempt);

            await media.initialize({
                settings,
                session: dateSession,
                p501_f1: join(stimuliDirectory, stimuli.p501_f1),
                p501_f2: join(stimuliDirectory, stimuli.p501_f2),
                audio_baseline: sessionPaths.audioBaseline,
                audio_gain_recording: sessionPaths.audioGainRecording,
                audio_gain_merged: sessionPaths.audioGainMerged
            });

            // Apply the initial headphone gain before calibration playback
            ensureStartup(attempt);
            await media.setHeadphoneGain(initialGain);

            // Start playback of the headphone calibration stimulus
            ensureStartup(attempt);
            await media.startPlayback("p501_f1");

            // Activation precedes publication even while this startup promise is unsettled
            ensureStartup(attempt);
            attempt.activated = true;
            lifecycle = "active";
            publish(model.completeStartup(dateSession));

            return snapshot();
        }
        catch (error) {
            report("Session setup failed", error);

            if (!attempt.activated) await cleanupSetup(attempt);
            throw error;
        }
    }

    // Roll back failed setup without replacing the original error
    async function cleanupSetup(attempt) {
        try {
            await stopMedia();
        }
        catch {
            // Keep the original setup error; stopMedia already logged the cleanup error
        }

        try {
            await store.remove();
        }
        catch (error) {
            report("Session setup rollback failed", error);
        }

        if (startup !== attempt) return;
        sessionPaths = null;

        if (lifecycle === "starting") {
            lifecycle = "idle";
            publish(model.resetSetupFailure());
        }
    }

    // ===== Participant Action Helpers ==========
    async function performDispatch(operation, action, definition) {
        try {
            ensureAction(operation);
            await definition.run(action, operation);
        }
        finally {
            if (actionActive(operation)) update({ flowBusy: false });
        }

        return snapshot();
    }

    async function stopPlayback(operation) {
        ensureAction(operation);

        if (snapshot().mediaPlaybackState === "playing") {
            await media.stopPlayback();
            updateAction(operation, { mediaPlaybackState: "idle" });
        }
    }

    async function restartPlayback(operation, source) {
        await stopPlayback(operation);
        ensureAction(operation);

        await media.startPlayback(source);
        updateAction(operation, { mediaPlaybackState: "playing" });
    }

    async function commitGain(operation, kind, value) {
        validateGain(kind, value);
        await stopPlayback(operation);

        ensureAction(operation);
        if (kind === "headphone") {
            await media.setHeadphoneGain(value);
            updateAction(operation, { mediaPlaybackGainHeadphone: value });
            await restartPlayback(operation, "p501_f1");
        }
        else {
            await media.setRecordingGain(value);
            updateAction(operation, { mediaPlaybackGainRecording: value });
            await restartPlayback(operation, "audio_baseline");
        }
    }

    async function confirmHeadphoneGain(operation, value) {
        validateGain("headphone", value);
        await stopPlayback(operation);

        ensureAction(operation);
        await media.setHeadphoneGain(value);

        ensureAction(operation);
        model.confirmGain("headphone", value);

        await store.write(model.getMetadata());
        updateAction(operation, { mediaPlaybackGainHeadphone: value, flowVolumeWarningOpen: true });
    }

    async function startRecording(operation, actionType) {
        model.validateRecordingStart(actionType);
        await stopPlayback(operation);

        ensureAction(operation);
        if (actionType === "rerecordMicrophone") {
            model.clearAudioBaseline();
            await store.write(model.getMetadata());
            ensureAction(operation);
        }

        await media.startAudioBaseline();
        updateAction(operation, { mediaRecordingState: "recording" });
    }

    async function stopRecording(operation) {
        model.validateRecordingStop();
        await media.stopAudioBaseline();

        ensureAction(operation);
        model.finalizeAudioBaseline();

        // Native acknowledgement must survive healthy close without participant advancement
        model.update({ mediaRecordingState: "complete" });
        await store.write(model.getMetadata());
        updateAction(operation, { mediaRecordingState: "complete" });

        // Healthy close may drain the save but must not start a new preview
        if (!actionActive(operation)) return;
        await media.startPlayback("audio_baseline_replay");
        updateAction(operation, { mediaPlaybackState: "playing" });
    }

    async function continueFromRecording(operation) {
        model.validateRecordingContinuation();
        await stopPlayback(operation);

        ensureAction(operation);
        await media.setRecordingGain(initialGain);

        ensureAction(operation);
        await media.startPlayback("audio_baseline");

        updateAction(operation, {
            flowViewCurrent: "viewRecordingAdjustment",
            flowBusy: true,
            mediaPlaybackGainRecording: initialGain,
            mediaPlaybackState: "playing"
        });
    }

    async function confirmRecordingGain(operation, value) {
        validateGain("recording", value);
        await stopPlayback(operation);

        ensureAction(operation);
        await media.setRecordingGain(value);

        ensureAction(operation);
        model.confirmGain("recording", value);
        await store.write(model.getMetadata());

        ensureAction(operation);
        await media.renderAudioGainRecording();

        ensureAction(operation);
        model.finalizeAudioGainRecording();
        await store.write(model.getMetadata());

        updateAction(operation, {
            flowViewCurrent: "viewRatingInstructions",
            flowBusy: true,
            mediaPlaybackGainRecording: value,
            mediaPlaybackState: "idle"
        });
    }

    async function startRatingTrial(operation, index) {
        ensureAction(operation);
        publish(model.startRatingTrial(index));
        await playRatingTrial(operation);
    }

    async function playRatingTrial(operation) {
        ensureAction(operation);
        update({ mediaPlaybackState: "playing", flowRatingPlaybackComplete: false });

        try {
            ensureAction(operation);
            await media.playToCompletion(model.ratingSource());

            updateAction(operation, { flowRatingPlaybackComplete: true });
        }
        catch (error) {
            if (actionActive(operation)) handleMediaFailure(error);
            throw error;
        }
        finally {
            if (actionActive(operation)) update({ mediaPlaybackState: "idle" });
        }
    }

    async function submitRating(operation, response, trialIndex) {
        const prepared = model.prepareRating(response, trialIndex);
        update({ flowRatingSaveFailed: false });
        ensureAction(operation);

        try {
            await store.write(prepared.candidate);
        }
        catch (error) {
            if (actionActive(operation)) update({ flowRatingSaveFailed: true });
            report("Rating checkpoint failed", error);
            throw error;
        }

        ensureAction(operation);
        model.commitRating(prepared);

        if (prepared.nextTrial !== null) {
            await startRatingTrial(operation, prepared.nextTrial);
            return;
        }

        lifecycle = "finalizing";
        try {
            await stopMedia();
        }
        catch (error) {
            handleMediaFailure(error);
            throw error;
        }

        if (lifecycle !== "finalizing") return;
        lifecycle = "completed";

        update({ flowViewCurrent: "viewEnding", flowBusy: false, flowRatingSaveFailed: false, mediaPlaybackState: "idle" });
    }

    // ===== Shutdown Helpers ==========
    async function settle(operation) {
        if (!operation) return;

        try {
            await operation.promise;
        }
        catch {
            // The caller owns the operation error; close still drains it and cleans up
        }
    }

    async function performShutdown(previous) {
        if (!drainingRecording) stopMedia();
        if (previous === "starting") await settle(startup);

        await settle(currentAction);

        try {
            if (drainingRecording && snapshot().mediaRecordingState === "recording") {
                await media.stopAudioBaseline();

                if (!drainingRecording) {
                    throw new Error("Recording finalization was cancelled during shutdown");
                }

                model.finalizeAudioBaseline();
                model.update({ mediaRecordingState: "complete" });

                await store.write(model.getMetadata());
            }
        }
        finally {
            await stopMedia();
        }
    }

    return Object.assign(emitter, { snapshot, start, dispatch, handleMediaFailure, handleRendererLoss, shutdown, stopMedia });
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createSessionController };
