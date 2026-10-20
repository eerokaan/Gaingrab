import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { dispatchParticipantAction } from "@/lib/helper-bridge";
import { useTranslate } from "@/lib/helper-languages";
import { GainControl } from "@/components/gaincontrol";
import { Layout } from "@/components/layout";
import { useStoreSnapshot } from "@/stores/snapshot";

function ViewTrialHeadphoneCalibration() {
    const __ = useTranslate();
    const { flowBusy: busy, mediaPlaybackGainHeadphone, flowVolumeWarningOpen } = useStoreSnapshot((state) => state.snapshot);
    const [value, setValue] = useState(() => mediaPlaybackGainHeadphone ?? 0.1);

    // Assemble markup
    return (
        <Layout
            title={__("Headphone calibration")}
            description={__("Listen to the speech and adjust the slider until the loudness is comfortable. Releasing the slider restarts the sample at the selected level.")}
            actions={
                <>
                    <Button type="button" variant="outline" disabled={busy} onClick={() => dispatchParticipantAction("replayHeadphoneGain")}>
                        <RotateCcw /> {__("Replay audio")}
                    </Button>
                    <Button type="button" disabled={busy} onClick={() => dispatchParticipantAction("confirmHeadphoneGain", { value })}>
                        <Check /> {__("Use this level")}
                    </Button>
                </>
            }
        >
            <GainControl value={value} onChange={setValue} onCommit={(value) => dispatchParticipantAction("commitHeadphoneGain", { value })} label={__("Playback level")} quietLabel={__("Quieter")} loudLabel={__("Louder")} disabled={busy} />
            <AlertDialog open={flowVolumeWarningOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{__("Keep the volume fixed")}</AlertDialogTitle>
                        <AlertDialogDescription>{__("Changing the system volume, application volume, or headphone position after this point invalidates the result.")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogAction disabled={busy} onClick={() => dispatchParticipantAction("acknowledgeVolumeWarning")}>
                            {__("I understand")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Layout>
    );
}

export default ViewTrialHeadphoneCalibration;
