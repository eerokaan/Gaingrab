import { useRef, useState } from "react";
import { ArrowRight, Loader2Icon, Play, RotateCcw } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { dispatchParticipantAction } from "@/lib/helper-bridge";
import { useTranslate } from "@/lib/helper-languages";
import { getRatingResponses } from "@/lib/helper-ratings";
import { Layout } from "@/components/layout";
import { RatingScale } from "@/components/rating";
import { useStoreSnapshot } from "@/stores/snapshot";

function ViewRatingMain() {
    const __ = useTranslate();
    const { sessionId, flowBusy: busy, flowRatingTrialIndex: trialIndex, flowRatingTrialCount: trialCount, flowRatingPlaybackComplete: playbackComplete, flowRatingSaveFailed: saveFailed, mediaPlaybackState } = useStoreSnapshot((state) => state.snapshot);
    
    const [response, setResponse] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [warningDismissed, setWarningDismissed] = useState(false);

    const submitLock = useRef(false);
    const playing = mediaPlaybackState === "playing";
    const disabled = !playbackComplete || busy || submitting || response === null;

    const isCurrentTrial = (snapshot) => snapshot && snapshot.flowViewCurrent === "viewRatingMain" && snapshot.sessionId === sessionId && snapshot.flowRatingTrialIndex === trialIndex;
    const submit = async () => {
        const snapshot = useStoreSnapshot.getState().snapshot;
        if (!isCurrentTrial(snapshot) || snapshot.flowBusy || !snapshot.flowRatingPlaybackComplete || response === null || submitLock.current) return;

        // Lock synchronously before React or the next controller snapshot disables the button
        submitLock.current = true;
        setSubmitting(true);
        setWarningDismissed(true);

        try {
            await dispatchParticipantAction("submitRating", { response, trialIndex });
        }
        finally {
            if (isCurrentTrial(useStoreSnapshot.getState().snapshot)) {
                submitLock.current = false;
                setSubmitting(false);
                setWarningDismissed(false);
            }
        }
    };

    // Assemble markup
    return (
        <Layout
            title={__("Rate the speech loudness")}
            description={__("Speech sample {{current}} / {{total}}", { current: trialIndex + 1, total: trialCount })}
            actions={
                <>
                    <Button type="button" variant="outline" disabled={busy || playing || submitting} onClick={() => dispatchParticipantAction("playRatingTrial")}>
                        {playing ? <Loader2Icon className="animate-spin" /> : playbackComplete ? <RotateCcw /> : <Play />}
                        {playing ? __("Playing audio") : playbackComplete ? __("Replay audio") : __("Play audio")}
                    </Button>
                    <Button type="button" disabled={disabled} onClick={submit}>
                        {saveFailed ? __("Try again") : __("Continue")} <ArrowRight />
                    </Button>
                </>
            }
        >
            <h2 className="mb-4 font-semibold">{__("How does the loudness compare with your preferred loudness?")}</h2>
            <RatingScale items={getRatingResponses(__)} value={response} onChange={setResponse} disabled={!playbackComplete || busy || submitting} />
            <AlertDialog
                open={saveFailed && !busy && !submitting && !warningDismissed}
                onOpenChange={(open) => {
                    if (!open) setWarningDismissed(true);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{__("Rating could not be saved")}</AlertDialogTitle>
                        <AlertDialogDescription>{__("Your response is still selected. Try saving it again. If the problem continues, Please contact the supervisor.")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => setWarningDismissed(true)}>{__("I understand")}</AlertDialogCancel>
                        <AlertDialogAction disabled={disabled} onClick={submit}>
                            {__("Try again")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Layout>
    );
}

export default ViewRatingMain;
