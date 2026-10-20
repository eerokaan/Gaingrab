import { useStoreSnapshot } from "@/stores/snapshot";
import ViewEnding from "@/views/meta-ending";
import ViewInterrupted from "@/views/meta-interrupted";
import ViewSettings from "@/views/meta-settings";
import ViewWelcome from "@/views/meta-welcome";
import ViewRatingInstructions from "@/views/rating-instructions";
import ViewRatingMain from "@/views/rating-main";
import ViewHeadphoneCalibration from "@/views/trial-headphone-calibration";
import ViewRecordingAdjustment from "@/views/trial-microphone-adjustment";
import ViewMicrophoneRecording from "@/views/trial-microphone-recording";

const viewMap = {
    viewSettings: ViewSettings,
    viewWelcome: ViewWelcome,
    viewHeadphoneCalibration: ViewHeadphoneCalibration,
    viewMicrophoneRecording: ViewMicrophoneRecording,
    viewRecordingAdjustment: ViewRecordingAdjustment,
    viewRatingInstructions: ViewRatingInstructions,
    viewRatingMain: ViewRatingMain,
    viewEnding: ViewEnding,
    viewInterrupted: ViewInterrupted
};

function Root() {
    const snapshot = useStoreSnapshot((state) => state.snapshot);
    if (!snapshot) return null;

    const { flowViewCurrent, sessionId, flowRatingTrialIndex } = snapshot;
    const View = viewMap[flowViewCurrent];
    if (!View) return null;

    const viewKey = JSON.stringify([flowViewCurrent, sessionId, flowViewCurrent === "viewRatingMain" ? flowRatingTrialIndex : null]);

    return (
        <main className="flex min-h-screen flex-col p-6 sm:p-12">
            <View key={viewKey} />
        </main>
    );
}

export default Root;
