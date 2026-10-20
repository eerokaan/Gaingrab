/*
 * Gaingrab Media Engine
 * @company Quality and Usability Lab | TU Berlin
 * @author  Eero Kaan <eerokaan@qu.tu-berlin.de>
 */

#ifndef GAINGRAB_ENGINE_H
#define GAINGRAB_ENGINE_H

#include <glib.h>
#include "cJSON.h"
#include "control.h"

// clang-format off
typedef struct Engine Engine;

Engine* engine_new(GMainLoop* loop);

void engine_attach_control(Engine* engine, Control* control);
void engine_emit_ready(Engine* engine);
void engine_handle_request(cJSON* request, gpointer user_data);

gboolean engine_initialize_media(Engine* engine, GMainContext* context, GError** error);
gboolean engine_failed(Engine* engine);
// clang-format on

#endif
