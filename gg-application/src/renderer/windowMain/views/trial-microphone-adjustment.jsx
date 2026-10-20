import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dispatchParticipantAction } from "@/lib/helper-bridge";
import { useTranslate } from "@/lib/helper-languages";
import { GainControl } from "@/components/gaincontrol";
import { Layout } from "@/components/layout";
import { useStoreSnapshot } from "@/stores/snapshot";

function ViewTrialMicrophoneAdjustment() {
    const __ = useTranslate();
    const { flowBusy: busy, mediaPlaybackGainRecording } = useStoreSnapshot((state) => state.snapshot);
    const [value, setValue] = useState(() => mediaPlaybackGainRecording ?? 0.1);

    // Assemble markup
    return (
        <Layout
            title={__("Recorded-voice adjustment")}
            description={__("Listen to your recording and adjust the slider until your recorded voice has a comfortable loudness. Releasing the slider restarts the recording.")}
            actions={
                <>
                    <Button type="button" variant="outline" disabled={busy} onClick={() => dispatchParticipantAction("replayRecordedVoice")}>
                        <RotateCcw /> {__("Replay audio")}
                    </Button>
                    <Button type="button" disabled={busy} onClick={() => dispatchParticipantAction("confirmRecordedVoiceGain", { value })}>
                        <Check /> {__("Use this level")}
                    </Button>
                </>
            }
        >
            <GainControl value={value} onChange={setValue} onCommit={(value) => dispatchParticipantAction("commitRecordedVoiceGain", { value })} max={2} label={__("Playback level")} quietLabel={__("Quieter")} loudLabel={__("Louder")} disabled={busy} />
        </Layout>
    );
}

export default ViewTrialMicrophoneAdjustment;
