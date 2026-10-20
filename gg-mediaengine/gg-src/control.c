/*
 * Gaingrab Media Engine
 * @company Quality and Usability Lab | TU Berlin
 * @author  Eero Kaan <eerokaan@qu.tu-berlin.de>
 */

#include <stdio.h>
#include <string.h>
#include "control.h"

typedef struct {
    Control* control;
    cJSON* request;
} PendingRequest;

struct Control {
    GMainContext* context;
    ControlRequestHandler request_handler;
    gpointer user_data;
    GMutex output_mutex;
    gint stopping;
};

static gboolean dispatch_request(gpointer user_data) {
    PendingRequest* pending = user_data;

    pending->control->request_handler(pending->request, pending->control->user_data);
    cJSON_Delete(pending->request);

    g_free(pending);
    return G_SOURCE_REMOVE;
}

static void queue_request(Control* control, cJSON* request) {
    PendingRequest* pending = g_new(PendingRequest, 1);

    pending->control = control;
    pending->request = request;

    g_main_context_invoke(control->context, dispatch_request, pending);
}

static void send_reader_error(Control* control, const gchar* code, const gchar* message) {
    cJSON* response = cJSON_CreateObject();
    cJSON* error = cJSON_CreateObject();

    cJSON_AddStringToObject(response, "type", "response");
    cJSON_AddNullToObject(response, "id");
    cJSON_AddBoolToObject(response, "ok", FALSE);
    cJSON_AddStringToObject(error, "code", code);
    cJSON_AddStringToObject(error, "message", message);
    cJSON_AddItemToObject(response, "error", error);

    control_send(control, response);
    cJSON_Delete(response);
}

static gpointer read_stdin(gpointer user_data) {
    Control* control = user_data;
    gchar line[64U * 1024U];

    while (!g_atomic_int_get(&control->stopping) && fgets(line, sizeof(line), stdin) != NULL) {
        const gboolean has_newline = strchr(line, '\n') != NULL;

        if (!has_newline && !feof(stdin)) {
            int character;

            do {
                character = fgetc(stdin);
            } while (character != '\n' && character != EOF);

            send_reader_error(control, "lineTooLong", "NDJSON request exceeds 64 KiB");
            continue;
        }

        g_strchomp(line);
        cJSON* request = cJSON_Parse(line);
        
        if (request == NULL) {
            send_reader_error(control, "invalidJson", "Request is not valid JSON");
            continue;
        }

        queue_request(control, request);
    }

    if (!g_atomic_int_get(&control->stopping)) {
        queue_request(control, NULL);
    }

    return NULL;
}

Control* control_new(GMainContext* context, ControlRequestHandler request_handler, gpointer user_data) {
    Control* control = g_new0(Control, 1);

    control->context = g_main_context_ref(context);
    control->request_handler = request_handler;
    control->user_data = user_data;

    g_mutex_init(&control->output_mutex);
    return control;
}

void control_start(Control* control) {
    GThread* thread = g_thread_new("control-stdin", read_stdin, control);
    g_thread_unref(thread);
}

void control_stop(Control* control) {
    g_atomic_int_set(&control->stopping, TRUE);
}

gboolean control_send(Control* control, const cJSON* message) {
    gchar* serialized = cJSON_PrintUnformatted(message);
    gboolean success = FALSE;

    if (serialized == NULL) {
        return FALSE;
    }

    g_mutex_lock(&control->output_mutex);
    if (fputs(serialized, stdout) >= 0 && fputc('\n', stdout) != EOF && fflush(stdout) == 0) {
        success = TRUE;
    }
    g_mutex_unlock(&control->output_mutex);

    cJSON_free(serialized);
    return success;
}
