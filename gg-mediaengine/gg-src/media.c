/*
 * Gaingrab Media Engine
 * @company Quality and Usability Lab | TU Berlin
 * @author  Eero Kaan <eerokaan@qu.tu-berlin.de>
 */

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <gio/gio.h>
#include <gst/gst.h>
#include <gst/rtp/gstrtpbuffer.h>
#include <gst/sdp/sdp.h>
#include <gst/webrtc/webrtc.h>
#include "media.h"

typedef struct PlaybackMarker PlaybackMarker;
typedef struct StateEvent StateEvent;

typedef struct {
    Media* media;
    MediaAnswerHandler handler;
    gpointer user_data;
    GstWebRTCSessionDescription* answer;
    gchar* error;
} OfferOperation;

typedef struct {
    Media* media;
    GstWebRTCPeerConnectionState state;
} ConnectionStateChange;

typedef struct {
    Media* media;
    gint scheduled;
} MicrophoneWatch;

typedef struct {
    Media* media;
    GstPad* pad;
    gulong block_probe;
} IncomingPad;

typedef struct {
    Media* media;
    guint sdp_media_index;
    gchar* candidate;
    MediaCompletionHandler handler;
    gpointer user_data;
    gchar* error;
} RemoteCandidate;

typedef struct {
    Media* media;
    guint sdp_media_index;
    gchar* candidate;
} IceEvent;

typedef struct {
    GstElement* bin;
    GstClockTime stop_time;
} RecordingStop;

struct Media {
    // Event delivery
    GMainContext* context;
    MediaEventHandler event_handler;
    gpointer user_data;

    // Audio pipeline and gain routing
    GstElement* pipeline;
    GstElement* selector;
    GstElement* content_gain;
    GstElement* headphone_gain;
    GstElement* receive_bin;
    GstElement* microphone_tee;
    GstPad* silence_pad;
    gdouble recording_gain;

    // WebRTC connection and ICE negotiation
    GstElement* webrtc;
    GstElement* payloader;
    GstElement* capsfilter;
    GstPad* webrtc_sink_pad;
    MediaIceHandler ice_handler;
    GQueue remote_candidates;
    gboolean remote_description_set;
    gboolean offer_in_progress;
    gboolean microphone_received;
    gboolean connected;

    // Session configuration and source paths
    gboolean configured;
    gchar* p501_f1;
    gchar* p501_f2;
    gchar* audio_baseline;
    gchar* audio_gain_recording;
    gchar* audio_gain_merged;

    // Active playback (main-context only)
    GstElement* playback_bin;
    GstPad* playback_pad;
    gchar* playback_id;
    gchar* playback_source;

    // Playback completion
    guint64 playback_generation;
    GMutex playback_mutex;
    PlaybackMarker* pending_playback;
    GSource* playback_dispatch;

    // Recording lifecycle: audio_baseline
    GstElement* recording_bin;
    GstElement* recording_sink;
    GstPad* recording_tee_pad;
    gulong recording_start_probe;
    gulong recording_block_probe;
    GstClockTime recording_stop_time;
    GSource* recording_stop_timeout;
    MediaCompletionHandler recording_start_handler;
    gpointer recording_start_data;
    MediaCompletionHandler recording_completion_handler;
    gpointer recording_completion_data;

    // Recording lifecycle: audio_gain_recording and audio_gain_merged
    GstElement* render_pipeline;
    guint64 render_bus_watch;
    MediaCompletionHandler render_completion_handler;
    gpointer render_completion_data;
};

struct MediaPlaybackTiming {
    guint32 rtp_timestamp;
    guint32 ssrc;
};

struct PlaybackMarker {
    Media* media;
    GstElement* bin;
    guint64 generation;
    GstClockTime start_time;
    GstClockTime end_time;
    gboolean timing_valid;
    MediaPlaybackTiming timing;
};

struct StateEvent {
    Media* media;
    gchar* event;
    gchar* detail;
    gboolean has_timing;
    MediaPlaybackTiming timing;
};

static void finish_recording(Media* media);
static void stop_recording_on_main(Media* media);

static gboolean deliver_ice(gpointer user_data) {
    IceEvent* event = user_data;

    event->media->ice_handler(event->sdp_media_index, event->candidate, event->media->user_data);
    g_free(event->candidate);
    g_free(event);

    return G_SOURCE_REMOVE;
}

static gboolean deliver_state(gpointer user_data) {
    StateEvent* event = user_data;

    // clang-format off
    event->media->event_handler(
        event->event,
        event->detail,
        event->has_timing ? &event->timing : NULL,
        event->media->user_data
    );
    // clang-format on

    g_free(event->event);
    g_free(event->detail);
    g_free(event);

    return G_SOURCE_REMOVE;
}

// clang-format off
static void queue_state_event(
    Media* media,
    const gchar* event_name,
    const gchar* detail,
    const MediaPlaybackTiming* timing
) {
    StateEvent* event = g_new0(StateEvent, 1);

    event->media = media;
    event->event = g_strdup(event_name);
    event->detail = g_strdup(detail);
    event->has_timing = timing != NULL;

    if (timing != NULL) {
        event->timing = *timing;
    }

    g_main_context_invoke(media->context, deliver_state, event);
}
// clang-format on

static gboolean apply_connection_state_on_main(gpointer user_data) {
    ConnectionStateChange* change = user_data;

    switch (change->state) {
        case GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTED:
            change->media->connected = TRUE;
            queue_state_event(change->media, "webrtc_connected", NULL, NULL);
            break;
        case GST_WEBRTC_PEER_CONNECTION_STATE_DISCONNECTED:
        case GST_WEBRTC_PEER_CONNECTION_STATE_CLOSED:
            change->media->connected = FALSE;
            queue_state_event(change->media, "webrtc_disconnected", NULL, NULL);
            break;
        case GST_WEBRTC_PEER_CONNECTION_STATE_FAILED:
            change->media->connected = FALSE;
            queue_state_event(change->media, "fatal_error", NULL, NULL);
            break;
        default:
            break;
    }

    return G_SOURCE_REMOVE;
}

static void on_connection_state(GObject* object, GParamSpec* property, gpointer user_data) {
    Media* media = user_data;
    ConnectionStateChange* change = g_new(ConnectionStateChange, 1);

    (void)property;
    change->media = media;

    g_object_get(object, "connection-state", &change->state, NULL);
    g_main_context_invoke_full(media->context, G_PRIORITY_DEFAULT, apply_connection_state_on_main, change, g_free);
}

static void on_ice_candidate(GstElement* webrtc, guint sdp_media_index, gchar* candidate, gpointer user_data) {
    Media* media = user_data;
    IceEvent* event;

    (void)webrtc;
    if (candidate == NULL || candidate[0] == '\0') {
        return;
    }

    event = g_new(IceEvent, 1);
    event->media = media;
    event->sdp_media_index = sdp_media_index;
    event->candidate = g_strdup(candidate);

    g_main_context_invoke(media->context, deliver_ice, event);
}

static gboolean mark_microphone_received_on_main(gpointer user_data) {
    Media* media = user_data;

    media->microphone_received = TRUE;
    g_printerr("WebRTC microphone media received\n");
    queue_state_event(media, "webrtc_microphone_received", NULL, NULL);

    return G_SOURCE_REMOVE;
}

static void free_microphone_watch(gpointer data, GClosure* closure) {
    (void)closure;
    g_free(data);
}

static void on_microphone_handoff(GstElement* sink, GstBuffer* buffer, GstPad* pad, gpointer user_data) {
    MicrophoneWatch* watch = user_data;

    (void)sink;
    (void)buffer;
    (void)pad;

    if (!g_atomic_int_compare_and_exchange(&watch->scheduled, FALSE, TRUE)) {
        return;
    }

    g_main_context_invoke(watch->media->context, mark_microphone_received_on_main, watch->media);
}

static void free_incoming_pad(gpointer user_data) {
    IncomingPad* incoming = user_data;

    if (incoming->block_probe != 0) {
        gst_pad_remove_probe(incoming->pad, incoming->block_probe);
    }

    gst_object_unref(incoming->pad);
    g_free(incoming);
}

static GstPadProbeReturn on_incoming_pad_blocked(GstPad* pad, GstPadProbeInfo* info, gpointer user_data) {
    (void)pad;
    (void)info;
    (void)user_data;
    return GST_PAD_PROBE_OK;
}

static gboolean link_incoming_pad_on_main(gpointer user_data) {
    IncomingPad* incoming = user_data;
    GstPad* sink_pad;
    gboolean failed = FALSE;

    sink_pad = gst_element_get_static_pad(incoming->media->receive_bin, "sink");
    if (!gst_pad_is_linked(sink_pad) && gst_pad_link(incoming->pad, sink_pad) != GST_PAD_LINK_OK) {
        g_printerr("Failed to link incoming WebRTC audio pad\n");
        failed = TRUE;
    }

    gst_object_unref(sink_pad);
    gst_pad_remove_probe(incoming->pad, incoming->block_probe);
    incoming->block_probe = 0;

    if (failed) {
        queue_state_event(incoming->media, "fatal_error", NULL, NULL);
    }

    return G_SOURCE_REMOVE;
}

