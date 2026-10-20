import { ArrowRight, Mic, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dispatchParticipantAction } from "@/lib/helper-bridge";
import { useTranslate } from "@/lib/helper-languages";
import { Layout } from "@/components/layout";
import { useStoreSnapshot } from "@/stores/snapshot";

function ViewTrialMicrophoneRecording() {
    const __ = useTranslate();
    const { sessionGender, flowBusy: busy, mediaRecordingState: recordingState } = useStoreSnapshot((state) => state.snapshot);

    // Define current status text
    let status = __("Ready to record.");
    if (recordingState === "recording") status = __("Recording in progress...");
    else if (recordingState === "complete") status = __("Recording complete. You may replay your recording, record again, or continue.");

    // Define current action buttons
    let actions = (
        <Button type="button" disabled={busy} onClick={() => dispatchParticipantAction("startMicrophoneRecording")}>
            <Mic />
            {__("Record")}
        </Button>
    );
    if (recordingState === "recording") {
        actions = (
            <Button type="button" disabled={busy} onClick={() => dispatchParticipantAction("stopMicrophoneRecording")}>
                <Square />
                {__("Stop")}
            </Button>
        );
    }
    else if (recordingState === "complete") {
        actions = (
            <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => dispatchParticipantAction("replayMicrophoneRecording")}>
                    <RotateCcw />
                    {__("Replay audio")}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => dispatchParticipantAction("rerecordMicrophone")}>
                    <Mic />
                    {__("Record again")}
                </Button>
                <Button type="button" disabled={busy} onClick={() => dispatchParticipantAction("continueMicrophoneRecording")}>
                    {__("Continue")}
                    <ArrowRight />
                </Button>
            </>
        );
    }

    // Assemble markup
    return (
        <Layout title={__("Microphone recording")} description={__("Position the microphone approximately 2 cm from your mouth, if the equipment permits it. Do not move it for the remainder of the procedure.")} actions={actions}>
            <div className="space-y-6">
                <div className="space-y-1">
                    <p>{__("Press Record, read both sentences aloud at your normal speaking level, and then press Stop.")}</p>
                    <p className="text-sm text-muted-foreground">{status}</p>
                </div>

                <figure className="rounded-lg border bg-muted/50 p-6 sm:p-8">
                    <figcaption className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{__("Text to read")}</figcaption>
                    <blockquote className="text-xl">
                        {sessionGender === "male" ? (
                            <>
                                <p>{__("The juice of lemons makes fine punch.")}</p>
                                <p>{__("Four hours of steady work faced us.")}</p>
                            </>
                        ) : (
                            <>
                                <p>{__("These days a chicken leg is a rare dish.")}</p>
                                <p>{__("The hogs were fed with chopped corn and garbage.")}</p>
                            </>
                        )}
                    </blockquote>
                </figure>
            </div>
        </Layout>
    );
}

export default ViewTrialMicrophoneRecording;
