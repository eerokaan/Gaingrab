import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dispatchParticipantAction } from "@/lib/helper-bridge";
import { useTranslate } from "@/lib/helper-languages";
import { Layout } from "@/components/layout";
import { useStoreSnapshot } from "@/stores/snapshot";

function ViewWelcome() {
    const [language, setLanguage] = useState("en");
    const [gender, setGender] = useState("female");
    const [headphones, setHeadphones] = useState(false);
    const [volume, setVolume] = useState(false);

    const __ = useTranslate(language);
    const busy = useStoreSnapshot((state) => state.snapshot.flowBusy);

    // Assemble markup
    return (
        <Layout
            title={__("Welcome")}
            description={__("This procedure will help determine comfortable speech playback levels and then ask you to rate two speech samples.")}
            actions={
                <Button type="button" disabled={busy || !headphones || !volume} onClick={() => dispatchParticipantAction("confirmWelcome", { language, gender })}>
                    {__("Continue")} <ArrowRight />
                </Button>
            }
        >
            <div className="mb-8 grid gap-6 sm:grid-cols-2">
                <div className="grid gap-2">
                    <label htmlFor="language" className="font-semibold">
                        {__("Select your language")}
                    </label>

                    <Select value={language} onValueChange={setLanguage} disabled={busy}>
                        <SelectTrigger id="language" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="en">{__("English")}</SelectItem>
                            <SelectItem value="de">{__("German")}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="grid gap-2">
                    <label htmlFor="gender" className="font-semibold">
                        {__("Select your gender")}
                    </label>

                    <Select value={gender} onValueChange={setGender} disabled={busy}>
                        <SelectTrigger id="gender" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="female">{__("Female")}</SelectItem>
                            <SelectItem value="male">{__("Male")}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <h2 className="mb-4 font-semibold">{__("Please acknowledge")}</h2>
            <div className="mb-6 grid gap-4">
                <label htmlFor="headphones" className="flex cursor-pointer items-start gap-3 has-disabled:cursor-not-allowed">
                    <Checkbox id="headphones" className="mt-1" checked={headphones} disabled={busy} onCheckedChange={(checked) => setHeadphones(checked === true)} />
                    <span>{__("I am wearing headphones and am not using computer speakers.")}</span>
                </label>
                <label htmlFor="volume" className="flex cursor-pointer items-start gap-3 has-disabled:cursor-not-allowed">
                    <Checkbox id="volume" className="mt-1" checked={volume} disabled={busy} onCheckedChange={(checked) => setVolume(checked === true)} />
                    <span>{__("I will use only the sliders in this application and will not change the system or application volume.")}</span>
                </label>
            </div>

            <p className="text-muted-foreground">{__("Keep the headphones in the same position throughout the procedure. You will receive separate instructions for the microphone.")}</p>
        </Layout>
    );
}

export default ViewWelcome;
