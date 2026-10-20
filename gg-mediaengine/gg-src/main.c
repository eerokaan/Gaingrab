/*
 * Gaingrab Media Engine
 * @company Quality and Usability Lab | TU Berlin
 * @author  Eero Kaan <eerokaan@qu.tu-berlin.de>
 */

#include <glib.h>
#include <stdlib.h>
#include <gst/gst.h>
#include "control.h"
#include "engine.h"

int main(int argc, char** argv) {
    Control* control;
    Engine* engine;
    GMainContext* context;
    GMainLoop* loop;

    // Initialize GStreamer and report the engine version
    gst_init(&argc, &argv);
    g_printerr("Gaingrab media engine ready\n");

    // Create the event loop and initialize the media engine
    context = g_main_context_default();
    loop = g_main_loop_new(context, FALSE);

    engine = engine_new(loop);
    GError* media_error = NULL;

    if (!engine_initialize_media(engine, context, &media_error)) {
        g_printerr("Failed to initialize media: %s\n", media_error->message);
        g_clear_error(&media_error);
        return EXIT_FAILURE;
    }

    // Start request handling and run the engine event loop
    control = control_new(context, engine_handle_request, engine);

    engine_attach_control(engine, control);
    control_start(control);
    engine_emit_ready(engine);
    g_main_loop_run(loop);
    control_stop(control);

    // Report shutdown and return the engine status
    g_printerr("Gaingrab media engine stopped\n");
    return engine_failed(engine) ? EXIT_FAILURE : EXIT_SUCCESS;
}