static void on_incoming_pad(GstElement* webrtc, GstPad* pad, gpointer user_data) {
    Media* media = user_data;
    IncomingPad* incoming;

    (void)webrtc;
    if (GST_PAD_DIRECTION(pad) != GST_PAD_SRC) {
        return;
    }

    // clang-format off
    incoming = g_new(IncomingPad, 1);
    incoming->media = media;
    incoming->pad = gst_object_ref(pad);
    incoming->block_probe = gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BLOCK_DOWNSTREAM, on_incoming_pad_blocked, NULL, NULL);
    // clang-format on

    if (incoming->block_probe == 0) {
        free_incoming_pad(incoming);
        queue_state_event(media, "fatal_error", NULL, NULL);
        return;
    }

    // clang-format off
    g_main_context_invoke_full(media->context, G_PRIORITY_DEFAULT, link_incoming_pad_on_main, incoming, free_incoming_pad);
    // clang-format on
}

static gboolean on_bus_message(GstBus* bus, GstMessage* message, gpointer user_data) {
    Media* media = user_data;

    (void)bus;
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError* error = NULL;
        gchar* debug = NULL;

        gst_message_parse_error(message, &error, &debug);
        g_printerr("GStreamer error: %s%s%s\n", error->message, debug == NULL ? "" : " (", debug == NULL ? "" : debug);

        if (debug != NULL) {
            g_printerr(")\n");
        }

        g_clear_error(&error);
        g_free(debug);
        queue_state_event(media, "fatal_error", NULL, NULL);
    }

    // clang-format off
    else if (
        GST_MESSAGE_TYPE(message) == GST_MESSAGE_APPLICATION &&
        media->recording_completion_handler != NULL &&
        GST_MESSAGE_SRC(message) == GST_OBJECT(media->recording_bin)
    ) {
        const GstStructure* structure = gst_message_get_structure(message);
        guint64 stop_time;

        if (
            gst_structure_has_name(structure, "recording-drained") &&
            gst_structure_get_uint64(structure, "stop-time", &stop_time) &&
            stop_time == media->recording_stop_time
        ) {
            stop_recording_on_main(media);
        }
    }

    else if (
        GST_MESSAGE_TYPE(message) == GST_MESSAGE_ELEMENT &&
        media->recording_completion_handler != NULL &&
        media->recording_sink != NULL
    ) {
        const GstStructure* structure = gst_message_get_structure(message);
        GstMessage* forwarded = NULL;

        if (
            structure != NULL && gst_structure_has_name(structure, "GstBinForwarded") &&
            gst_structure_get(structure, "message", GST_TYPE_MESSAGE, &forwarded, NULL)
        ) {
            if (
                GST_MESSAGE_TYPE(forwarded) == GST_MESSAGE_EOS &&
                GST_MESSAGE_SRC(forwarded) == GST_OBJECT(media->recording_sink)
            ) {
                finish_recording(media);
            }
            gst_message_unref(forwarded);
        }
    }
    // clang-format on

    return G_SOURCE_CONTINUE;
}

static gboolean find_opus_payload(const GstSDPMessage* message, guint* payload_type) {
    guint media_index;

    for (media_index = 0; media_index < gst_sdp_message_medias_len(message); media_index++) {
        const GstSDPMedia* sdp_media = gst_sdp_message_get_media(message, media_index);
        guint attribute_index;

        if (g_strcmp0(gst_sdp_media_get_media(sdp_media), "audio") != 0) {
            continue;
        }
        for (attribute_index = 0; attribute_index < gst_sdp_media_attributes_len(sdp_media); attribute_index++) {
            const GstSDPAttribute* attribute = gst_sdp_media_get_attribute(sdp_media, attribute_index);
            guint payload;
            gchar encoding[64];

            // clang-format off
            if (
                g_strcmp0(attribute->key, "rtpmap") == 0 &&
                sscanf(attribute->value, "%u %63s", &payload, encoding) == 2 &&
                g_ascii_strncasecmp(encoding, "opus/48000/2", 12) == 0
            ) {
                *payload_type = payload;
                return TRUE;
            }
            // clang-format on
        }
    }
    return FALSE;
}

static void set_opus_answer_parameters(GstSDPMessage* message, guint payload_type) {
    guint media_index;

    for (media_index = 0; media_index < gst_sdp_message_medias_len(message); media_index++) {
        GstSDPMedia* sdp_media = (GstSDPMedia*)gst_sdp_message_get_media(message, media_index);
        gint attribute_index;

        if (g_strcmp0(gst_sdp_media_get_media(sdp_media), "audio") != 0) {
            continue;
        }

        // clang-format off
        for (attribute_index = (gint)gst_sdp_media_attributes_len(sdp_media) - 1; attribute_index >= 0; attribute_index--) {
            const GstSDPAttribute* attribute = gst_sdp_media_get_attribute(sdp_media, (guint)attribute_index);
            guint attribute_payload;

            if (
                g_strcmp0(attribute->key, "fmtp") == 0 &&
                sscanf(attribute->value, "%u", &attribute_payload) == 1 &&
                attribute_payload == payload_type
            ) {
                gst_sdp_media_remove_attribute(sdp_media, (guint)attribute_index);
            }
        }
        // clang-format on

        gchar* fmtp = g_strdup_printf("%u stereo=0;sprop-stereo=0;usedtx=0;maxaveragebitrate=128000", payload_type);
        gst_sdp_media_add_attribute(sdp_media, "fmtp", fmtp);
        g_free(fmtp);

        return;
    }
}

static gboolean link_outgoing_audio(Media* media, guint payload_type, GError** error) {
    GstCaps* caps;
    GstPad* source_pad;

    if (media->webrtc_sink_pad != NULL) {
        return TRUE;
    }

    g_object_set(media->payloader, "pt", payload_type, NULL);

    // clang-format off
    caps = gst_caps_new_simple(
        "application/x-rtp",
        "media", G_TYPE_STRING, "audio",
        "encoding-name", G_TYPE_STRING, "OPUS",
        "clock-rate", G_TYPE_INT, 48000,
        "encoding-params", G_TYPE_STRING, "2",
        "payload", G_TYPE_INT, payload_type,
        NULL
    );

    g_object_set(media->capsfilter, "caps", caps, NULL);
    gst_caps_unref(caps);

    source_pad = gst_element_get_static_pad(media->capsfilter, "src");
    media->webrtc_sink_pad = gst_element_request_pad_simple(media->webrtc, "sink_%u");

    if (media->webrtc_sink_pad == NULL || gst_pad_link(source_pad, media->webrtc_sink_pad) != GST_PAD_LINK_OK) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_NEGOTIATION,
            "Failed to link outgoing WebRTC audio"
        );
        gst_object_unref(source_pad);
        return FALSE;
    }
    gst_object_unref(source_pad);

    if (gst_element_set_state(media->pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_STATE_CHANGE,
            "Failed to start WebRTC pipeline"
        );
        return FALSE;
    }
    // clang-format on

    return TRUE;
}

static gboolean deliver_offer_result(gpointer user_data) {
    OfferOperation* operation = user_data;
    gchar* sdp = NULL;

    if (operation->answer != NULL) {
        sdp = gst_sdp_message_as_text(operation->answer->sdp);
    }

    operation->media->offer_in_progress = FALSE;
    operation->handler(sdp, operation->error, operation->user_data);
    g_free(sdp);
    g_free(operation->error);

    if (operation->answer != NULL) {
        gst_webrtc_session_description_free(operation->answer);
    }
    g_free(operation);

    return G_SOURCE_REMOVE;
}

static gchar* promise_error(GstPromise* promise, const gchar* fallback) {
    const GstStructure* reply;
    const GValue* value;
    const GError* error;

    if (gst_promise_wait(promise) != GST_PROMISE_RESULT_REPLIED) {
        return g_strdup(fallback);
    }

    reply = gst_promise_get_reply(promise);
    if (reply == NULL) {
        return NULL;
    }

    value = gst_structure_get_value(reply, "error");
    if (value == NULL || !G_VALUE_HOLDS(value, G_TYPE_ERROR)) {
        return NULL;
    }

    error = g_value_get_boxed(value);
    return g_strdup(error == NULL ? fallback : error->message);
}

static gboolean deliver_remote_candidate_result(gpointer user_data) {
    RemoteCandidate* candidate = user_data;

    candidate->handler(candidate->error, candidate->user_data);
    g_free(candidate->candidate);
    g_free(candidate->error);
    g_free(candidate);

    return G_SOURCE_REMOVE;
}

static void on_remote_candidate_added(GstPromise* promise, gpointer user_data) {
    RemoteCandidate* candidate = user_data;

    candidate->error = promise_error(promise, "Failed to add remote ICE candidate");

    gst_promise_unref(promise);
    g_main_context_invoke(candidate->media->context, deliver_remote_candidate_result, candidate);
}

static void submit_remote_candidate(RemoteCandidate* candidate) {
    GstPromise* promise = gst_promise_new_with_change_func(on_remote_candidate_added, candidate, NULL);

    // clang-format off
    g_signal_emit_by_name(
        candidate->media->webrtc,
        "add-ice-candidate-full",
        candidate->sdp_media_index,
        candidate->candidate,
        promise
    );
    // clang-format on
}

