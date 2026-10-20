// ################################################
// ############ PUBLIC API ########################
// ################################################
// ===== Reference Data ==========
const stimuliRatingNames = ["p501_f2", "audio_gain_recording"];
const stimuliByLanguage = {
    en: {
        female: {
            p501_f1: "P501_C_english_f1_FB_48k.wav",
            p501_f2: "P501_C_english_f2_FB_48k.wav"
        },
        male: {
            p501_f1: "P501_C_english_m1_FB_48k.wav",
            p501_f2: "P501_C_english_m2_FB_48k.wav"
        }
    },
    de: {
        female: {
            p501_f1: "P501_C_german_f1_FB_48k.wav",
            p501_f2: "P501_C_german_f2_FB_48k.wav"
        },
        male: {
            p501_f1: "P501_C_german_m1_FB_48k.wav",
            p501_f2: "P501_C_german_m2_FB_48k.wav"
        }
    }
};

// ===== Primitive Operations ==========
function resolveStimuli(language, gender) {
    if (language !== "en" && language !== "de") {
        throw new TypeError("Session language must be en or de");
    }
    if (gender !== "female" && gender !== "male") {
        throw new TypeError("Session gender must be female or male");
    }

    return stimuliByLanguage[language][gender];
}

function validateGain(kind, value) {
    const maximum = kind === "recording" ? 2 : 1;

    if (kind !== "headphone" && kind !== "recording") {
        throw new TypeError("Gain kind must be headphone or recording");
    }
    if (!Number.isFinite(value) || value < 0 || value > maximum) {
        throw new TypeError(`Gain must be a finite number from 0 to ${maximum} for ${kind}`);
    }
}

function validateRating(value) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw new TypeError("Rating must be an integer from 1 to 5");
    }
}

// ===== Composite Validation ==========
function validateSettings(settings) {
    if (!settings || typeof settings !== "object") {
        throw new TypeError("Session settings are required");
    }

    resolveStimuli(settings.language, settings.gender);

    if (typeof settings.inputDeviceId !== "string" || settings.inputDeviceId.length === 0) {
        throw new TypeError("An input device is required");
    }
    if (typeof settings.outputDeviceId !== "string" || settings.outputDeviceId.length === 0) {
        throw new TypeError("An output device is required");
    }
    if (typeof settings.inputDeviceName !== "string" || settings.inputDeviceName.trim().length === 0) {
        throw new TypeError("An input device name is required");
    }
    if (typeof settings.outputDeviceName !== "string" || settings.outputDeviceName.trim().length === 0) {
        throw new TypeError("An output device name is required");
    }
}

function validateFinalMetadata(metadata) {
    const stimuli = resolveStimuli(metadata.language, metadata.gender);

    if (typeof metadata.input_device !== "string" || metadata.input_device.trim().length === 0) {
        throw new TypeError("Final metadata requires an input device name");
    }
    if (typeof metadata.output_device !== "string" || metadata.output_device.trim().length === 0) {
        throw new TypeError("Final metadata requires an output device name");
    }
    if (typeof metadata.session !== "string" || metadata.session.length === 0) {
        throw new TypeError("Final metadata requires a session identifier");
    }
    if (metadata.headphone_stimulus !== stimuli.p501_f1 || metadata.reference_stimulus !== stimuli.p501_f2) {
        throw new TypeError("Final metadata contains invalid stimulus names");
    }

    validateGain("headphone", metadata.headphone_playback_gain);
    validateGain("recording", metadata.recording_playback_gain);

    if (metadata.audio_baseline !== "audio_baseline.wav" || metadata.audio_gain_recording !== "audio_gain_recording.wav" || metadata.audio_gain_merged !== "audio_gain_merged.wav") {
        throw new TypeError("Final metadata contains invalid recording filenames");
    }
    if (!Array.isArray(metadata.ratings) || metadata.ratings.length !== stimuliRatingNames.length) {
        throw new TypeError(`Final metadata requires exactly ${stimuliRatingNames.length} ratings`);
    }

    const stimulusNames = metadata.ratings.map(({ stimulus }) => stimulus).sort();
    if (stimulusNames.join(",") !== [...stimuliRatingNames].sort().join(",")) {
        throw new TypeError("Final metadata contains invalid rating stimuli");
    }

    metadata.ratings.forEach((rating, index) => {
        if (rating.order !== index + 1) {
            throw new TypeError("Final metadata contains invalid rating order");
        }
        validateRating(rating.response);
    });
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { resolveStimuli, stimuliByLanguage, stimuliRatingNames, validateFinalMetadata, validateGain, validateRating, validateSettings };
