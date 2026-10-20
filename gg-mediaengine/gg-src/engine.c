/*
 * Gaingrab Media Engine
 * @company Quality and Usability Lab | TU Berlin
 * @author  Eero Kaan <eerokaan@qu.tu-berlin.de>
 */

#include <math.h>
#include <string.h>
#include "engine.h"
#include "media.h"

typedef struct {
    Engine* engine;
    gdouble request_id;
} AnswerRequest;

typedef struct {
    Engine* engine;
    gdouble request_id;
    const gchar* error_code;
} CompletionRequest;

struct Engine {
    GMainLoop* loop;
    Control* control;
    Media* media;
    gboolean shutting_down;
    gboolean failed;
};

static cJSON* create_response(const cJSON* request_id, gboolean ok) {
    cJSON* response = cJSON_CreateObject();
    cJSON_AddStringToObject(response, "type", "response");

    if (request_id == NULL) {
        cJSON_AddNullToObject(response, "id");
    } else {
        cJSON_AddNumberToObject(response, "id", request_id->valuedouble);
    }

    cJSON_AddBoolToObject(response, "ok", ok);
    return response;
}

static void send_error(Engine* engine, const cJSON* request_id, const gchar* code, const gchar* message) {
    cJSON* response = create_response(request_id, FALSE);
    cJSON* error = cJSON_CreateObject();

    cJSON_AddStringToObject(error, "code", code);
    cJSON_AddStringToObject(error, "message", message);
    cJSON_AddItemToObject(response, "error", error);

    control_send(engine->control, response);
    cJSON_Delete(response);
}

static void send_success(Engine* engine, const cJSON* request_id) {
    cJSON* response = create_response(request_id, TRUE);
    cJSON_AddObjectToObject(response, "payload");

    control_send(engine->control, response);
    cJSON_Delete(response);
}

static void send_success_payload(Engine* engine, gdouble request_id, cJSON* payload) {
    cJSON* id = cJSON_CreateNumber(request_id);
    cJSON* response = create_response(id, TRUE);

    cJSON_Delete(id);
    cJSON_AddItemToObject(response, "payload", payload);

    control_send(engine->control, response);
    cJSON_Delete(response);
}

static void send_event(Engine* engine, const gchar* event_name, cJSON* payload) {
    cJSON* event = cJSON_CreateObject();

    cJSON_AddStringToObject(event, "type", "event");
    cJSON_AddStringToObject(event, "event", event_name);
    cJSON_AddItemToObject(event, "payload", payload == NULL ? cJSON_CreateObject() : payload);

    control_send(engine->control, event);
    cJSON_Delete(event);
}

static void on_media_ice_candidate(guint sdp_media_index, const gchar* candidate, gpointer user_data) {
    Engine* engine = user_data;
    cJSON* payload = cJSON_CreateObject();

    cJSON_AddNumberToObject(payload, "sdpMLineIndex", sdp_media_index);
    cJSON_AddStringToObject(payload, "candidate", candidate);

    send_event(engine, "webrtc_ice_candidate", payload);
}

// clang-format off
static void on_media_event(
    const gchar* event_name,
    const gchar* detail,
    const MediaPlaybackTiming* timing,
    gpointer user_data
) {
    Engine* engine = user_data;
    cJSON* payload = NULL;

    if (detail != NULL || timing != NULL) {
        payload = cJSON_CreateObject();
    }
    if (detail != NULL) {
        cJSON_AddStringToObject(payload, "playback_id", detail);
    }
    if (timing != NULL) {
        cJSON_AddNumberToObject(payload, "rtp_timestamp", media_playback_timing_get_rtp_timestamp(timing));
        cJSON_AddNumberToObject(payload, "ssrc", media_playback_timing_get_ssrc(timing));
    }

    send_event(engine, event_name, payload);

    if (strcmp(event_name, "fatal_error") == 0) {
        engine->failed = TRUE;
        control_stop(engine->control);
        media_stop(engine->media);
        g_main_loop_quit(engine->loop);
    }
}
// clang-format on