static void fail_offer(OfferOperation* operation, const gchar* message) {
    operation->error = g_strdup(message);
    g_main_context_invoke(operation->media->context, deliver_offer_result, operation);
}

static void on_local_description_set(GstPromise* promise, gpointer user_data) {
    OfferOperation* operation = user_data;
    gchar* error = promise_error(promise, "Failed to set local WebRTC description");

    if (error != NULL) {
        gst_promise_unref(promise);
        fail_offer(operation, error);
        g_free(error);
        return;
    }

    gst_promise_unref(promise);
    g_main_context_invoke(operation->media->context, deliver_offer_result, operation);
}

static gboolean set_local_description_on_main(gpointer user_data) {
    OfferOperation* operation = user_data;
    guint payload_type;
    GstPromise* local_promise;

    if (operation->answer == NULL) {
        operation->error = g_strdup("WebRTC answer is missing");
        return deliver_offer_result(operation);
    }
    if (find_opus_payload(operation->answer->sdp, &payload_type)) {
        set_opus_answer_parameters(operation->answer->sdp, payload_type);
    }

    local_promise = gst_promise_new_with_change_func(on_local_description_set, operation, NULL);
    g_signal_emit_by_name(operation->media->webrtc, "set-local-description", operation->answer, local_promise);

    return G_SOURCE_REMOVE;
}

static void on_answer_created(GstPromise* promise, gpointer user_data) {
    OfferOperation* operation = user_data;
    const GstStructure* reply;
    gchar* error = promise_error(promise, "Failed to create WebRTC answer");

    if (error != NULL) {
        gst_promise_unref(promise);
        fail_offer(operation, error);
        g_free(error);
        return;
    }

    reply = gst_promise_get_reply(promise);
    gst_structure_get(reply, "answer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &operation->answer, NULL);

    gst_promise_unref(promise);
    g_main_context_invoke(operation->media->context, set_local_description_on_main, operation);
}

static gboolean create_answer_on_main(gpointer user_data) {
    OfferOperation* operation = user_data;
    Media* media = operation->media;
    RemoteCandidate* candidate;

    media->remote_description_set = TRUE;
    while ((candidate = g_queue_pop_head(&media->remote_candidates)) != NULL) {
        submit_remote_candidate(candidate);
    }

    GstPromise* answer_promise = gst_promise_new_with_change_func(on_answer_created, operation, NULL);
    g_signal_emit_by_name(media->webrtc, "create-answer", NULL, answer_promise);

    return G_SOURCE_REMOVE;
}

static void on_remote_description_set(GstPromise* promise, gpointer user_data) {
    OfferOperation* operation = user_data;
    gchar* error = promise_error(promise, "Failed to set remote WebRTC description");

    if (error != NULL) {
        gst_promise_unref(promise);
        fail_offer(operation, error);
        g_free(error);
        return;
    }

    gst_promise_unref(promise);
    g_main_context_invoke(operation->media->context, create_answer_on_main, operation);
}

static void cancel_playback_completion(Media* media) {
    g_mutex_lock(&media->playback_mutex);

    media->playback_generation++;
    g_clear_pointer(&media->pending_playback, g_free);

    if (media->playback_dispatch != NULL) {
        g_source_destroy(media->playback_dispatch);
        g_clear_pointer(&media->playback_dispatch, g_source_unref);
    }

    g_mutex_unlock(&media->playback_mutex);
}

static void clear_playback(Media* media, const MediaPlaybackTiming* timing) {
    gchar* finished_id;

    cancel_playback_completion(media);
    if (media->playback_bin == NULL) {
        return;
    }

    // clang-format off
    finished_id = g_strdup(media->playback_id);
    g_printerr(
        "Playback %s: %s\n",
        timing != NULL ? "draining" : "stopped",
        finished_id == NULL ? "unidentified" : finished_id
    );
    // clang-format on

    g_object_set(media->selector, "active-pad", media->silence_pad, NULL);
    gst_element_set_state(media->playback_bin, GST_STATE_NULL);

    if (media->playback_pad != NULL) {
        GstPad* source_pad = gst_element_get_static_pad(media->playback_bin, "src");

        gst_pad_unlink(source_pad, media->playback_pad);
        gst_object_unref(source_pad);
        gst_element_release_request_pad(media->selector, media->playback_pad);
        gst_object_unref(media->playback_pad);
    }

    gst_bin_remove(GST_BIN(media->pipeline), media->playback_bin);
    media->playback_bin = NULL;
    media->playback_pad = NULL;

    g_clear_pointer(&media->playback_id, g_free);
    g_clear_pointer(&media->playback_source, g_free);
    g_object_set(media->content_gain, "volume", 1.0, NULL);
    queue_state_event(media, "webrtc_silence_active", NULL, NULL);

    if (timing != NULL) {
        queue_state_event(media, "playback_finished", finished_id, timing);
    }
    g_free(finished_id);
}

static gboolean finish_playback_on_main(gpointer user_data) {
    PlaybackMarker* marker = user_data;
    Media* media = marker->media;

    g_mutex_lock(&media->playback_mutex);
    g_clear_pointer(&media->playback_dispatch, g_source_unref);
    g_mutex_unlock(&media->playback_mutex);

    if (media->playback_bin == marker->bin && media->playback_generation == marker->generation) {
        clear_playback(media, &marker->timing);
    }

    return G_SOURCE_REMOVE;
}

static void queue_playback_callback(PlaybackMarker* marker, GSourceFunc callback) {
    Media* media = marker->media;

    g_mutex_lock(&media->playback_mutex);

    // clang-format off
    if (
        media->playback_generation != marker->generation ||
        media->playback_dispatch != NULL ||
        media->pending_playback != NULL
    ) {
        // clang-format on
        g_mutex_unlock(&media->playback_mutex);

        g_free(marker);
        return;
    }

    media->playback_dispatch = g_idle_source_new();
    g_source_set_callback(media->playback_dispatch, callback, marker, g_free);
    g_source_attach(media->playback_dispatch, media->context);

    g_mutex_unlock(&media->playback_mutex);
}

static gboolean drain_playback_on_main(gpointer user_data) {
    PlaybackMarker* marker = user_data;
    Media* media = marker->media;

    g_mutex_lock(&media->playback_mutex);
    g_clear_pointer(&media->playback_dispatch, g_source_unref);
    g_mutex_unlock(&media->playback_mutex);

    if (media->playback_bin != marker->bin || media->playback_generation != marker->generation) {
        return G_SOURCE_REMOVE;
    }
    if (!marker->timing_valid || !GST_CLOCK_TIME_IS_VALID(marker->end_time)) {
        g_printerr("Playback has no valid end timestamp: %s\n", media->playback_id);
        clear_playback(media, NULL);
        queue_state_event(media, "fatal_error", NULL, NULL);
        return G_SOURCE_REMOVE;
    }

    g_mutex_lock(&media->playback_mutex);
    media->pending_playback = g_new(PlaybackMarker, 1);
    *media->pending_playback = *marker;
    g_mutex_unlock(&media->playback_mutex);

    g_object_set(media->selector, "active-pad", media->silence_pad, NULL);

    return G_SOURCE_REMOVE;
}

static GstPadProbeReturn on_playback_event(GstPad* pad, GstPadProbeInfo* info, gpointer user_data) {
    PlaybackMarker* marker = user_data;
    GstEvent* event;

    (void)pad;
    if ((GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER) != 0) {
        GstBuffer* buffer = GST_PAD_PROBE_INFO_BUFFER(info);
        GstClockTime pts = GST_BUFFER_PTS(buffer);
        GstClockTime duration = GST_BUFFER_DURATION(buffer);

        // clang-format off
        if (
            !GST_CLOCK_TIME_IS_VALID(pts) ||
            !GST_CLOCK_TIME_IS_VALID(duration) ||
            duration == 0 ||
            pts >= GST_CLOCK_TIME_NONE - marker->start_time ||
            duration >= GST_CLOCK_TIME_NONE - (marker->start_time + pts)
        ) {
            marker->timing_valid = FALSE;
        } else {
            GstClockTime end_time = marker->start_time + pts + duration;

            if (
                !GST_CLOCK_TIME_IS_VALID(marker->end_time) ||
                end_time > marker->end_time
            ) {
                marker->end_time = end_time;
            }
        }
        // clang-format on

        return GST_PAD_PROBE_OK;
    }
    if ((GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) == 0) {
        return GST_PAD_PROBE_OK;
    }

    event = GST_PAD_PROBE_INFO_EVENT(info);
    if (GST_EVENT_TYPE(event) != GST_EVENT_EOS) {
        return GST_PAD_PROBE_OK;
    }

    PlaybackMarker* completion = g_new(PlaybackMarker, 1);
    *completion = *marker;
    queue_playback_callback(completion, drain_playback_on_main);

    return GST_PAD_PROBE_DROP;
}

static GstPadProbeReturn on_outgoing_rtp(GstPad* pad, GstPadProbeInfo* info, gpointer user_data) {
    Media* media = user_data;
    PlaybackMarker* completion = NULL;
    GstEvent* event;
    const GstSegment* segment;
    GstBufferList* list = NULL;
    guint count = 1;

    g_mutex_lock(&media->playback_mutex);

    if (media->pending_playback == NULL) {
        g_mutex_unlock(&media->playback_mutex);

        return GST_PAD_PROBE_OK;
    }

    event = gst_pad_get_sticky_event(pad, GST_EVENT_SEGMENT, 0);
    if (event == NULL) {
        g_mutex_unlock(&media->playback_mutex);

        return GST_PAD_PROBE_OK;
    }

    gst_event_parse_segment(event, &segment);

    if (segment->format == GST_FORMAT_TIME) {
        if ((GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER_LIST) != 0) {
            list = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
            count = gst_buffer_list_length(list);
        }

        for (guint index = 0; index < count; index++) {
            GstBuffer* buffer = list == NULL ? GST_PAD_PROBE_INFO_BUFFER(info) : gst_buffer_list_get(list, index);
            GstClockTime pts = GST_BUFFER_PTS(buffer);
            GstClockTime running_time;
            GstRTPBuffer rtp = GST_RTP_BUFFER_INIT;
            guint64 samples;

            if (!GST_CLOCK_TIME_IS_VALID(pts)) {
                continue;
            }

            running_time = gst_segment_to_running_time(segment, GST_FORMAT_TIME, pts);
            if (!GST_CLOCK_TIME_IS_VALID(running_time) || running_time < media->pending_playback->end_time) {
                continue;
            }

            // Use the packet duration when available; Opus is configured for 20 ms frames
            // clang-format off
            samples = GST_BUFFER_DURATION_IS_VALID(buffer) && GST_BUFFER_DURATION(buffer) > 0
                ? gst_util_uint64_scale_ceil(GST_BUFFER_DURATION(buffer), 48000, GST_SECOND)
                : 960;
            // clang-format on

            if (samples == 0 || samples > G_MAXUINT32 || !gst_rtp_buffer_map(buffer, GST_MAP_READ, &rtp)) {
                continue;
            }

            completion = media->pending_playback;
            media->pending_playback = NULL;

            completion->timing.rtp_timestamp = gst_rtp_buffer_get_timestamp(&rtp) + (guint32)samples;
            completion->timing.ssrc = gst_rtp_buffer_get_ssrc(&rtp);

            gst_rtp_buffer_unmap(&rtp);
            break;
        }
    }

    gst_event_unref(event);
    g_mutex_unlock(&media->playback_mutex);

    if (completion != NULL) {
        queue_playback_callback(completion, finish_playback_on_main);
    }

    return GST_PAD_PROBE_OK;
}

static GstElement* create_playback_bin(const gchar* path, GstClockTime start_time, GError** error) {
    GstCaps* caps;
    GstPad* source_pad;

    GstElement* bin = gst_bin_new(NULL);
    GstElement* source = gst_element_factory_make("filesrc", NULL);
    GstElement* parser = gst_element_factory_make("wavparse", NULL);
    GstElement* convert = gst_element_factory_make("audioconvert", NULL);
    GstElement* resample = gst_element_factory_make("audioresample", NULL);
    GstElement* capsfilter = gst_element_factory_make("capsfilter", NULL);
    GstElement* synchronizer = gst_element_factory_make("identity", NULL);
    GstElement* queue = gst_element_factory_make("queue", NULL);

    // clang-format off
    if (
        bin == NULL ||
        source == NULL ||
        parser == NULL ||
        convert == NULL ||
        resample == NULL ||
        capsfilter == NULL ||
        synchronizer == NULL ||
        queue == NULL
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_MISSING_PLUGIN,
            "Failed to create WAV playback elements"
        );
        
        if (bin != NULL) {
            gst_object_unref(bin);
        }
        if (source != NULL) {
            gst_object_unref(source);
        }
        if (parser != NULL) {
            gst_object_unref(parser);
        }
        if (convert != NULL) {
            gst_object_unref(convert);
        }
        if (resample != NULL) {
            gst_object_unref(resample);
        }
        if (capsfilter != NULL) {
            gst_object_unref(capsfilter);
        }
        if (synchronizer != NULL) {
            gst_object_unref(synchronizer);
        }
        if (queue != NULL) {
            gst_object_unref(queue);
        }

        return NULL;
    }
    // clang-format on

    g_object_set(source, "location", path, NULL);

    // clang-format off
    caps = gst_caps_new_simple(
        "audio/x-raw",
        "rate", G_TYPE_INT, 48000,
        "channels", G_TYPE_INT, 1,
        NULL
    );

    g_object_set(capsfilter, "caps", caps, NULL);
    g_object_set(synchronizer, "sync", TRUE, NULL);
    g_object_set(
        queue,
        "max-size-time", (guint64)(100 * GST_MSECOND),
        "max-size-buffers", 0,
        "max-size-bytes", 0,
        "leaky", 0,
        "flush-on-eos", FALSE,
        NULL
    );
    gst_caps_unref(caps);
    
    gst_bin_add_many(GST_BIN(bin), source, parser, convert, resample, capsfilter, synchronizer, queue, NULL);

    if (!gst_element_link_many(source, parser, convert, resample, capsfilter, synchronizer, queue, NULL)) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_NEGOTIATION,
            "Failed to link WAV playback elements"
        );
        gst_object_unref(bin);
        return NULL;
    }
    // clang-format on

    // Shift the segment before identity clocks the zero-origin file timestamps
    source_pad = gst_element_get_static_pad(capsfilter, "src");
    gst_pad_set_offset(source_pad, (gint64)start_time);
    gst_object_unref(source_pad);

    source_pad = gst_element_get_static_pad(queue, "src");
    gst_element_add_pad(bin, gst_ghost_pad_new("src", source_pad));
    gst_object_unref(source_pad);

    return bin;
}

