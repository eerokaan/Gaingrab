import { CircleAlert } from "lucide-react";
import { useTranslate } from "@/lib/helper-languages";
import { Layout } from "@/components/layout";

function ViewInterrupted() {
    const __ = useTranslate();

    // Assemble markup
    return (
        <Layout title={__("Procedure interrupted")} description={__("The procedure was interrupted. Please contact the supervisor.")}>
            <CircleAlert className="m-auto size-40 shrink-0 text-destructive" />
        </Layout>
    );
}

export default ViewInterrupted;
