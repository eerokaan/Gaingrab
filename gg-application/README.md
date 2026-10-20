# Gaingrab Application

## Introduction

Gaingrab Application (abbreviated to `gg-application`) is the participant-facing interface of Gaingrab - a desktop application available for Linux and Windows that guides participants through headphone calibration, voice recording, playback adjustment, and loudness ratings, collecting the results needed for later analysis.

The application bundles the [Gaingrab Media Engine](../gg-mediaengine/README.md) to handle audio playback, recording, and processing. The engine is managed automatically, so there is no separate installation or operation required. Sessions run locally without an external server or an Internet connection.

For an overview of the research tool and its components, please refer to the [main Gaingrab README](../README.md).

## Getting Started

### Linux

In the directory containing the Gaingrab AppImage, make it executable and launch it:

```sh
chmod +x Gaingrab-*-Linux.AppImage
./Gaingrab-*-Linux.AppImage
```

On some systems where AppArmor's restrictions on unprivileged user namespaces prevent the AppImage from starting, you may need to run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns = 0` before launching it again.

### Windows

Run the Gaingrab installer `Gaingrab-*-Windows.exe`, then launch Gaingrab from the Start Menu or the installed executable.

### Equipment Preparation

Connect the headphones and microphone before starting the application. Please make sure to keep operating-system, device, and other application volume settings unchanged throughout the session, adjusting listening levels only through Gaingrab.

## Running a Session

The application provides on-screen instructions throughout the procedure. Each session follows these steps:

1. **Welcome:** Select English or German and the Female or Male option, then confirm the headphone and volume instructions.
2. **Audio Setup:** Select the microphone and headphone devices to use for the session.
3. **Headphone Calibration:** Listen to the reference speech and adjust the slider until it is comfortably loud. Once confirmed, this headphone level remains fixed for the rest of the session.
4. **Microphone Recording:** Position the microphone approximately 2 cm from your mouth if your equipment permits, and read the displayed passage at your normal speaking level. Keep the microphone in place. Listen to the recording and record another take if needed.
5. **Recorded-Voice Adjustment:** Adjust the playback level of your recording until it matches your preferred loudness, then confirm the setting.
6. **Loudness Ratings:** Listen to a reference clip and your adjusted recording, presented in random order, and rate each using the five-point loudness-preference scale. Listen to each clip in full before rating it; you may replay it if needed. Follow the application through to the completion screen.

The rating scale follows ITU-T Recommendation P.800, Annex B.4.5(c), ranging from `1` (much quieter than preferred) to `5` (much louder than preferred), with `3` representing the preferred loudness.

## Language and Reference Speech

Sessions are available in English and German. The language selection determines the interface text, while language and the Female or Male selection together determine the reference speech and reading passage. These selections remain fixed after confirmation and should be checked for each new participant.

The speech material comes from Annex C of ITU-T Recommendation P.501. Headphone calibration uses the first speech sample for the selected language and voice, and the participant reads its corresponding passage. The rating stage uses the second speech sample as a separate reference. The reading passages follow the selected source material rather than being translations of one common passage.

## Session Results

Results are saved automatically in a separate session folder under `gaingrab/` in the current user's home directory:

| Platform | Results Location                    |
| -------- | ----------------------------------- |
| Linux    | `~/gaingrab/<session>/`             |
| Windows  | `%USERPROFILE%\gaingrab\<session>\` |

Session folders are named using the local date and time at session startup. When combining results from several computers, please keep their origins distinguishable, as folder names alone are not globally unique.

Each completed session contains the following files:

| File                       | Contents                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| `session.json`             | Session information, confirmed gain settings, and loudness ratings |
| `audio_baseline.wav`       | The participant's recording before either Gaingrab gain is applied |
| `audio_gain_recording.wav` | The recording with the recorded-voice gain applied                 |
| `audio_gain_merged.wav`    | The recording with both recorded-voice and headphone gains applied |

The session information includes the session identifier, language and Female/Male selection, microphone and headphone device names, and both confirmed gains. The two ratings include the stimulus, presentation order, and response. In the saved ratings, `p501_f2` identifies the reference speech for either Female or Male selections, while `audio_gain_recording` identifies the participant's recording.

For the audio format, the meaning of the gains, and guidance on interpreting the exported recordings, please refer to the [Gaingrab Media Engine README](../gg-mediaengine/README.md#understanding-the-gains).