static GstElement* create_recording_bin(const gchar* path, GstElement** recording_sink, GError** error) {
    GstCaps* caps;
    GstPad* sink_pad;

    GstElement* bin = gst_bin_new(NULL);
    GstElement* queue = gst_element_factory_make("queue", NULL);
    GstElement* convert = gst_element_factory_make("audioconvert", NULL);
    GstElement* capsfilter = gst_element_factory_make("capsfilter", NULL);
    GstElement* encoder = gst_element_factory_make("wavenc", NULL);
    GstElement* sink = gst_element_factory_make("filesink", "recording_sink");

    // clang-format off
    if (
        bin == NULL ||
        queue == NULL ||
        convert == NULL ||
        capsfilter == NULL ||
        encoder == NULL ||
        sink == NULL
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_MISSING_PLUGIN,
            "Failed to create audio_baseline recording elements"
        );
        
        if (bin != NULL) {
            gst_object_unref(bin);
        }
        if (queue != NULL) {
            gst_object_unref(queue);
        }
        if (convert != NULL) {
            gst_object_unref(convert);
        }
        if (capsfilter != NULL) {
            gst_object_unref(capsfilter);
        }
        if (encoder != NULL) {
            gst_object_unref(encoder);
        }
        if (sink != NULL) {
            gst_object_unref(sink);
        }

        return NULL;
    }
    // clang-format on

    // clang-format off
    caps = gst_caps_new_simple(
        "audio/x-raw",
        "format", G_TYPE_STRING, "S16LE",
        "rate", G_TYPE_INT, 48000,
        "channels", G_TYPE_INT, 1,
        NULL
    );

    g_object_set(capsfilter, "caps", caps, NULL);
    g_object_set(sink, "location", path, "sync", FALSE, "async", FALSE, NULL);
    g_object_set(bin, "message-forward", TRUE, NULL);
    gst_caps_unref(caps);
    
    gst_bin_add_many(GST_BIN(bin), queue, convert, capsfilter, encoder, sink, NULL);
    
    if (!gst_element_link_many(queue, convert, capsfilter, encoder, sink, NULL)) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_NEGOTIATION,
            "Failed to link audio_baseline recording elements"
        );
        gst_object_unref(bin);
        return NULL;
    }
    // clang-format on

    sink_pad = gst_element_get_static_pad(queue, "sink");
    gst_element_add_pad(bin, gst_ghost_pad_new("sink", sink_pad));
    gst_object_unref(sink_pad);
    *recording_sink = gst_object_ref(sink);

    return bin;
}

static void cleanup_recording(Media* media) {
    if (media->recording_bin == NULL) {
        return;
    }
    if (media->recording_start_probe != 0 && media->recording_sink != NULL) {
        GstPad* sink_pad = gst_element_get_static_pad(media->recording_sink, "sink");
        gst_pad_remove_probe(sink_pad, media->recording_start_probe);
        gst_object_unref(sink_pad);
    }
    if (media->recording_stop_timeout != NULL) {
        g_source_destroy(media->recording_stop_timeout);
        g_clear_pointer(&media->recording_stop_timeout, g_source_unref);
    }

    gst_element_set_state(media->recording_bin, GST_STATE_NULL);

    if (media->recording_tee_pad != NULL) {
        if (media->recording_block_probe != 0) {
            gst_pad_remove_probe(media->recording_tee_pad, media->recording_block_probe);
        }
        gst_element_release_request_pad(media->microphone_tee, media->recording_tee_pad);
        gst_object_unref(media->recording_tee_pad);
    }

    gst_bin_remove(GST_BIN(media->receive_bin), media->recording_bin);
    gst_clear_object(&media->recording_sink);

    media->recording_bin = NULL;
    media->recording_tee_pad = NULL;
    media->recording_start_probe = 0;
    media->recording_start_handler = NULL;
    media->recording_start_data = NULL;
    media->recording_block_probe = 0;
}

