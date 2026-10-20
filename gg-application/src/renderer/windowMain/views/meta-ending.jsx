import { CircleCheck } from "lucide-react";
import { useTranslate } from "@/lib/helper-languages";
import { Layout } from "@/components/layout";

function ViewEnding() {
    const __ = useTranslate();

    // Assemble markup
    return (
        <Layout title={__("Procedure complete")} description={__("Thank you. Your calibration and loudness ratings have been saved. You are now finished.")}>
            <CircleCheck className="m-auto size-40 shrink-0 text-primary" />
        </Layout>
    );
}

export default ViewEnding;
