import { resolveStimuli, stimuliRatingNames, validateFinalMetadata, validateGain, validateRating } from "./validation.js";

// ################################################
// ############ PUBLIC API ########################
// ################################################
const initialGain = 0.1;

function createSessionModel() {
    let state = createParticipantState();
    let metadata = null;
    let ratingOrder = [];

    // ===== State API ==========
    function snapshot() {
        return { ...state };
    }

    function update(values) {
        // Do not carry the waiting state from the previous view into the next view
        if (values.flowViewCurrent && values.flowViewCurrent !== state.flowViewCurrent) {
            values = { flowBusy: false, ...values };
        }
        Object.assign(state, values);

        return snapshot();
    }

    // ===== Setup API ==========
    function initializeMetadata(session, settings) {
        const stimuli = resolveStimuli(settings.language, settings.gender);
        metadata = {
            session,
            ratings: [],
            language: settings.language,
            gender: settings.gender,
            input_device: settings.inputDeviceName,
            output_device: settings.outputDeviceName,
            headphone_stimulus: stimuli.p501_f1,
            reference_stimulus: stimuli.p501_f2,
            headphone_playback_gain: null,
            recording_playback_gain: null
        };

        return stimuli;
    }

    function getMetadata() {
        if (!metadata) return null;
        return { ...metadata, ratings: metadata.ratings.map((rating) => ({ ...rating })) };
    }

    function completeStartup(session) {
        ratingOrder = Math.random() < 0.5 ? [...stimuliRatingNames] : [...stimuliRatingNames].reverse();

        return update({
            sessionId: session,
            flowViewCurrent: "viewHeadphoneCalibration",
            flowBusy: false,
            mediaPlaybackGainHeadphone: initialGain,
            mediaPlaybackState: "playing"
        });
    }

    function resetSetupFailure() {
        const { sessionLanguage, sessionGender } = state;

        state = createParticipantState();
        metadata = null;
        ratingOrder = [];

        return update({
            flowViewCurrent: "viewSettings",
            sessionLanguage,
            sessionGender
        });
    }

    // ===== Calibration API ==========
    function confirmGain(kind, value) {
        validateGain(kind, value);
        metadata[kind === "headphone" ? "headphone_playback_gain" : "recording_playback_gain"] = value;
    }

    function acknowledgeVolumeWarning() {
        if (!state.flowVolumeWarningOpen) {
            throw new Error("The volume warning is not open");
        }

        return update({
            flowViewCurrent: "viewMicrophoneRecording",
            flowVolumeWarningOpen: false,
            mediaPlaybackState: "idle"
        });
    }

    // ===== Recording API ==========
    function validateRecordingStart(actionType) {
        if (state.mediaRecordingState === "recording" || (actionType === "rerecordMicrophone" && state.mediaRecordingState !== "complete")) {
            throw new Error("A recording cannot be started now");
        }
    }

    function clearAudioBaseline() {
        delete metadata.audio_baseline;
    }

    function validateRecordingStop() {
        if (state.mediaRecordingState !== "recording") {
            throw new Error("No recording is active");
        }
    }

    function finalizeAudioBaseline() {
        metadata.audio_baseline = "audio_baseline.wav";
    }

    function validateRecordingContinuation() {
        if (state.mediaRecordingState !== "complete") {
            throw new Error("A finalized recording is required");
        }
    }

    function finalizeAudioGainRecording() {
        metadata.audio_gain_recording = "audio_gain_recording.wav";
        metadata.audio_gain_merged = "audio_gain_merged.wav";
    }

    // ===== Rating API ==========
    function startRatingTrial(index = state.flowRatingTrialIndex) {
        return update({
            flowViewCurrent: "viewRatingMain",
            flowBusy: true,
            flowRatingTrialIndex: index,
            flowRatingSaveFailed: false,
            flowRatingPlaybackComplete: false
        });
    }

    function ratingSource() {
        return ratingOrder[state.flowRatingTrialIndex];
    }

    function prepareRating(response, trialIndex) {
        validateRating(response);

        if (!Number.isInteger(trialIndex) || trialIndex !== state.flowRatingTrialIndex || trialIndex < 0 || trialIndex >= ratingOrder.length) {
            throw new Error("The rating trial index is not current");
        }
        if (!state.flowRatingPlaybackComplete) {
            throw new Error("The rating stimulus must finish before a response is submitted");
        }
        if (metadata.ratings.length !== trialIndex || metadata.ratings.some((rating, index) => rating.order !== index + 1 || rating.stimulus !== ratingOrder[index])) {
            throw new Error("The rating trial does not follow the accepted ratings");
        }

        // Keep accepted ratings unchanged until the caller persists and commits this candidate
        const candidate = getMetadata();
        const order = trialIndex + 1;
        const nextTrial = order < ratingOrder.length ? order : null;

        candidate.ratings.push({ stimulus: ratingSource(), order, response });

        if (nextTrial === null) {
            validateFinalMetadata(candidate);
        }

        return { candidate, trialIndex, nextTrial };
    }

    function commitRating(prepared) {
        if (prepared.trialIndex !== state.flowRatingTrialIndex || metadata.ratings.length !== prepared.trialIndex) {
            throw new Error("The prepared rating is no longer current");
        }
        metadata = { ...prepared.candidate, ratings: prepared.candidate.ratings.map((rating) => ({ ...rating })) };
    }

    // ===== Interruption API ==========
    function interrupt() {
        return update({
            flowViewCurrent: "viewInterrupted",
            flowBusy: false,
            flowVolumeWarningOpen: false,
            flowRatingSaveFailed: false,
            flowRatingPlaybackComplete: false,
            mediaPlaybackState: "idle",
            mediaRecordingState: "idle"
        });
    }

    return {
        snapshot,
        update,
        initializeMetadata,
        getMetadata,
        completeStartup,
        resetSetupFailure,
        confirmGain,
        acknowledgeVolumeWarning,
        validateRecordingStart,
        clearAudioBaseline,
        validateRecordingStop,
        finalizeAudioBaseline,
        validateRecordingContinuation,
        finalizeAudioGainRecording,
        startRatingTrial,
        ratingSource,
        prepareRating,
        commitRating,
        interrupt
    };
}

// ################################################
// ############ PRIVATE HELPERS ###################
// ################################################
function createParticipantState() {
    return {
        sessionId: null,
        sessionLanguage: "en",
        sessionGender: "female",
        flowViewCurrent: "viewWelcome",
        flowBusy: false,
        flowVolumeWarningOpen: false,
        flowRatingTrialIndex: 0,
        flowRatingTrialCount: stimuliRatingNames.length,
        flowRatingPlaybackComplete: false,
        flowRatingSaveFailed: false,
        mediaPlaybackGainHeadphone: null,
        mediaPlaybackGainRecording: null,
        mediaPlaybackState: "idle",
        mediaRecordingState: "idle"
    };
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createSessionModel, initialGain };