static void on_media_answer(const gchar* sdp, const gchar* error, gpointer user_data) {
    AnswerRequest* request = user_data;
    cJSON* id = cJSON_CreateNumber(request->request_id);

    if (error != NULL) {
        send_error(request->engine, id, "webrtcNegotiationFailed", error);
    } else {
        cJSON* payload = cJSON_CreateObject();

        cJSON_AddStringToObject(payload, "type", "answer");
        cJSON_AddStringToObject(payload, "sdp", sdp);

        send_success_payload(request->engine, request->request_id, payload);
    }

    cJSON_Delete(id);
    g_free(request);
}

static void on_media_completion(const gchar* error, gpointer user_data) {
    CompletionRequest* request = user_data;
    cJSON* id = cJSON_CreateNumber(request->request_id);

    if (error == NULL) {
        send_success(request->engine, id);
    } else {
        send_error(request->engine, id, request->error_code, error);
    }

    cJSON_Delete(id);
    g_free(request);
}

// clang-format off
static gboolean valid_request_id(const cJSON* request_id) {
    return cJSON_IsNumber(request_id) &&
        request_id->valuedouble >= 0.0 &&
        floor(request_id->valuedouble) == request_id->valuedouble;
}
// clang-format on

Engine* engine_new(GMainLoop* loop) {
    Engine* engine = g_new0(Engine, 1);

    engine->loop = loop;
    return engine;
}

gboolean engine_initialize_media(Engine* engine, GMainContext* context, GError** error) {
    engine->media = media_new(context, on_media_ice_candidate, on_media_event, engine, error);
    return engine->media != NULL;
}

gboolean engine_failed(Engine* engine) {
    return engine->failed;
}

void engine_attach_control(Engine* engine, Control* control) {
    engine->control = control;
}

void engine_emit_ready(Engine* engine) {
    cJSON* event = cJSON_CreateObject();
    cJSON* payload = cJSON_CreateObject();

    cJSON_AddStringToObject(event, "type", "event");
    cJSON_AddStringToObject(event, "event", "ready");
    cJSON_AddStringToObject(payload, "version", "1.0.0");
    cJSON_AddItemToObject(event, "payload", payload);

    control_send(engine->control, event);
    cJSON_Delete(event);
}

