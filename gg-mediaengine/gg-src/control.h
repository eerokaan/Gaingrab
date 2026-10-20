/*
 * Gaingrab Media Engine
 * @company Quality and Usability Lab | TU Berlin
 * @author  Eero Kaan <eerokaan@qu.tu-berlin.de>
 */

#ifndef GAINGRAB_CONTROL_H
#define GAINGRAB_CONTROL_H

#include <glib.h>
#include "cJSON.h"

// clang-format off
typedef struct Control Control;

typedef void (*ControlRequestHandler)(cJSON* request, gpointer user_data);

Control* control_new(GMainContext* context, ControlRequestHandler request_handler, gpointer user_data);

void control_start(Control* control);
void control_stop(Control* control);

gboolean control_send(Control* control, const cJSON* message);
// clang-format on

#endif