static gboolean finish_recording_start_on_main(gpointer user_data) {
    Media* media = user_data;
    MediaCompletionHandler handler = media->recording_start_handler;
    gpointer completion_data = media->recording_start_data;

    media->recording_start_probe = 0;
    media->recording_start_handler = NULL;
    media->recording_start_data = NULL;

    if (handler != NULL && media->recording_bin != NULL) {
        g_printerr("audio_baseline recording started\n");
        handler(NULL, completion_data);
    }

    return G_SOURCE_REMOVE;
}

static GstPadProbeReturn on_recording_first_buffer(GstPad* pad, GstPadProbeInfo* info, gpointer user_data) {
    Media* media = user_data;

    (void)pad;
    (void)info;
    g_main_context_invoke(media->context, finish_recording_start_on_main, media);

    return GST_PAD_PROBE_REMOVE;
}

static void finish_recording(Media* media) {
    MediaCompletionHandler handler = media->recording_completion_handler;
    gpointer completion_data = media->recording_completion_data;

    cleanup_recording(media);
    media->recording_completion_handler = NULL;
    media->recording_completion_data = NULL;

    g_printerr("audio_baseline recording finalized\n");
    handler(NULL, completion_data);
}

static void stop_recording_on_main(Media* media) {
    GstPad* bin_sink = gst_element_get_static_pad(media->recording_bin, "sink");

    g_source_destroy(media->recording_stop_timeout);
    g_clear_pointer(&media->recording_stop_timeout, g_source_unref);
    gst_pad_unlink(media->recording_tee_pad, bin_sink);

    if (media->recording_block_probe != 0) {
        gst_pad_remove_probe(media->recording_tee_pad, media->recording_block_probe);
        media->recording_block_probe = 0;
    }
    if (!gst_pad_send_event(bin_sink, gst_event_new_eos())) {
        MediaCompletionHandler handler = media->recording_completion_handler;
        gpointer completion_data = media->recording_completion_data;

        gst_object_unref(bin_sink);
        cleanup_recording(media);

        media->recording_completion_handler = NULL;
        media->recording_completion_data = NULL;
        handler("Failed to finalize audio_baseline recording", completion_data);

        return;
    }

    gst_object_unref(bin_sink);
}

static void free_recording_stop(gpointer user_data) {
    RecordingStop* stop = user_data;

    gst_object_unref(stop->bin);
    g_free(stop);
}

static GstPadProbeReturn on_recording_buffer(GstPad* pad, GstPadProbeInfo* info, gpointer user_data) {
    RecordingStop* stop = user_data;
    GstBuffer* buffer = GST_PAD_PROBE_INFO_BUFFER(info);
    GstEvent* event = gst_pad_get_sticky_event(pad, GST_EVENT_SEGMENT, 0);
    GstClockTime running_time = GST_CLOCK_TIME_NONE;
    const GstSegment* segment;

    if (event != NULL) {
        gst_event_parse_segment(event, &segment);
        if (segment->format == GST_FORMAT_TIME && GST_BUFFER_PTS_IS_VALID(buffer)) {
            running_time = gst_segment_to_running_time(segment, GST_FORMAT_TIME, GST_BUFFER_PTS(buffer));
        }
        gst_event_unref(event);
    }

    // Drain pre-stop microphone frames, including those still in the RTP jitterbuffer
    // A buffer crossing the boundary is kept whole; Only later buffers are blocked
    if (!GST_CLOCK_TIME_IS_VALID(running_time) || running_time < stop->stop_time) {
        return GST_PAD_PROBE_PASS;
    }

    // clang-format off
    gst_element_post_message(
        stop->bin,
        gst_message_new_application(
            GST_OBJECT(stop->bin),
            gst_structure_new(
                "recording-drained",
                "stop-time", G_TYPE_UINT64, stop->stop_time,
                NULL
            )
        )
    );
    // clang-format on

    return GST_PAD_PROBE_OK;
}

static gboolean on_recording_stop_timeout(gpointer user_data) {
    Media* media = user_data;
    MediaCompletionHandler handler = media->recording_completion_handler;
    gpointer completion_data = media->recording_completion_data;

    g_clear_pointer(&media->recording_stop_timeout, g_source_unref);
    gst_pad_remove_probe(media->recording_tee_pad, media->recording_block_probe);

    media->recording_block_probe = 0;
    media->recording_completion_handler = NULL;
    media->recording_completion_data = NULL;

    handler("Timed out draining microphone audio before finalizing the recording", completion_data);
    return G_SOURCE_REMOVE;
}

// clang-format off
static GstElement* create_render_pipeline(
    const gchar* input,
    const gchar* recording_output,
    const gchar* merged_output,
    gdouble recording_gain,
    gdouble headphone_gain,
    GError** error
) {
    // clang-format on
    GstCaps* caps;

    GstElement* pipeline = gst_pipeline_new("audio-gain-recording-render");
    GstElement* source = gst_element_factory_make("filesrc", NULL);
    GstElement* parser = gst_element_factory_make("wavparse", NULL);
    GstElement* convert = gst_element_factory_make("audioconvert", NULL);
    GstElement* volume = gst_element_factory_make("volume", "recording_gain_volume");
    GstElement* capsfilter = gst_element_factory_make("capsfilter", NULL);
    GstElement* tee = gst_element_factory_make("tee", NULL);
    GstElement* recording_queue = gst_element_factory_make("queue", NULL);
    GstElement* encoder = gst_element_factory_make("wavenc", NULL);
    GstElement* sink = gst_element_factory_make("filesink", NULL);
    GstElement* merged_queue = gst_element_factory_make("queue", NULL);
    GstElement* headphone_volume = gst_element_factory_make("volume", "headphone_gain_volume");
    GstElement* merged_encoder = gst_element_factory_make("wavenc", NULL);
    GstElement* merged_sink = gst_element_factory_make("filesink", NULL);

    // clang-format off
    if (
        pipeline == NULL ||
        source == NULL ||
        parser == NULL ||
        convert == NULL ||
        volume == NULL ||
        capsfilter == NULL ||
        tee == NULL ||
        recording_queue == NULL ||
        encoder == NULL ||
        sink == NULL ||
        merged_queue == NULL ||
        headphone_volume == NULL ||
        merged_encoder == NULL ||
        merged_sink == NULL
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_MISSING_PLUGIN,
            "Failed to create audio gain render elements"
        );

        if (pipeline != NULL) {
            gst_object_unref(pipeline);
        }
        if (source != NULL) {
            gst_object_unref(source);
        }
        if (parser != NULL) {
            gst_object_unref(parser);
        }
        if (convert != NULL) {
            gst_object_unref(convert);
        }
        if (volume != NULL) {
            gst_object_unref(volume);
        }
        if (capsfilter != NULL) {
            gst_object_unref(capsfilter);
        }
        if (tee != NULL) {
            gst_object_unref(tee);
        }
        if (recording_queue != NULL) {
            gst_object_unref(recording_queue);
        }
        if (encoder != NULL) {
            gst_object_unref(encoder);
        }
        if (sink != NULL) {
            gst_object_unref(sink);
        }
        if (merged_queue != NULL) {
            gst_object_unref(merged_queue);
        }
        if (headphone_volume != NULL) {
            gst_object_unref(headphone_volume);
        }
        if (merged_encoder != NULL) {
            gst_object_unref(merged_encoder);
        }
        if (merged_sink != NULL) {
            gst_object_unref(merged_sink);
        }
        
        return NULL;
    }
    // clang-format on

    // clang-format off
    caps = gst_caps_new_simple(
        "audio/x-raw",
        "format", G_TYPE_STRING, "S16LE",
        "rate", G_TYPE_INT, 48000,
        "channels", G_TYPE_INT, 1,
        NULL
    );

    g_object_set(source, "location", input, NULL);
    g_object_set(volume, "volume", recording_gain, NULL);
    g_object_set(headphone_volume, "volume", headphone_gain, NULL);
    g_object_set(capsfilter, "caps", caps, NULL);
    g_object_set(sink, "location", recording_output, "sync", FALSE, NULL);
    g_object_set(merged_sink, "location", merged_output, "sync", FALSE, NULL);
    gst_caps_unref(caps);
    
    gst_bin_add_many(
        GST_BIN(pipeline),
        source,
        parser,
        convert,
        volume,
        capsfilter,
        tee,
        recording_queue,
        encoder,
        sink,
        merged_queue,
        headphone_volume,
        merged_encoder,
        merged_sink,
        NULL
    );
    
    if (
        !gst_element_link_many(source, parser, convert, volume, capsfilter, tee, NULL) ||
        !gst_element_link_many(tee, recording_queue, encoder, sink, NULL) ||
        !gst_element_link_many(tee, merged_queue, headphone_volume, merged_encoder, merged_sink, NULL)
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_NEGOTIATION,
            "Failed to link audio gain render elements"
        );
        gst_object_unref(pipeline);
        return NULL;
    }
    // clang-format on

    return pipeline;
}

