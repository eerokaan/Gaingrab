import { useTranslation } from "react-i18next";
import { createTranslationInstance, parseTranslationCsv } from "@/lib/helper-languages-core";
import { useStoreSnapshot } from "@/stores/snapshot";
import deCsv from "@/assets/languages/de.csv?raw";
import enCsv from "@/assets/languages/en.csv?raw";

const i18n = createTranslationInstance({
    en: parseTranslationCsv(enCsv, "en.csv"),
    de: parseTranslationCsv(deCsv, "de.csv")
});

function useTranslate(languageOverride) {
    const sessionLanguage = useStoreSnapshot((state) => state.snapshot && state.snapshot.sessionLanguage);
    const selectedLanguage = languageOverride === undefined ? sessionLanguage : languageOverride;
    const { t } = useTranslation("translation", { i18n, lng: selectedLanguage, useSuspense: false });
    return t;
}

export { useTranslate };
