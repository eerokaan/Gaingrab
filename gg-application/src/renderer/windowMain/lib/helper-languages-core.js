import { createInstance } from "i18next";
import PapaParse from "papaparse";

function interpolationVariables(message, location) {
    const variables = new Set();
    const remainder = message.replace(/{{([\s\S]*?)}}/g, (placeholder, variable) => {
        const name = variable.trim();

        if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) {
            throw new Error(`${location}: invalid interpolation placeholder ${JSON.stringify(placeholder)}`);
        }
        variables.add(name);

        return "";
    });

    if (remainder.includes("{{") || remainder.includes("}}")) {
        throw new Error(`${location}: invalid interpolation placeholder`);
    }

    return [...variables].sort();
}

function parseTranslationCsv(text, filename) {
    const headers = ["source", "translation"];

    if (typeof text !== "string" || !text.trim()) {
        throw new Error(`${filename}: row 1: missing source,translation header`);
    }

    const parsed = PapaParse.parse(text, {
        delimiter: ",",
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
        transformHeader(header, index) {
            if (header !== headers[index]) {
                throw new Error(`${filename}: row 1: expected exactly source,translation headers`);
            }
            return header;
        }
    });
    if (parsed.meta.fields.length !== headers.length) {
        throw new Error(`${filename}: row 1: expected exactly source,translation headers`);
    }
    if (parsed.errors.length) {
        const error = parsed.errors[0];
        throw new Error(`${filename}: row ${Number.isInteger(error.row) ? error.row + 2 : 1}: ${error.message}`);
    }

    const catalog = Object.create(null);

    for (const [index, { source, translation }] of parsed.data.entries()) {
        const location = `${filename}: row ${index + 2}`;
        if (!source.trim()) {
            throw new Error(`${location}: blank source identifier`);
        }
        if (Object.hasOwn(catalog, source)) {
            throw new Error(`${location}: duplicate source ${JSON.stringify(source)}`);
        }

        const sourceVariables = interpolationVariables(source, location);
        const value = translation.trim() ? translation : "";
        if (value && JSON.stringify(sourceVariables) !== JSON.stringify(interpolationVariables(value, location))) {
            throw new Error(`${location}: interpolation placeholders do not match source ${JSON.stringify(source)}`);
        }

        catalog[source] = value;
    }

    return catalog;
}

function createTranslationInstance(catalogs) {
    const i18n = createInstance();
    i18n.init({
        resources: {
            en: { translation: catalogs.en },
            de: { translation: catalogs.de }
        },
        lng: "en",
        fallbackLng: "en",
        supportedLngs: ["en", "de"],
        ns: ["translation"],
        defaultNS: "translation",
        keySeparator: false,
        nsSeparator: false,
        returnEmptyString: false,
        interpolation: { escapeValue: false },
        initAsync: false,
        react: { useSuspense: false }
    });

    if (!i18n.isInitialized) {
        throw new Error("Translation resources did not initialize synchronously");
    }

    return i18n;
}

export { createTranslationInstance, parseTranslationCsv };
