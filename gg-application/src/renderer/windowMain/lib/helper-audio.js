import { createContext, useContext } from "react";
import { useStoreSnapshot } from "@/stores/snapshot";
import { useStoreAudioSetup } from "@/stores/audiosetup";

const AudioServiceContext = createContext(null);
const attempts = new WeakMap();

function useAudioService() {
    const service = useContext(AudioServiceContext);
    if (!service) throw new Error("Audio service is unavailable");
    return service;
}

function canPrepare(service) {
    const { snapshot } = useStoreSnapshot.getState();
    return service.isActive() && service.isReady() && snapshot && snapshot.flowViewCurrent === "viewSettings" && !snapshot.flowBusy;
}

async function loadAudioDevices(service) {
    let permissionStream;

    const store = useStoreAudioSetup.getState();
    if (!canPrepare(service) || store.devicesStatus === "loading" || store.devicesStatus === "submitting") return;

    const attempt = {};
    attempts.set(service, attempt);

    const isCurrent = () => attempts.get(service) === attempt && canPrepare(service);
    store.setWarningCategory(null);
    store.setDevicesStatus("loading");

    try {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!isCurrent()) return;

        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!isCurrent()) return;

        const inputDevices = devices.filter(({ kind }) => kind === "audioinput");
        const outputDevices = devices.filter(({ kind }) => kind === "audiooutput");

        if (inputDevices.length === 0 || outputDevices.length === 0) {
            throw new Error("Required audio devices are unavailable");
        }

        store.setInputDevices(inputDevices);
        store.setInputDeviceId(inputDevices.some(({ deviceId }) => deviceId === store.inputDeviceId) ? store.inputDeviceId : inputDevices[0].deviceId);
        store.setOutputDevices(outputDevices);
        store.setOutputDeviceId(outputDevices.some(({ deviceId }) => deviceId === store.outputDeviceId) ? store.outputDeviceId : outputDevices[0].deviceId);
        store.setDevicesStatus("ready");
    }
    catch (error) {
        if (isCurrent()) {
            console.error(error);
            store.setDevicesStatus("error");
            store.setWarningCategory("devices");
        }
    }
    finally {
        if (permissionStream) permissionStream.getTracks().forEach((track) => track.stop());
    }
}

async function startAudioSession(service, { language, gender, inputDeviceId, outputDeviceId }) {
    const store = useStoreAudioSetup.getState();
    const audioSession = service.audio;

    if (!canPrepare(service) || store.devicesStatus !== "ready") return;
    if (!inputDeviceId || !outputDeviceId) return;

    const inputDevice = store.inputDevices.find((device) => device.deviceId === inputDeviceId);
    const outputDevice = store.outputDevices.find((device) => device.deviceId === outputDeviceId);

    if (!inputDevice || !outputDevice) {
        store.setDevicesStatus("error");
        store.setWarningCategory("devices");
        return;
    }

    const inputDeviceName = typeof inputDevice.label === "string" && inputDevice.label.trim() ? inputDevice.label : "Unknown input device";
    const outputDeviceName = typeof outputDevice.label === "string" && outputDevice.label.trim() ? outputDevice.label : "Unknown output device";

    const attempt = {};
    attempts.set(service, attempt);
    store.setWarningCategory(null);
    store.setDevicesStatus("submitting");

    const preparation = audioSession.prepare({ inputDeviceId, outputDeviceId });
    const generation = audioSession.metaGeneration;
    const isCurrent = () => service.isActive() && attempts.get(service) === attempt && generation === audioSession.metaGeneration;

    try {
        await preparation;
        if (!isCurrent()) return;

        audioSession.ensureActive(generation);
        if (!canPrepare(service)) throw new Error("Audio preparation is no longer available");

        await service.invoke("ipc:sessionStartCall", {
            language,
            gender,
            inputDeviceId,
            outputDeviceId,
            inputDeviceName,
            outputDeviceName
        });

        if (isCurrent()) store.setDevicesStatus("ready");
    }
    catch (startError) {
        if (isCurrent()) {
            console.error(startError);
            
            audioSession.close(generation);
            store.setDevicesStatus("ready");

            if (canPrepare(service)) store.setWarningCategory("setup");
        }
    }
}

export { AudioServiceContext, loadAudioDevices, startAudioSession, useAudioService };
