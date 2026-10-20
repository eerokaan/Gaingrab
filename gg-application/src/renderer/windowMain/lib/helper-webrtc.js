const processingSettings = ["echoCancellation", "noiseSuppression", "autoGainControl", "voiceIsolation"];

class AudioSession {
    constructor({ exchangeOffer, submitIceCandidate, reportFailure }) {
        this.transport = { exchangeOffer, submitIceCandidate, reportFailure };
        this.iceCandidatesPending = [];
        this.iceCandidateOperation = Promise.resolve();
        this.metaGeneration = 0;
        this.metaPlaybackWait = 0;
        this.metaClosing = true;
    }

    async prepare({ inputDeviceId, outputDeviceId }) {
        this.close();

        this.metaGeneration++;
        this.metaClosing = false;
        this.metaFailureReported = false;

        return this.prepareDevices({ inputDeviceId, outputDeviceId }, this.metaGeneration);
    }

    async prepareDevices({ inputDeviceId, outputDeviceId }, generation) {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: { exact: inputDeviceId },
                channelCount: 1,
                ...Object.fromEntries(processingSettings.map((setting) => [setting, false]))
            },
            video: false
        });

        if (this.metaClosing || generation !== this.metaGeneration) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error("Audio session stopped during device preparation");
        }

        this.audioStream = stream;

        const track = stream.getAudioTracks()[0];
        track.addEventListener("ended", () => {
            this.failConnection(new Error("The selected microphone track ended"), generation);
        });

        const settings = track.getSettings();
        for (const setting of processingSettings) {
            if (settings[setting] === true) {
                throw new Error(`Browser audio processing remains active: ${setting}`);
            }
        }

        const remoteAudio = document.createElement("audio");
        this.audioRemote = remoteAudio;

        remoteAudio.autoplay = true;
        remoteAudio.volume = 1;

        if (typeof remoteAudio.setSinkId !== "function") {
            throw new Error("Output-device selection is unavailable");
        }

        await remoteAudio.setSinkId(outputDeviceId);
        this.ensureActive(generation);
    }

    async connect() {
        const generation = this.metaGeneration;
        const { audioStream: stream, audioRemote: remoteAudio } = this;

        let resolveRemoteTrack;
        let rejectRemoteTrack;

        const remoteTrack = new Promise((resolve, reject) => {
            resolveRemoteTrack = resolve;
            rejectRemoteTrack = reject;
        });

        remoteTrack.catch(() => {});

        let failed = false;
        let failureError;
        let rejectConnect;

        const failure = new Promise((resolve, reject) => {
            rejectConnect = (error) => {
                if (failed) return;
                failed = true;
                failureError = error;
                reject(error);
                rejectRemoteTrack(error);
            };
        });
        this.handshakeReject = rejectConnect;

        try {
            const setup = (async () => {
                if (!stream || !remoteAudio) {
                    throw new Error("Audio devices must be prepared before WebRTC starts");
                }
                this.ensureActive(generation);

                const track = stream.getAudioTracks()[0];
                const peer = new RTCPeerConnection({ iceServers: [] });
                this.webrtcPeer = peer;

                peer.onconnectionstatechange = () => {
                    if (["failed", "disconnected"].includes(peer.connectionState)) {
                        this.failConnection(new Error(`The local WebRTC connection ${peer.connectionState}`), generation);
                    }
                };
                peer.addTransceiver(track, {
                    direction: "sendrecv",
                    streams: [stream]
                });
                peer.onicecandidate = ({ candidate }) => {
                    if (candidate && !this.metaClosing && generation === this.metaGeneration) {
                        this.transport.submitIceCandidate(candidate.toJSON()).catch((error) => this.failConnection(error, generation));
                    }
                };
                peer.ontrack = async ({ track: receivedTrack, receiver }) => {
                    try {
                        this.ensureActive(generation);
                        this.audioReceiver = receiver;

                        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 50;
                        remoteAudio.srcObject = new MediaStream([receivedTrack]);

                        await remoteAudio.play();
                        this.ensureActive(generation);

                        resolveRemoteTrack(receivedTrack);
                    }
                    catch (error) {
                        this.failConnection(error, generation);
                    }
                };

                const offer = await peer.createOffer();
                this.ensureActive(generation);

                await peer.setLocalDescription(offer);
                this.ensureActive(generation);

                const answer = await this.transport.exchangeOffer({
                    type: offer.type,
                    sdp: offer.sdp
                });
                this.ensureActive(generation);

                await peer.setRemoteDescription(answer);
                this.ensureActive(generation);

                await this.runCandidateOperation(generation, async () => {
                    const candidates = this.iceCandidatesPending;
                    this.iceCandidatesPending = [];

                    for (const candidate of candidates) {
                        this.ensureActive(generation);
                        await peer.addIceCandidate(candidate);
                    }
                });

                this.ensureActive(generation);
                await remoteTrack;
            })();

            await Promise.race([setup, failure]);
            this.ensureActive(generation);

            if (failed) throw failureError;
            return { ready: true };
        }
        catch (error) {
            rejectRemoteTrack(error);
            this.close(generation);
            throw error;
        }
        finally {
            if (this.handshakeReject === rejectConnect) this.handshakeReject = null;
        }
    }

    addEngineCandidate(candidate) {
        const generation = this.metaGeneration;

        return this.runCandidateOperation(generation, async () => {
            const { audioStream: stream, webrtcPeer: peer } = this;

            if (!stream) {
                throw new Error("Audio devices must be prepared before adding ICE candidates");
            }
            if (!peer || !peer.remoteDescription) {
                this.iceCandidatesPending.push(candidate);
                return { status: "queued" };
            }

            await peer.addIceCandidate(candidate);
            this.ensureActive(generation);

            return { status: "applied" };
        });
    }

    runCandidateOperation(generation, callback) {
        const operation = this.iceCandidateOperation.then(() => {
            this.ensureActive(generation);
            return callback();
        });
        this.iceCandidateOperation = operation.catch(() => {});

        return operation;
    }

    ensureActive(generation) {
        if (this.metaClosing || generation !== this.metaGeneration) {
            throw new Error("Audio session stopped");
        }
    }

    async waitForPlayback(boundary) {
        if (this.playbackReject) this.playbackReject(new Error("Playback wait was superseded"));

        let rejectWait;
        const cancelled = new Promise((resolve, reject) => {
            rejectWait = reject;
        });
        this.playbackReject = rejectWait;

        try {
            return await Promise.race([this.drainPlayback(boundary), cancelled]);
        }
        finally {
            if (this.playbackReject === rejectWait) this.playbackReject = null;
        }
    }

    async drainPlayback({ playback_id: playbackId, rtp_timestamp: endTimestamp, ssrc, timeoutMs }) {
        if (typeof playbackId !== "string" || ![endTimestamp, ssrc].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) {
            throw new Error("The media engine did not provide a valid playback boundary");
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error("Invalid playback drain timeout");
        }

        this.metaPlaybackWait++;
        const wait = this.metaPlaybackWait;
        const generation = this.metaGeneration;
        const receiver = this.audioReceiver;
        const audio = this.audioRemote;

        if (!receiver || !audio) {
            throw new Error("Audio output is unavailable");
        }

        const started = performance.now();
        const initialSource = receiver.getSynchronizationSources().find((source) => source.source === ssrc);

        let previousPlayout;
        let boundaryObservedAt;
        let outputDelayMs = 0;

        const ensureOutputActive = () => {
            this.ensureActive(generation);

            if (wait !== this.metaPlaybackWait) {
                throw new Error("Playback wait was superseded");
            }
            if (performance.now() - started >= timeoutMs) {
                throw new Error("Timed out waiting for the sample to finish playing");
            }
            if (!this.webrtcPeer || this.webrtcPeer.connectionState !== "connected" || receiver.track.readyState !== "live" || !receiver.track.enabled || receiver.track.muted || audio.paused || audio.muted || audio.volume === 0 || audio.error) {
                throw new Error("Audio output stopped before the sample finished");
            }
        };

        while (performance.now() - started < timeoutMs) {
            ensureOutputActive();
            const stats = await receiver.getStats();
            ensureOutputActive();

            const inbound = [...stats.values()].find((entry) => entry.type === "inbound-rtp" && entry.kind === "audio" && entry.ssrc === ssrc);
            const playout = inbound && stats.get(inbound.playoutId);

            if (!playout || !Number.isFinite(playout.totalPlayoutDelay) || !Number.isFinite(playout.totalSamplesCount)) {
                throw new Error("The audio receiver does not report output playout timing");
            }

            if (previousPlayout && playout.id === previousPlayout.id && playout.totalSamplesCount > previousPlayout.totalSamplesCount) {
                const delay = (1000 * (playout.totalPlayoutDelay - previousPlayout.totalPlayoutDelay)) / (playout.totalSamplesCount - previousPlayout.totalSamplesCount);
                if (!Number.isFinite(delay) || delay < 0) throw new Error("Invalid audio output timing");
                outputDelayMs = Math.max(outputDelayMs, delay);

                const source = receiver.getSynchronizationSources().find((entry) => entry.source === ssrc);
                const hasNewSourceObservation = source && Number.isFinite(source.timestamp) && Number.isInteger(source.rtpTimestamp) && (!initialSource || source.timestamp > initialSource.timestamp);

                if (hasNewSourceObservation && (source.rtpTimestamp - endTimestamp) >>> 0 < 0x80000000) {
                    boundaryObservedAt ??= performance.now();

                    if (performance.now() - boundaryObservedAt >= outputDelayMs) {
                        ensureOutputActive();
                        return { playbackId };
                    }
                }
            }

            previousPlayout = playout;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        throw new Error("Timed out waiting for the sample to finish playing");
    }

    failConnection(error, generation) {
        if (this.metaClosing || generation !== this.metaGeneration) {
            return
        };
        if (this.handshakeReject) {
            this.handshakeReject(error);
            return;
        }
        this.reportFailure(error, generation);
    }

    async reportFailure(error, generation) {
        if (this.metaClosing || generation !== this.metaGeneration || this.metaFailureReported) return;
        this.metaFailureReported = true;

        try {
            await this.transport.reportFailure(error.message);
        }
        catch (reportError) {
            if (!this.metaClosing && generation === this.metaGeneration) console.error(reportError);
        }
    }

    close(expectedGeneration = this.metaGeneration) {
        if (expectedGeneration !== this.metaGeneration) return { stopped: true };
        if (this.handshakeReject) this.handshakeReject(new Error("Audio session stopped"));
        if (this.playbackReject) this.playbackReject(new Error("Audio session stopped"));

        this.metaClosing = true;
        this.metaPlaybackWait++;
        this.handshakeReject = null;
        this.playbackReject = null;
        const { webrtcPeer: peer, audioStream: stream, audioRemote: remoteAudio } = this;

        if (peer) {
            peer.onconnectionstatechange = null;
            peer.onicecandidate = null;
            peer.ontrack = null;
            peer.close();
        }
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
        }
        if (remoteAudio) {
            remoteAudio.pause();
            remoteAudio.srcObject = null;
            remoteAudio.removeAttribute("src");
        }

        this.iceCandidatesPending = [];
        this.iceCandidateOperation = Promise.resolve();
        this.webrtcPeer = null;
        this.audioReceiver = null;
        this.audioStream = null;
        this.audioRemote = null;

        return { stopped: true };
    }
}

export { AudioSession };