static void finish_render(Media* media, const gchar* error) {
    MediaCompletionHandler handler = media->render_completion_handler;
    gpointer completion_data = media->render_completion_data;

    if (media->render_bus_watch != 0) {
        g_source_remove(media->render_bus_watch);
        media->render_bus_watch = 0;
    }

    gst_element_set_state(media->render_pipeline, GST_STATE_NULL);
    gst_object_unref(media->render_pipeline);

    media->render_pipeline = NULL;
    media->render_completion_handler = NULL;
    media->render_completion_data = NULL;

    handler(error, completion_data);
}

static gboolean on_render_bus_message(GstBus* bus, GstMessage* message, gpointer user_data) {
    Media* media = user_data;

    (void)bus;

    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_EOS) {
        g_printerr("audio_gain_recording and audio_gain_merged rendered\n");
        media->render_bus_watch = 0;

        finish_render(media, NULL);
        return G_SOURCE_REMOVE;
    }
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError* error = NULL;
        gchar* debug = NULL;
        gchar* message_text;

        gst_message_parse_error(message, &error, &debug);
        message_text = g_strdup(error->message);

        g_clear_error(&error);
        g_free(debug);
        media->render_bus_watch = 0;

        finish_render(media, message_text);
        g_free(message_text);
        return G_SOURCE_REMOVE;
    }

    return G_SOURCE_CONTINUE;
}

// clang-format off
Media* media_new(
    GMainContext* context,
    MediaIceHandler ice_handler,
    MediaEventHandler event_handler,
    gpointer user_data,
    GError** error
) {
    const gchar* pipeline_description =
        "webrtcbin name=webrtc bundle-policy=max-bundle "
        "input-selector name=playback_selector ! "
        "queue max-size-time=100000000 max-size-buffers=0 max-size-bytes=0 leaky=no flush-on-eos=false ! "
        "volume name=content_gain volume=1.0 ! "
        "volume name=headphone_gain volume=0.1 ! "
        "opusenc bitrate=128000 audio-type=voice dtx=false frame-size=20 ! "
        "rtpopuspay name=outgoing_payloader ! capsfilter name=outgoing_caps "
        "audiotestsrc is-live=true wave=silence ! "
        "queue max-size-time=100000000 max-size-buffers=0 max-size-bytes=0 leaky=no flush-on-eos=false ! "
        "audioconvert ! audioresample ! "
        "audio/x-raw,format=S16LE,rate=48000,channels=1 ! playback_selector.";
    const gchar* receive_description =
        "queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! "
        "audio/x-raw,rate=48000,channels=1 ! tee name=microphone_tee "
        "microphone_tee. ! queue ! "
        "fakesink name=microphone_sink sync=false async=false signal-handoffs=true";
    
    Media* media = g_new0(Media, 1);
    GstElement* microphone_sink;
    MicrophoneWatch* microphone_watch;
    GstBus* bus;
    GstPad* outgoing_pad;
    GstWebRTCICE* ice = NULL;
    gboolean loopback_added = FALSE;

    media->context = g_main_context_ref(context);
    media->ice_handler = ice_handler;
    media->event_handler = event_handler;
    media->user_data = user_data;
    
    g_queue_init(&media->remote_candidates);
    media->pipeline = gst_parse_launch(pipeline_description, error);
    
    if (media->pipeline == NULL) {
        g_free(media);
        return NULL;
    }

    media->webrtc = gst_bin_get_by_name(GST_BIN(media->pipeline), "webrtc");

    // Explicit IP address bypasses libnice interface discovery which excludes loopback
    // (Important for machines without NICs)
    if (media->webrtc != NULL) {
        g_object_get(media->webrtc, "ice-agent", &ice, NULL);
        
        if (ice != NULL) {
            g_signal_emit_by_name(ice, "add-local-ip-address", "127.0.0.1", &loopback_added);
            gst_object_unref(ice);
        }
    }
    if (!loopback_added) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Failed to configure WebRTC ICE for 127.0.0.1"
        );

        g_clear_object(&media->webrtc);
        gst_object_unref(media->pipeline);
        g_main_context_unref(media->context);
        g_free(media);

        return NULL;
    }

    media->payloader = gst_bin_get_by_name(GST_BIN(media->pipeline), "outgoing_payloader");
    media->capsfilter = gst_bin_get_by_name(GST_BIN(media->pipeline), "outgoing_caps");
    media->selector = gst_bin_get_by_name(GST_BIN(media->pipeline), "playback_selector");
    media->content_gain = gst_bin_get_by_name(GST_BIN(media->pipeline), "content_gain");
    media->headphone_gain = gst_bin_get_by_name(GST_BIN(media->pipeline), "headphone_gain");
    media->receive_bin = gst_parse_bin_from_description(receive_description, TRUE, error);
    
    if (
        media->payloader == NULL ||
        media->capsfilter == NULL ||
        media->selector == NULL ||
        media->content_gain == NULL ||
        media->headphone_gain == NULL ||
        media->receive_bin == NULL
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_MISSING_PLUGIN,
            "Failed to create required WebRTC audio elements"
        );

        gst_object_unref(media->pipeline);
        g_free(media);

        return NULL;
    }

    gst_bin_add(GST_BIN(media->pipeline), media->receive_bin);
    media->microphone_tee = gst_bin_get_by_name(GST_BIN(media->receive_bin), "microphone_tee");
    
    if (media->microphone_tee == NULL) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_MISSING_PLUGIN,
            "Failed to create microphone recording tee"
        );

        gst_object_unref(media->pipeline);
        g_free(media);

        return NULL;
    }
    
    media->silence_pad = gst_element_get_static_pad(media->selector, "sink_0");
    media->recording_gain = 0.1;

    microphone_sink = gst_bin_get_by_name(GST_BIN(media->receive_bin), "microphone_sink");
    microphone_watch = g_new0(MicrophoneWatch, 1);
    microphone_watch->media = media;
    
    g_signal_connect_data(
        microphone_sink,
        "handoff",
        G_CALLBACK(on_microphone_handoff),
        microphone_watch,
        free_microphone_watch,
        0
    );
    gst_object_unref(microphone_sink);
    
    g_signal_connect(media->webrtc, "on-ice-candidate", G_CALLBACK(on_ice_candidate), media);
    g_signal_connect(media->webrtc, "pad-added", G_CALLBACK(on_incoming_pad), media);
    g_signal_connect(media->webrtc, "notify::connection-state", G_CALLBACK(on_connection_state), media);

    bus = gst_element_get_bus(media->pipeline);
    gst_bus_add_watch(bus, on_bus_message, media);
    gst_object_unref(bus);

    if (gst_element_set_state(media->pipeline, GST_STATE_READY) == GST_STATE_CHANGE_FAILURE) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_STATE_CHANGE,
            "Failed to prepare WebRTC pipeline"
        );

        gst_object_unref(media->pipeline);
        g_free(media);
        
        return NULL;
    }

    g_mutex_init(&media->playback_mutex);

    outgoing_pad = gst_element_get_static_pad(media->payloader, "src");
    gst_pad_add_probe(
        outgoing_pad,
        GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST,
        on_outgoing_rtp,
        media,
        NULL
    );
    gst_object_unref(outgoing_pad);

    return media;
}
// clang-format on

void media_set_remote_offer(Media* media, const gchar* sdp, MediaAnswerHandler answer_handler, gpointer user_data) {
    GstSDPMessage* message = NULL;
    GstWebRTCSessionDescription* offer;
    OfferOperation* operation;
    GstPromise* promise;
    guint payload_type;
    GError* error = NULL;

    if (media->offer_in_progress || media->remote_description_set) {
        answer_handler(NULL, "A WebRTC offer is already active", user_data);
        return;
    }
    media->offer_in_progress = TRUE;

    // Parse and validate the remote SDP offer
    // clang-format off
    if (
        gst_sdp_message_new(&message) != GST_SDP_OK ||
        gst_sdp_message_parse_buffer((const guint8*)sdp, strlen(sdp), message) != GST_SDP_OK
    ) {
        // clang-format on
        if (message != NULL) {
            gst_sdp_message_free(message);
        }

        media->offer_in_progress = FALSE;
        answer_handler(NULL, "Offer SDP is invalid", user_data);

        return;
    }

    // Configure outgoing audio for the Opus payload advertised by the offer
    if (!find_opus_payload(message, &payload_type) || !link_outgoing_audio(media, payload_type, &error)) {
        gst_sdp_message_free(message);

        media->offer_in_progress = FALSE;
        answer_handler(NULL, error == NULL ? "Offer does not contain Opus audio" : error->message, user_data);

        g_clear_error(&error);
        return;
    }

    offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, message);
    operation = g_new0(OfferOperation, 1);
    operation->media = media;
    operation->handler = answer_handler;
    operation->user_data = user_data;

    promise = gst_promise_new_with_change_func(on_remote_description_set, operation, NULL);
    g_signal_emit_by_name(media->webrtc, "set-remote-description", offer, promise);
    gst_webrtc_session_description_free(offer);
}

