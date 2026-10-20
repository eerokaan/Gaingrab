/*
 * Gaingrab Media Engine
 * @company Quality and Usability Lab | TU Berlin
 * @author  Eero Kaan <eerokaan@qu.tu-berlin.de>
 */

#ifndef GAINGRAB_MEDIA_H
#define GAINGRAB_MEDIA_H

#include <glib.h>

// clang-format off
typedef struct Media Media;
typedef struct MediaPlaybackTiming MediaPlaybackTiming;

typedef void (*MediaAnswerHandler)(const gchar* sdp, const gchar* error, gpointer user_data);
typedef void (*MediaIceHandler)(guint sdp_media_index, const gchar* candidate, gpointer user_data);
typedef void (*MediaEventHandler)(const gchar* event, const gchar* detail, const MediaPlaybackTiming* timing, gpointer user_data);
typedef void (*MediaCompletionHandler)(const gchar* error, gpointer user_data);

Media* media_new(GMainContext* context, MediaIceHandler ice_handler, MediaEventHandler event_handler, gpointer user_data, GError** error);

void media_set_remote_offer(Media* media, const gchar* sdp, MediaAnswerHandler answer_handler, gpointer user_data);
void media_stop(Media* media);

gboolean media_add_remote_ice_candidate(Media* media, guint sdp_media_index, const gchar* candidate, MediaCompletionHandler completion_handler, gpointer user_data, GError** error);
gboolean media_configure(Media* media, const gchar* p501_f1, const gchar* p501_f2, const gchar* audio_baseline, const gchar* audio_gain_recording, const gchar* audio_gain_merged, GError** error);
gboolean media_set_headphone_gain(Media* media, gdouble gain, GError** error);
gboolean media_set_recording_gain(Media* media, gdouble gain, GError** error);
gboolean media_start_playback(Media* media, const gchar* source, const gchar* playback_id, GError** error);
gboolean media_stop_playback(Media* media, GError** error);
gboolean media_start_audio_baseline(Media* media, MediaCompletionHandler completion_handler, gpointer user_data, GError** error);
gboolean media_stop_audio_baseline(Media* media, MediaCompletionHandler completion_handler, gpointer user_data, GError** error);
gboolean media_render_audio_gain_recording(Media* media, MediaCompletionHandler completion_handler, gpointer user_data, GError** error);

guint32 media_playback_timing_get_rtp_timestamp(const MediaPlaybackTiming* timing);
guint32 media_playback_timing_get_ssrc(const MediaPlaybackTiming* timing);
// clang-format on

#endif
