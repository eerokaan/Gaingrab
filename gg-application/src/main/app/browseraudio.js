const playbackDrainTimeoutMs = 5000;

// ################################################
// ############ PUBLIC API ########################
// ################################################
function createBrowserAudio(bridge) {
    function start(settings) {
        return bridge.request("ipc:startAudioSessionRequest", "ipc:startAudioSessionResponse", settings);
    }

    function stop() {
        return bridge.request("ipc:stopAudioSessionRequest", "ipc:stopAudioSessionResponse", null);
    }

    function addIceCandidate(candidate) {
        return bridge.request("ipc:engineIceCandidateRequest", "ipc:engineIceCandidateResponse", candidate);
    }

    function waitForPlayback(boundary) {
        return bridge.request("ipc:waitForPlaybackRequest", "ipc:waitForPlaybackResponse", { ...boundary, timeoutMs: playbackDrainTimeoutMs }, { timeoutMs: playbackDrainTimeoutMs + 1000 });
    }

    return { start, stop, addIceCandidate, waitForPlayback };
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createBrowserAudio };