void engine_handle_request(cJSON* request, gpointer user_data) {
    Engine* engine = user_data;
    cJSON* type;
    cJSON* request_id;
    cJSON* command;
    cJSON* payload;

    if (request == NULL) {
        media_stop(engine->media);
        g_main_loop_quit(engine->loop);
        return;
    }
    if (!cJSON_IsObject(request)) {
        send_error(engine, NULL, "invalidRequest", "Request must be a JSON object");
        return;
    }

    type = cJSON_GetObjectItemCaseSensitive(request, "type");
    request_id = cJSON_GetObjectItemCaseSensitive(request, "id");
    command = cJSON_GetObjectItemCaseSensitive(request, "command");
    payload = cJSON_GetObjectItemCaseSensitive(request, "payload");

    // Validate the request envelope and required fields
    // clang-format off
    if (
        !cJSON_IsString(type) ||
        strcmp(type->valuestring, "request") != 0 ||
        !valid_request_id(request_id) ||
        !cJSON_IsString(command) || !cJSON_IsObject(payload)
    ) {
        send_error(
            engine,
            valid_request_id(request_id) ? request_id : NULL,
            "invalidRequest",
            "Request requires type, nonnegative integer id, command, and object payload"
        );
        return;
    }
    // clang-format on

    // Shut down the media engine
    if (strcmp(command->valuestring, "mediaengine_shutdown") == 0) {
        if (engine->shutting_down) {
            send_error(engine, request_id, "alreadyShuttingDown", "Shutdown is already in progress");
            return;
        }

        engine->shutting_down = TRUE;

        send_success(engine, request_id);
        control_stop(engine->control);
        media_stop(engine->media);
        g_main_loop_quit(engine->loop);

        return;
    }

    // Configure the media paths for the session
    if (strcmp(command->valuestring, "session_configure") == 0) {
        cJSON* session = cJSON_GetObjectItemCaseSensitive(payload, "session");
        cJSON* p501_f1 = cJSON_GetObjectItemCaseSensitive(payload, "p501_f1");
        cJSON* p501_f2 = cJSON_GetObjectItemCaseSensitive(payload, "p501_f2");
        cJSON* audio_baseline = cJSON_GetObjectItemCaseSensitive(payload, "audio_baseline");
        cJSON* audio_gain_recording = cJSON_GetObjectItemCaseSensitive(payload, "audio_gain_recording");
        cJSON* audio_gain_merged = cJSON_GetObjectItemCaseSensitive(payload, "audio_gain_merged");
        GError* error = NULL;

        // clang-format off
        if (
            !cJSON_IsString(session) ||
            session->valuestring[0] == '\0' ||
            !cJSON_IsString(p501_f1) ||
            !cJSON_IsString(p501_f2) ||
            !cJSON_IsString(audio_baseline) ||
            !cJSON_IsString(audio_gain_recording) ||
            !cJSON_IsString(audio_gain_merged)
        ) {
            send_error(engine, request_id, "invalidPayload", "Session configuration requires session and five media paths");
            return;
        }
        
        if (
            !media_configure(
                engine->media,
                p501_f1->valuestring,
                p501_f2->valuestring,
                audio_baseline->valuestring,
                audio_gain_recording->valuestring,
                audio_gain_merged->valuestring, &error
            )
        ) {
            send_error(engine, request_id, "sessionConfigureFailed", error->message);
            g_clear_error(&error);
            return;
        }
        // clang-format on

        send_success(engine, request_id);
        return;
    }

    // Set the headphone or recording playback gain
    // clang-format off
    if (
        strcmp(command->valuestring, "gain_headphone_set") == 0 ||
        strcmp(command->valuestring, "gain_recording_set") == 0
    ) {
        cJSON* value = cJSON_GetObjectItemCaseSensitive(payload, "value");
        GError* error = NULL;
        gboolean success;

        if (!cJSON_IsNumber(value)) {
            send_error(engine, request_id, "invalidPayload", "Gain payload requires value");
            return;
        }

        // Apply the requested gain to the corresponding playback path.
        if (strcmp(command->valuestring, "gain_headphone_set") == 0) {
            success = media_set_headphone_gain(engine->media, value->valuedouble, &error);
        } else {
            success = media_set_recording_gain(engine->media, value->valuedouble, &error);
        }

        // Return the media-layer error if the gain could not be applied.
        if (!success) {
            send_error(engine, request_id, "gainSetFailed", error->message);
            g_clear_error(&error);
            return;
        }

        send_success(engine, request_id);
        return;
    }
    // clang-format on

    // Start playback for the requested media source
    if (strcmp(command->valuestring, "playback_start") == 0) {
        cJSON* source = cJSON_GetObjectItemCaseSensitive(payload, "source");
        cJSON* playback_id = cJSON_GetObjectItemCaseSensitive(payload, "playback_id");
        GError* error = NULL;

        if (!cJSON_IsString(source) || !cJSON_IsString(playback_id) || playback_id->valuestring[0] == '\0') {
            send_error(engine, request_id, "invalidPayload", "Playback payload requires source and playback_id");
            return;
        }
        if (!media_start_playback(engine->media, source->valuestring, playback_id->valuestring, &error)) {
            send_error(engine, request_id, "playbackStartFailed", error->message);
            g_clear_error(&error);
            return;
        }

        send_success(engine, request_id);
        return;
    }

    // Stop the active media playback
    if (strcmp(command->valuestring, "playback_stop") == 0) {
        GError* error = NULL;

        if (!media_stop_playback(engine->media, &error)) {
            send_error(engine, request_id, "playbackStopFailed", error->message);
            g_clear_error(&error);
            return;
        }

        send_success(engine, request_id);
        return;
    }

    // Start recording the microphone signal to audio_baseline
    if (strcmp(command->valuestring, "audio_baseline_start") == 0) {
        CompletionRequest* completion = g_new(CompletionRequest, 1);
        GError* error = NULL;

        completion->engine = engine;
        completion->request_id = request_id->valuedouble;
        completion->error_code = "recordingStartFailed";

        if (!media_start_audio_baseline(engine->media, on_media_completion, completion, &error)) {
            send_error(engine, request_id, "recordingStartFailed", error->message);
            g_clear_error(&error);
            g_free(completion);
        }

        return;
    }

    // Stop recording audio_baseline
    if (strcmp(command->valuestring, "audio_baseline_stop") == 0) {
        CompletionRequest* completion = g_new(CompletionRequest, 1);
        GError* error = NULL;

        completion->engine = engine;
        completion->request_id = request_id->valuedouble;
        completion->error_code = "recordingStopFailed";

        if (!media_stop_audio_baseline(engine->media, on_media_completion, completion, &error)) {
            send_error(engine, request_id, "recordingStopFailed", error->message);
            g_clear_error(&error);
            g_free(completion);
        }

        return;
    }

    // Render audio_gain_recording and audio_gain_merged together
    if (strcmp(command->valuestring, "audio_gain_recording_render") == 0) {
        CompletionRequest* completion = g_new(CompletionRequest, 1);
        GError* error = NULL;

        completion->engine = engine;
        completion->request_id = request_id->valuedouble;
        completion->error_code = "recordingRenderFailed";

        if (!media_render_audio_gain_recording(engine->media, on_media_completion, completion, &error)) {
            send_error(engine, request_id, "recordingRenderFailed", error->message);
            g_clear_error(&error);
            g_free(completion);
        }

        return;
    }

    // Apply the remote WebRTC session offer
    if (strcmp(command->valuestring, "webrtc_remote_offer_set") == 0) {
        cJSON* sdp = cJSON_GetObjectItemCaseSensitive(payload, "sdp");
        AnswerRequest* answer_request;

        if (!cJSON_IsString(sdp) || sdp->valuestring[0] == '\0') {
            send_error(engine, request_id, "invalidPayload", "Offer payload requires SDP");
            return;
        }

        answer_request = g_new(AnswerRequest, 1);
        answer_request->engine = engine;
        answer_request->request_id = request_id->valuedouble;

        media_set_remote_offer(engine->media, sdp->valuestring, on_media_answer, answer_request);
        return;
    }

    // Add a remote WebRTC ICE candidate
    if (strcmp(command->valuestring, "webrtc_remote_ice_candidate_add") == 0) {
        cJSON* candidate = cJSON_GetObjectItemCaseSensitive(payload, "candidate");
        cJSON* sdp_media_index = cJSON_GetObjectItemCaseSensitive(payload, "sdpMLineIndex");
        
        CompletionRequest* completion;
        GError* error = NULL;

        // clang-format off
        if (
            !cJSON_IsString(candidate) ||
            !valid_request_id(sdp_media_index) ||
            sdp_media_index->valuedouble > G_MAXUINT
        ) {
            send_error(engine, request_id, "invalidPayload", "ICE payload requires candidate and sdpMLineIndex");
            return;
        }
        // clang-format on

        completion = g_new(CompletionRequest, 1);
        completion->engine = engine;
        completion->request_id = request_id->valuedouble;
        completion->error_code = "iceCandidateFailed";

        // clang-format off
        if (
            !media_add_remote_ice_candidate(
                engine->media,
                (guint)sdp_media_index->valuedouble,
                candidate->valuestring,
                on_media_completion,
                completion,
                &error
            )
        ) {
            send_error(engine, request_id, "iceCandidateFailed", error->message);
            g_clear_error(&error);
            g_free(completion);
            return;
        }
        // clang-format on

        return;
    }

    send_error(engine, request_id, "unknownCommand", "Command is not supported");
}
