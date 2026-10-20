import { useEffect } from "react";
import { ArrowRight, Loader2Icon } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadAudioDevices, startAudioSession, useAudioService } from "@/lib/helper-audio";
import { useTranslate } from "@/lib/helper-languages";
import { Layout } from "@/components/layout";
import { useStoreAudioSetup } from "@/stores/audiosetup";
import { useStoreSnapshot } from "@/stores/snapshot";

function ViewSettings() {
    const __ = useTranslate();
    const service = useAudioService();

    const { sessionLanguage, sessionGender, flowBusy } = useStoreSnapshot((state) => state.snapshot);
    const { devicesStatus, warningCategory, inputDevices, inputDeviceId, outputDevices, outputDeviceId, setInputDeviceId, setOutputDeviceId, setWarningCategory } = useStoreAudioSetup();

    const disabled = flowBusy || devicesStatus !== "ready";
    const pending = flowBusy || devicesStatus === "loading" || devicesStatus === "submitting";
    const deviceWarning = warningCategory === "devices";

    useEffect(() => {
        if (!flowBusy && devicesStatus === "idle") loadAudioDevices(service);
    }, [service, flowBusy, devicesStatus]);

    const startSession = () => startAudioSession(service, { language: sessionLanguage, gender: sessionGender, inputDeviceId, outputDeviceId });
    const retry = () => (deviceWarning ? loadAudioDevices(service) : startSession());
    const deviceLabel = (device, index, fallback) => device.label || `${fallback} ${index + 1}`;

    const handleSubmit = (event) => {
        event.preventDefault();
        return startSession();
    };

    // Assemble markup
    return (
        <Layout
            title={__("Audio setup")}
            description={__("Choose the microphone and headphone devices that should be used for the testing procedure.")}
            actions={
                <Button type="submit" form="settings-form" disabled={disabled || !inputDeviceId || !outputDeviceId}>
                    {__("Continue")}
                    {pending ? <Loader2Icon className="animate-spin" /> : <ArrowRight />}
                </Button>
            }
        >
            <form id="settings-form" className="grid gap-6 sm:grid-cols-2" onSubmit={handleSubmit}>
                <div className="grid gap-2">
                    <label htmlFor="microphone" className="font-semibold">
                        {__("Microphone device")}
                    </label>

                    <Select
                        value={inputDeviceId}
                        onValueChange={(value) => {
                            if (value) setInputDeviceId(value);
                        }}
                        disabled={disabled}
                    >
                        <SelectTrigger id="microphone" className="w-full">
                            <SelectValue placeholder={__("Select a device")} />
                        </SelectTrigger>
                        <SelectContent>
                            {inputDevices.map((device, index) => (
                                <SelectItem key={device.deviceId} value={device.deviceId}>
                                    {deviceLabel(device, index, __("Microphone"))}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="grid gap-2">
                    <label htmlFor="output" className="font-semibold">
                        {__("Headphone device")}
                    </label>

                    <Select
                        value={outputDeviceId}
                        onValueChange={(value) => {
                            if (value) setOutputDeviceId(value);
                        }}
                        disabled={disabled}
                    >
                        <SelectTrigger id="output" className="w-full">
                            <SelectValue placeholder={__("Select a device")} />
                        </SelectTrigger>
                        <SelectContent>
                            {outputDevices.map((device, index) => (
                                <SelectItem key={device.deviceId} value={device.deviceId}>
                                    {deviceLabel(device, index, __("Audio output"))}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {devicesStatus === "error" && (
                    <Button type="button" variant="outline" className="justify-self-start" disabled={flowBusy} onClick={() => loadAudioDevices(service)}>
                        {__("Try again")}
                    </Button>
                )}
            </form>

            <AlertDialog
                open={warningCategory !== null && !pending}
                onOpenChange={(open) => {
                    if (!open) setWarningCategory(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{deviceWarning ? __("Audio devices unavailable") : __("Audio setup could not be completed")}</AlertDialogTitle>
                        <AlertDialogDescription>{deviceWarning ? __("Audio devices could not be loaded. Check that your microphone and headphones are connected and microphone access is allowed, then try again.") : __("The procedure could not be started. Check your audio devices and try again. Your device selections have been kept.")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => setWarningCategory(null)}>{__("I understand")}</AlertDialogCancel>
                        <AlertDialogAction disabled={pending} onClick={retry}>
                            {__("Try again")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Layout>
    );
}

export default ViewSettings;
