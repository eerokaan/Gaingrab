import { contextBridge, ipcRenderer } from "electron";
import appInfo from "@/main/app/info";

const validChannels = {
    invoke: ["ipc:rendererReadyCall", "ipc:sessionStartCall", "ipc:participantActionCall", "ipc:webrtcOfferCall", "ipc:webrtcIceCandidateCall", "ipc:rendererAudioFailureCall"],
    on: ["ipc:storeSetValueRequest", "ipc:startAudioSessionRequest", "ipc:stopAudioSessionRequest", "ipc:waitForPlaybackRequest", "ipc:engineIceCandidateRequest"],
    send: ["ipc:storeSetValueResponse", "ipc:startAudioSessionResponse", "ipc:stopAudioSessionResponse", "ipc:waitForPlaybackResponse", "ipc:engineIceCandidateResponse"]
};

const appApi = {
    ipcRenderer: {
        invoke(channel, ...args) {
            if (!validChannels.invoke.includes(channel)) {
                throw new Error(`Unauthorized IPC invoke channel: ${channel}`);
            }
            return ipcRenderer.invoke(channel, ...args);
        },
        on(channel, listener) {
            if (!validChannels.on.includes(channel)) {
                throw new Error(`Unauthorized IPC on channel: ${channel}`);
            }
            if (typeof listener !== "function") {
                throw new TypeError("IPC request listener must be a function");
            }

            const subscription = async (_, request) => {
                if (!request || typeof request !== "object" || typeof request.requestId !== "string" || !Object.hasOwn(request, "payload")) {
                    console.error(`Invalid IPC request envelope: ${channel}`);
                    return;
                }

                try {
                    await listener(request);
                }
                catch (error) {
                    console.error(error);
                }
            };

            ipcRenderer.on(channel, subscription);

            return () => {
                ipcRenderer.removeListener(channel, subscription);
            };
        },
        send(channel, ...args) {
            if (!validChannels.send.includes(channel)) {
                throw new Error(`Unauthorized IPC send channel: ${channel}`);
            }
            ipcRenderer.send(channel, ...args);
        }
    }
};

contextBridge.exposeInMainWorld("appApi", appApi);
contextBridge.exposeInMainWorld("appInfo", appInfo);