// clang-format off
gboolean media_add_remote_ice_candidate(
    Media* media,
    guint sdp_media_index,
    const gchar* candidate,
    MediaCompletionHandler completion_handler,
    gpointer user_data,
    GError** error
) {
    RemoteCandidate* queued;

    if (candidate == NULL || candidate[0] == '\0') {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_NEGOTIATION,
            "ICE candidate is empty"
        );
        return FALSE;
    }

    queued = g_new0(RemoteCandidate, 1);
    queued->media = media;
    queued->sdp_media_index = sdp_media_index;
    queued->candidate = g_strdup(candidate);
    queued->handler = completion_handler;
    queued->user_data = user_data;

    if (!media->remote_description_set) {
        g_queue_push_tail(&media->remote_candidates, queued);
        return TRUE;
    }

    submit_remote_candidate(queued);
    return TRUE;
}
// clang-format on

static gboolean media_files_equal(GFile* left, GFile* right) {
    if (g_file_equal(left, right)) {
        return TRUE;
    }

    GFileInfo* left_info = g_file_query_info(left, G_FILE_ATTRIBUTE_ID_FILE, G_FILE_QUERY_INFO_NONE, NULL, NULL);
    GFileInfo* right_info = g_file_query_info(right, G_FILE_ATTRIBUTE_ID_FILE, G_FILE_QUERY_INFO_NONE, NULL, NULL);
    gboolean equal = FALSE;

    // clang-format off
    if (
        left_info != NULL && right_info != NULL &&
        g_file_info_has_attribute(left_info, G_FILE_ATTRIBUTE_ID_FILE) &&
        g_file_info_has_attribute(right_info, G_FILE_ATTRIBUTE_ID_FILE)
    ) {
        const gchar* left_id = g_file_info_get_attribute_string(left_info, G_FILE_ATTRIBUTE_ID_FILE);
        const gchar* right_id = g_file_info_get_attribute_string(right_info, G_FILE_ATTRIBUTE_ID_FILE);
        equal = left_id != NULL && right_id != NULL && g_str_equal(left_id, right_id);
    }
    // clang-format on

    g_clear_object(&left_info);
    g_clear_object(&right_info);

    return equal;
}

static gboolean media_paths_collide(const gchar* left, const gchar* right) {
    GFile* files[] = {g_file_new_for_path(left), g_file_new_for_path(right)};
    gboolean equal = media_files_equal(files[0], files[1]);

    // clang-format off
    if (!equal) {

        // A future output can be reached through a dangling file symlink or aliased parent
        for (guint index = 0; index < G_N_ELEMENTS(files); index++) {
            for (guint depth = 0; depth < 40; depth++) {
                GFileInfo* info = g_file_query_info(
                    files[index],
                    G_FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
                    G_FILE_QUERY_INFO_NOFOLLOW_SYMLINKS,
                    NULL,
                    NULL
                );

                if (info == NULL) {
                    break;
                }

                const gchar* target = NULL;
                if (g_file_info_has_attribute(info, G_FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET)) {
                    target = g_file_info_get_symlink_target(info);
                }
                
                GFile* parent = g_file_get_parent(files[index]);
                if (target == NULL || parent == NULL) {
                    g_clear_object(&parent);
                    g_object_unref(info);
                    break;
                }

                GFile* next = g_file_resolve_relative_path(parent, target);
                g_object_unref(parent);
                g_object_unref(info);
                g_object_unref(files[index]);
                files[index] = next;
            }
        }

        // Conservatively reject ASCII case-only aliases including outputs that do not exist yet
        equal = g_ascii_strcasecmp(g_file_peek_path(files[0]), g_file_peek_path(files[1])) == 0;
        if (!equal) {
            gchar* left_name = g_file_get_basename(files[0]);
            gchar* right_name = g_file_get_basename(files[1]);
            GFile* left_parent = g_file_get_parent(files[0]);
            GFile* right_parent = g_file_get_parent(files[1]);

            if (left_parent != NULL && right_parent != NULL && g_ascii_strcasecmp(left_name, right_name) == 0) {
                equal = media_files_equal(left_parent, right_parent);
            }

            g_free(left_name);
            g_free(right_name);
            g_clear_object(&left_parent);
            g_clear_object(&right_parent);
        }
    }
    // clang-format on

    g_object_unref(files[0]);
    g_object_unref(files[1]);

    return equal;
}

// clang-format off
gboolean media_configure(
    Media* media,
    const gchar* p501_f1,
    const gchar* p501_f2,
    const gchar* audio_baseline,
    const gchar* audio_gain_recording,
    const gchar* audio_gain_merged,
    GError** error
) {
    const gchar* paths[] = {p501_f1, p501_f2, audio_baseline, audio_gain_recording, audio_gain_merged};

    if (media->configured) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Media session is already configured"
        );
        return FALSE;
    }

    for (guint index = 0; index < G_N_ELEMENTS(paths); index++) {
        if (paths[index] == NULL || paths[index][0] == '\0') {
            g_set_error_literal(
                error,
                GST_CORE_ERROR,
                GST_CORE_ERROR_FAILED,
                "Configured media path is empty"
            );
            return FALSE;
        }
    }

    if (
        !g_file_test(p501_f1, G_FILE_TEST_IS_REGULAR) ||
        !g_file_test(p501_f2, G_FILE_TEST_IS_REGULAR)
    ) {
        g_set_error_literal(
            error,
            GST_RESOURCE_ERROR,
            GST_RESOURCE_ERROR_NOT_FOUND,
            "Configured P.501 path is not a readable file"
        );
        return FALSE;
    }
    if (
        media_paths_collide(audio_baseline, audio_gain_recording) ||
        media_paths_collide(audio_baseline, audio_gain_merged) ||
        media_paths_collide(audio_gain_recording, audio_gain_merged)
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "audio_baseline, audio_gain_recording and audio_gain_merged paths must differ"
        );
        return FALSE;
    }

    media->p501_f1 = g_strdup(p501_f1);
    media->p501_f2 = g_strdup(p501_f2);
    media->audio_baseline = g_strdup(audio_baseline);
    media->audio_gain_recording = g_strdup(audio_gain_recording);
    media->audio_gain_merged = g_strdup(audio_gain_merged);
    media->configured = TRUE;

    return TRUE;
}
// clang-format on

// clang-format off
gboolean media_set_headphone_gain(Media* media, gdouble gain, GError** error) {
    if (!isfinite(gain) || gain < 0.0 || gain > 1.0) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Headphone gain must be finite and between 0 and 1"
        );
        return FALSE;
    }

    g_object_set(media->headphone_gain, "volume", gain, NULL);
    return TRUE;
}
// clang-format on

// clang-format off
gboolean media_set_recording_gain(Media* media, gdouble gain, GError** error) {
    if (!isfinite(gain) || gain < 0.0 || gain > 2.0) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Recording gain must be finite and between 0 and 2"
        );
        return FALSE;
    }

    media->recording_gain = gain;

    if (g_strcmp0(media->playback_source, "audio_baseline") == 0) {
        g_object_set(media->content_gain, "volume", gain, NULL);
    }

    return TRUE;
}
// clang-format on

gboolean media_start_playback(Media* media, const gchar* source, const gchar* playback_id, GError** error) {
    const gchar* path;
    gdouble content_gain;
    GstPad* source_pad;
    GstClockTime start_time = GST_CLOCK_TIME_NONE;
    GstClock* clock;

    // clang-format off
    if (!media->configured) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Media session is not configured"
        );
        return FALSE;
    }
    if (!media->connected) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "WebRTC is not connected"
        );
        return FALSE;
    }
    if (media->playback_bin != NULL || media->recording_bin != NULL || media->render_pipeline != NULL) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Another media activity is already active"
        );
        return FALSE;
    }
    // clang-format on

    if (g_strcmp0(source, "p501_f1") == 0) {
        path = media->p501_f1;
        content_gain = 1.0;
    } else if (g_strcmp0(source, "p501_f2") == 0) {
        path = media->p501_f2;
        content_gain = 1.0;
    } else if (g_strcmp0(source, "audio_baseline_replay") == 0) {
        path = media->audio_baseline;
        content_gain = 1.0;
    } else if (g_strcmp0(source, "audio_baseline") == 0) {
        path = media->audio_baseline;
        content_gain = media->recording_gain;
    } else if (g_strcmp0(source, "audio_gain_recording") == 0) {
        path = media->audio_gain_recording;
        content_gain = 1.0;
    } else {
        // clang-format off
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Playback source is not approved"
        );
        // clang-format on
        return FALSE;
    }

    if (!g_file_test(path, G_FILE_TEST_IS_REGULAR)) {
        // clang-format off
        g_set_error_literal(
            error,
            GST_RESOURCE_ERROR,
            GST_RESOURCE_ERROR_NOT_FOUND,
            "Playback source file does not exist"
        );
        // clang-format on
        return FALSE;
    }

    cancel_playback_completion(media);
    clock = gst_element_get_clock(media->pipeline);

    // clang-format off
    if (clock != NULL) {
        GstClockTime now = gst_clock_get_time(clock);
        GstClockTime base_time = gst_element_get_base_time(media->pipeline);

        if (
            GST_CLOCK_TIME_IS_VALID(now) &&
            GST_CLOCK_TIME_IS_VALID(base_time) &&
            now >= base_time &&
            now - base_time <= G_MAXINT64
        ) {
            start_time = now - base_time;
        }
        gst_object_unref(clock);
    }
    if (!GST_CLOCK_TIME_IS_VALID(start_time)) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_CLOCK,
            "Playback pipeline clock is unavailable"
        );
        
        return FALSE;
    }
    // clang-format on

    media->playback_bin = create_playback_bin(path, start_time, error);
    if (media->playback_bin == NULL) {
        return FALSE;
    }

    gst_bin_add(GST_BIN(media->pipeline), media->playback_bin);

    media->playback_pad = gst_element_request_pad_simple(media->selector, "sink_%u");
    source_pad = gst_element_get_static_pad(media->playback_bin, "src");
    PlaybackMarker* marker = g_new0(PlaybackMarker, 1);

    marker->media = media;
    marker->bin = media->playback_bin;
    marker->generation = media->playback_generation;
    marker->start_time = start_time;
    marker->end_time = GST_CLOCK_TIME_NONE;
    marker->timing_valid = TRUE;

    // clang-format off
    gst_pad_add_probe(
        source_pad,
        GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM,
        on_playback_event,
        marker,
        g_free
    );
    // clang-format on

    if (media->playback_pad == NULL || gst_pad_link(source_pad, media->playback_pad) != GST_PAD_LINK_OK) {
        gst_object_unref(source_pad);
        clear_playback(media, NULL);

        // clang-format off
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_NEGOTIATION,
            "Failed to link playback source"
        );
        // clang-format on

        return FALSE;
    }
    gst_object_unref(source_pad);

    media->playback_id = g_strdup(playback_id);
    media->playback_source = g_strdup(source);

    g_printerr("Playback started: %s (%s, content gain %.3f)\n", playback_id, source, content_gain);
    g_object_set(media->content_gain, "volume", content_gain, NULL);
    g_object_set(media->selector, "active-pad", media->playback_pad, NULL);

    if (!gst_element_sync_state_with_parent(media->playback_bin)) {
        clear_playback(media, NULL);

        // clang-format off
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_STATE_CHANGE,
            "Failed to start playback source"
        );
        // clang-format on

        return FALSE;
    }

    return TRUE;
}

