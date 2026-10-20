function createAudioTransport(ipc, isActive) {
    const invoke = async (channel, payload) => {
        if (!isActive()) throw new Error("Renderer owner was disposed");
        const value = await ipc.invoke(channel, payload);
        if (!isActive()) throw new Error("Renderer owner was disposed");
        return value;
    };
    
    return {
        exchangeOffer: (offer) => invoke("ipc:webrtcOfferCall", offer),
        submitIceCandidate: (candidate) => invoke("ipc:webrtcIceCandidateCall", candidate),
        reportFailure: (message) => invoke("ipc:rendererAudioFailureCall", message)
    };
}

function createRendererBridge({ ipc, audio, onSnapshot }) {
    const subscriptions = [];
    let active = true;
    let ready = false;

    function register(requestChannel, responseChannel, handler) {
        subscriptions.push(
            ipc.on(requestChannel, async ({ requestId, payload }) => {
                if (!active) return;
                let response;

                try {
                    const value = await handler(payload);
                    response = { requestId, value: value ?? null, success: true, error: null };
                }
                catch (error) {
                    response = { requestId, value: null, success: false, error: serializeIpcError(error) };
                }

                if (active) ipc.send(responseChannel, response);
            })
        );
    }

    register("ipc:storeSetValueRequest", "ipc:storeSetValueResponse", (snapshot) => {
        onSnapshot(snapshot);
        ready = true;
    });
    register("ipc:startAudioSessionRequest", "ipc:startAudioSessionResponse", () => audio.connect());
    register("ipc:stopAudioSessionRequest", "ipc:stopAudioSessionResponse", () => audio.close());
    register("ipc:waitForPlaybackRequest", "ipc:waitForPlaybackResponse", (boundary) => audio.waitForPlayback(boundary));
    register("ipc:engineIceCandidateRequest", "ipc:engineIceCandidateResponse", (candidate) => audio.addEngineCandidate(candidate));

    async function invoke(channel, payload) {
        if (!active) throw new Error("Renderer owner was disposed");
        const value = await ipc.invoke(channel, payload);
        if (!active) throw new Error("Renderer owner was disposed");
        return value;
    }

    function dispose() {
        if (!active) return;
        active = false;
        ready = false;

        for (const unsubscribe of subscriptions) unsubscribe();

        audio.close();
    }

    return { audio, isActive: () => active, isReady: () => ready, invoke, dispose };
}

async function dispatchParticipantAction(type, payload = {}) {
    try {
        await window.appApi.ipcRenderer.invoke("ipc:participantActionCall", {
            type,
            ...payload
        });
        return true;
    }
    catch (error) {
        console.error(error);
        return false;
    }
}

function serializeIpcError(value) {
    const error = value instanceof Error ? value : new Error(typeof value === "string" ? value : "Renderer request failed");
    return {
        name: error.name,
        message: error.message,
        code: error.code ?? null
    };
}

export { createAudioTransport, createRendererBridge, dispatchParticipantAction, serializeIpcError };
