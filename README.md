# Gaingrab

## Introduction

Welcome to the Gaingrab repository.

Gaingrab is a research tool for determining participant-specific headphone and recorded-voice playback levels, where participants adjust the loudness of reference speech, record their own voice, and evaluate their preferred playback levels, enabling structured collection of recordings, gain settings, and loudness ratings for later analysis.

The procedure uses reference speech from ITU-T Recommendation P.501 and collects ratings on the loudness-preference scale from ITU-T Recommendation P.800. Gaingrab captures preferred relative playback levels rather than absolute sound pressure levels; measurements of physical headphone output require external calibration and measurement equipment.

## Architecture

**Gaingrab consists of two main parts, which are explained in detail in these README files:** The [**Gaingrab Media Engine**](./gg-mediaengine/README.md) and [**Gaingrab Application**](./gg-application/README.md).

`gg-mediaengine` is the audio-processing core of Gaingrab - the component responsible for playing reference speech, capturing the participant's voice, applying the selected gains, and preparing audio files for analysis. Its README explains how the audio is processed and what the exported recordings represent.

`gg-application` is the participant-facing interface of Gaingrab - a desktop application that bundles the media engine, guides participants through the session, and saves their recordings and evaluations. Its README covers installation, session preparation, the participant workflow, and retrieving results.

The application is available for Linux and Windows and runs locally, requiring neither an external server or an Internet connection. Sessions are available in English and German, with female or male reference speech, depending on the tests participant.

## Getting Started

To conduct a session, you will need headphones, a microphone, and the Gaingrab Application for your operating system. Please refer to the [application guide](./gg-application/README.md#getting-started) for launch instructions and equipment preparation, then follow the on-screen instructions during the session.

## Contact Info

For any further assistance and inquiries, please do not hesitate to contact Eero Kaan at [eerokaan@qu.tu-berlin.de](mailto:eerokaan@qu.tu-berlin.de).

Gaingrab was developed at the Quality and Usability Lab at TU Berlin.