gboolean media_stop_playback(Media* media, GError** error) {
    if (media->playback_bin == NULL) {
        cancel_playback_completion(media);

        // clang-format off
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Playback is not active"
        );
        // clang-format on

        return FALSE;
    }
    clear_playback(media, NULL);

    return TRUE;
}

// clang-format off
gboolean media_start_audio_baseline(
    Media* media,
    MediaCompletionHandler completion_handler,
    gpointer user_data,
    GError** error
) {
    GstPad* bin_sink;
    GstPad* file_sink;

    if (
        !media->configured ||
        !media->connected
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Configured WebRTC connection is required for recording"
        );
        return FALSE;
    }
    if (
        media->playback_bin != NULL ||
        media->recording_bin != NULL ||
        media->render_pipeline != NULL
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Another media activity is already active"
        );
        return FALSE;
    }

    media->recording_bin = create_recording_bin(media->audio_baseline, &media->recording_sink, error);
    if (media->recording_bin == NULL) {
        return FALSE;
    }
    
    gst_bin_add(GST_BIN(media->receive_bin), media->recording_bin);
    media->recording_start_handler = completion_handler;
    media->recording_start_data = user_data;
    
    file_sink = gst_element_get_static_pad(media->recording_sink, "sink");
    media->recording_start_probe = gst_pad_add_probe(file_sink, GST_PAD_PROBE_TYPE_BUFFER, on_recording_first_buffer, media, NULL);
    gst_object_unref(file_sink);
    
    if (media->recording_start_probe == 0) {
        cleanup_recording(media);

        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Failed to monitor audio_baseline recording start"
        );

        return FALSE;
    }
    if (!gst_element_sync_state_with_parent(media->recording_bin)) {
        cleanup_recording(media);

        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_STATE_CHANGE,
            "Failed to start audio_baseline recording branch"
        );

        return FALSE;
    }

    media->recording_tee_pad = gst_element_request_pad_simple(media->microphone_tee, "src_%u");
    bin_sink = gst_element_get_static_pad(media->recording_bin, "sink");
    
    if (
        media->recording_tee_pad == NULL ||
        gst_pad_link(media->recording_tee_pad, bin_sink) != GST_PAD_LINK_OK
    ) {
        gst_object_unref(bin_sink);
        cleanup_recording(media);
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_NEGOTIATION,
            "Failed to attach audio_baseline recording branch"
        );
        return FALSE;
    }
    gst_object_unref(bin_sink);

    return TRUE;
}
// clang-format on

// clang-format off
gboolean media_stop_audio_baseline(
    Media* media,
    MediaCompletionHandler completion_handler,
    gpointer user_data,
    GError** error
) {
    GstClock* clock;
    GstClockTime now;
    GstClockTime base_time;
    RecordingStop* stop;

    if (
        media->recording_bin == NULL ||
        media->recording_completion_handler != NULL
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "audio_baseline recording is not active"
        );
        return FALSE;
    }

    clock = gst_element_get_clock(media->pipeline);
    now = clock == NULL ? GST_CLOCK_TIME_NONE : gst_clock_get_time(clock);
    base_time = gst_element_get_base_time(media->pipeline);
    gst_clear_object(&clock);

    if (!GST_CLOCK_TIME_IS_VALID(now) || !GST_CLOCK_TIME_IS_VALID(base_time) || now < base_time) {
        g_set_error_literal(error, GST_CORE_ERROR, GST_CORE_ERROR_CLOCK, "Microphone recording clock is unavailable");
        return FALSE;
    }

    media->recording_stop_time = now - base_time;
    media->recording_completion_handler = completion_handler;
    media->recording_completion_data = user_data;

    stop = g_new(RecordingStop, 1);
    stop->bin = gst_object_ref(media->recording_bin);
    stop->stop_time = media->recording_stop_time;

    media->recording_block_probe = gst_pad_add_probe(
        media->recording_tee_pad,
        GST_PAD_PROBE_TYPE_BLOCK | GST_PAD_PROBE_TYPE_BUFFER,
        on_recording_buffer,
        stop,
        free_recording_stop
    );
    
    if (media->recording_block_probe == 0) {
        media->recording_completion_handler = NULL;
        media->recording_completion_data = NULL;

        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Failed to block audio_baseline recording branch"
        );

        return FALSE;
    }

    // Fail before the control protocols 3s request deadline rather than saving a truncated take
    media->recording_stop_timeout = g_timeout_source_new(2000);
    g_source_set_callback(media->recording_stop_timeout, on_recording_stop_timeout, media, NULL);
    g_source_attach(media->recording_stop_timeout, media->context);

    return TRUE;
}
// clang-format on

// clang-format off
gboolean media_render_audio_gain_recording(
    Media* media,
    MediaCompletionHandler completion_handler,
    gpointer user_data,
    GError** error
) {
    GstBus* bus;
    gdouble headphone_gain;

    if (
        !media->configured ||
        !g_file_test(media->audio_baseline, G_FILE_TEST_IS_REGULAR)
    ) {
        g_set_error_literal(
            error,
            GST_RESOURCE_ERROR,
            GST_RESOURCE_ERROR_NOT_FOUND,
            "audio_baseline does not exist"
        );
        return FALSE;
    }

    if (
        media->playback_bin != NULL ||
        media->recording_bin != NULL ||
        media->render_pipeline != NULL
    ) {
        g_set_error_literal(
            error,
            GST_CORE_ERROR,
            GST_CORE_ERROR_FAILED,
            "Another media activity is already active"
        );
        return FALSE;
    }

    g_object_get(media->headphone_gain, "volume", &headphone_gain, NULL);
    media->render_pipeline = create_render_pipeline(
        media->audio_baseline, media->audio_gain_recording, media->audio_gain_merged,
        media->recording_gain, headphone_gain, error
    );

    if (media->render_pipeline == NULL) {
        return FALSE;
    }
    
    media->render_completion_handler = completion_handler;
    media->render_completion_data = user_data;

    bus = gst_element_get_bus(media->render_pipeline);
    media->render_bus_watch = gst_bus_add_watch(bus, on_render_bus_message, media);
    gst_object_unref(bus);

    if (gst_element_set_state(media->render_pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        finish_render(media, "Failed to start audio gain render");
        return TRUE;
    }

    return TRUE;
}
// clang-format on

void media_stop(Media* media) {
    if (media == NULL) {
        return;
    }

    clear_playback(media, NULL);

    if (media->recording_bin != NULL) {
        MediaCompletionHandler handler = media->recording_completion_handler;
        gpointer completion_data = media->recording_completion_data;

        cleanup_recording(media);
        media->recording_completion_handler = NULL;
        media->recording_completion_data = NULL;
        
        if (handler != NULL) {
            handler("Recording interrupted by shutdown", completion_data);
        }
    }
    if (media->render_pipeline != NULL) {
        finish_render(media, "Render interrupted by shutdown");
    }

    gst_element_set_state(media->pipeline, GST_STATE_NULL);
}

guint32 media_playback_timing_get_rtp_timestamp(const MediaPlaybackTiming* timing) {
    return timing->rtp_timestamp;
}

guint32 media_playback_timing_get_ssrc(const MediaPlaybackTiming* timing) {
    return timing->ssrc;
}
