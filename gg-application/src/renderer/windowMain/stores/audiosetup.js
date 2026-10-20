import { storeCreate } from "@/lib/helper-store";

const useStoreAudioSetup = storeCreate({
    devicesStatus: "idle",
    warningCategory: null,
    inputDevices: [],
    inputDeviceId: "",
    outputDevices: [],
    outputDeviceId: ""
});

export { useStoreAudioSetup };
