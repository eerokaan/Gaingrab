# Gaingrab Media Engine

## Introduction

Gaingrab Media Engine (abbreviated to `gg-mediaengine`) is the audio-processing core of Gaingrab - the component responsible for reference speech playback, microphone recording, gain application, and preparing the audio files used for later analysis.

The engine is bundled with the [Gaingrab Application](../gg-application/README.md) and operates automatically throughout each session. Researchers and participants do not need to install or run it separately. For an overview of Gaingrab and its research purpose, please refer to the [main README](../README.md).

## Audio Processing

During a session, the media engine plays the reference speech, captures the participant's voice, and provides playback for listening and loudness adjustment. The original recording is preserved as a baseline, while additional versions are prepared using the participant's confirmed gain settings.

Reference speech selection and the participant workflow are described in the [application guide](../gg-application/README.md#running-a-session).

## Understanding the Gains

Gaingrab uses two gain settings, each serving a different purpose:

| Gain | Purpose |
| --- | --- |
| Headphone gain (`headphone_playback_gain`) | Sets the participant's preferred listening level for reference speech. Once confirmed, it remains fixed for subsequent playback. |
| Recorded-voice gain (`recording_playback_gain`) | Adjusts the playback level of the participant's own recording while retaining the confirmed headphone level. |

Both settings are saved as linear multipliers, not percentages or decibels. A value of `0` mutes the signal, `1` leaves its level unchanged, and values above `1` amplify it.

The microphone baseline is captured without either gain. Listening back to a take before recorded-voice adjustment applies only the headphone gain. During adjustment, the recorded-voice gain is applied first, followed by the headphone gain.

During the rating stage, the reference speech uses the headphone gain alone. The participant's recording already contains the confirmed recorded-voice gain, so only the headphone gain is applied during its playback. This avoids applying either gain twice.

## Exported Audio

Each completed session provides three versions of the participant's recording, all stored as mono, 48 kHz, 16-bit PCM WAV files with matching sample counts and durations:

| Recording | Processing |
| --- | --- |
| Baseline (`audio_baseline.wav`) | Contains neither gain and serves as the original recording for comparison. |
| Recording-adjusted (`audio_gain_recording.wav`) | Contains the recorded-voice gain only. This is the recording used for the participant's loudness rating, with headphone gain applied during playback. |
| Combined-gain (`audio_gain_merged.wav`) | Contains the recorded-voice gain followed by the headphone gain, each applied once. This version is provided for analysis and export, not as a rating stimulus. |

The baseline remains unchanged when the adjusted versions are created, and neither adjusted recording is normalized. For output-folder locations and the accompanying session information, please refer to [Session Results](../gg-application/README.md#session-results).

## Interpretation Limits

The baseline is unadjusted only with respect to Gaingrab's two gains. It has already passed through lossy audio encoding and decoding, and microphone, operating-system, or device processing may also have affected it. Saving as PCM WAV therefore does not imply lossless or entirely unprocessed capture.

Amplifying a recording can cause clipping when samples exceed the available 16-bit range. Since recorded-voice gain is applied before headphone gain, reducing the headphone level cannot recover samples that have already clipped. The combined-gain file therefore cannot always be reproduced by applying a single multiplier equal to the product of the two gains.

The combined-gain file represents Gaingrab's audio processing, not a measurement of the sound reaching the participant's ears. It does not include subsequent playback encoding, system or device processing, or external volume settings. Please do not apply the headphone gain again when interpreting this file, as it is already included.

These exports support analysis of preferred relative playback levels. Absolute sound pressure levels require external calibration and measurement rather than inference from the saved gains alone.

## Compilation

As the Gaingrab Media Engine uses GStreamer internally, the following paragraphs will lay out how to compile GStreamer and other prerequisites, as well as compiling and running Gaingrab Media Engine itself.

There are two important factors to consider, before starting:

- Please make sure to use Ubuntu 24.04 (or other Debian-based Linux distros) as your compiler host; We will cross-compile for Linux and Windows
- Please also make sure to work on a local filesystem, as compiling on network shares will most likely cause permission errors

### Step 1) Prepare Ubuntu

```
sudo -i
cd ~

dpkg --add-architecture i386
echo "check_certificate=off" >> ~/.wgetrc

apt-get -y update
apt-get -y upgrade
apt-get -y install python3 python3-venv git
apt-get -y install build-essential meson pkg-config gcc-mingw-w64-x86-64-posix
```

### Step 2) Build GStreamer SDK

```
git clone https://git.tu-berlin.de/qu/speech-quality/gaingrab.git Gaingrab
cd Gaingrab/gg-mediaengine

git clone https://gitlab.freedesktop.org/gstreamer/cerbero.git gst-sdk
cd gst-sdk

git checkout 1.28.7
```

#### Linux

```
./cerbero-uninstalled bootstrap
./cerbero-uninstalled build gstreamer-1.0
./cerbero-uninstalled build gst-plugins-base
./cerbero-uninstalled build gst-plugins-good
./cerbero-uninstalled build gst-plugins-bad
./cerbero-uninstalled build libnice
```

#### Windows

```
./cerbero-uninstalled -c config/cross-win64.cbc bootstrap
./cerbero-uninstalled -c config/cross-win64.cbc build gstreamer-1.0
./cerbero-uninstalled -c config/cross-win64.cbc build gst-plugins-base
./cerbero-uninstalled -c config/cross-win64.cbc build gst-plugins-good
./cerbero-uninstalled -c config/cross-win64.cbc build gst-plugins-bad
./cerbero-uninstalled -c config/cross-win64.cbc build libnice
```

### Step 3) Build Gaingrab Media Engine with GStreamer linking

```
cd ..
```

#### Linux

```
export SDK=$(pwd)/gst-sdk/build/dist/linux_x86_64
export PKG_CONFIG_PATH=$SDK/lib/x86_64-linux-gnu/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=$SDK
export LIBRARY_PATH=$SDK/lib/x86_64-linux-gnu

mkdir -p gst-lib/x86_64-linux-gnu/bin
mkdir -p gst-lib/x86_64-linux-gnu/lib
cp -a $SDK/bin/* gst-lib/x86_64-linux-gnu/bin/
cp -a $SDK/lib/x86_64-linux-gnu/* gst-lib/x86_64-linux-gnu/lib/

gcc -o gg-mediaengine \
    -std=c11 \
    -O3 -DNDEBUG \
    -DGST_USE_UNSTABLE_API \
    -Igg-src \
    -Igg-deps/cJSON \
    gg-src/main.c \
    gg-src/control.c \
    gg-src/engine.c \
    gg-src/media.c \
    gg-deps/cJSON/cJSON.c \
    $(pkg-config --cflags --libs \
        glib-2.0 \
        gio-2.0 \
        gstreamer-1.0 \
        gstreamer-sdp-1.0 \
        gstreamer-rtp-1.0 \
        gstreamer-webrtc-1.0) \
    -lm \
    -Wl,-rpath-link,$LIBRARY_PATH \
    -Wl,-rpath,'$ORIGIN/gst-lib/x86_64-linux-gnu/lib'
```

#### Windows

```
export SDK=$(pwd)/gst-sdk/build/dist/mingw_x86_64
export PKG_CONFIG_PATH=$SDK/lib/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=$SDK
export LIBRARY_PATH=$SDK/lib

mkdir -p gst-lib/x86_64-windows/bin
mkdir -p gst-lib/x86_64-windows/lib
cp -a $SDK/bin/* gst-lib/x86_64-windows/bin/
cp -a $SDK/lib/* gst-lib/x86_64-windows/lib/

x86_64-w64-mingw32-gcc-posix -o gg-mediaengine.exe \
    -std=c11 \
    -O3 -DNDEBUG \
    -DGST_USE_UNSTABLE_API \
    -Igg-src \
    -Igg-deps/cJSON \
    gg-src/main.c \
    gg-src/control.c \
    gg-src/engine.c \
    gg-src/media.c \
    gg-deps/cJSON/cJSON.c \
    $(pkg-config --cflags --libs \
        glib-2.0 \
        gio-2.0 \
        gstreamer-1.0 \
        gstreamer-sdp-1.0 \
        gstreamer-rtp-1.0 \
        gstreamer-webrtc-1.0) \
    -lm
```

### Step 5) Run Gaingrab Media Engine

Notice: Always `tar` the `gst-lib` directory when transferring it between machines. The symbolic link structure inside it can easily become corrupted when moving across different machines or platforms.

#### Linux

```
export LD_LIBRARY_PATH="$PWD/gst-lib/x86_64-linux-gnu/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GST_PLUGIN_PATH="$PWD/gst-lib/x86_64-linux-gnu/lib/gstreamer-1.0"
./gg-mediaengine
```

#### Windows

```bat
set "PATH=%CD%\gst-lib\x86_64-windows\bin;%PATH%"
set "GST_PLUGIN_PATH=%CD%\gst-lib\x86_64-windows\lib\gstreamer-1.0"
.\gg-mediaengine.exe
```
