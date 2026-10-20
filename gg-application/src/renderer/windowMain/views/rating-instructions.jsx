import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dispatchParticipantAction } from "@/lib/helper-bridge";
import { useTranslate } from "@/lib/helper-languages";
import { getRatingResponses } from "@/lib/helper-ratings";
import { Layout } from "@/components/layout";
import { RatingLegend } from "@/components/rating";
import { useStoreSnapshot } from "@/stores/snapshot";

function ViewRatingInstructions() {
    const __ = useTranslate();
    const busy = useStoreSnapshot((state) => state.snapshot.flowBusy);

    // Assemble markup
    return (
        <Layout
            title={__("Loudness ratings")}
            description={__("You will hear two speech samples without a volume slider. After each sample, rate how its loudness compares with the loudness you would prefer.")}
            actions={
                <Button type="button" disabled={busy} onClick={() => dispatchParticipantAction("continueToRatingTrials")}>
                    {__("Continue")}
                    <ArrowRight />
                </Button>
            }
        >
            <div className="space-y-6">
                <p>{__("Is the loudness of the speech much quieter than preferred, quieter than preferred, preferred, louder than preferred, or much louder than preferred?")}</p>
                <RatingLegend items={getRatingResponses(__)} />
                <p className="font-medium">{__("Do not change the system volume, application volume, headphone position, or microphone position.")}</p>
            </div>
        </Layout>
    );
}

export default ViewRatingInstructions;
