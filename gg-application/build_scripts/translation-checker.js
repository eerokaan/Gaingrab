const { Linter } = require("eslint");
const { readdirSync, readFileSync } = require("node:fs");
const { extname, join, resolve } = require("node:path");
const { parseTranslationCsv } = require("../src/renderer/windowMain/lib/helper-languages-core.js");

const languages = ["en", "de"];
const applicationDirectory = resolve(__dirname, "..");

function collectTranslationCalls(text, filename = "source.jsx") {
    const calls = [];
    const linter = new Linter();
    const messages = linter.verify(
        text,
        {
            files: ["**/*.jsx"],
            languageOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                parserOptions: { ecmaFeatures: { jsx: true } }
            },
            plugins: {
                translations: {
                    rules: {
                        literal: {
                            meta: { schema: [] },
                            create(context) {
                                return {
                                    CallExpression(node) {
                                        if (node.callee.type !== "Identifier" || node.callee.name !== "__") return;
                                        const source = node.arguments[0];

                                        if (!source || source.type !== "Literal" || typeof source.value !== "string" || !source.value.trim()) {
                                            context.report({ node, message: "Translation calls require a nonblank string-literal first argument; pass variables in the interpolation options." });
                                            return;
                                        }
                                        try {
                                            parseTranslationCsv(`source,translation\n"${source.value.replaceAll('"', '""')}",`, "translation source");
                                        }
                                        catch (error) {
                                            context.report({ node: source, message: error.message });
                                            return;
                                        }

                                        calls.push({ source: source.value, filename, line: node.loc.start.line, column: node.loc.start.column + 1 });
                                    }
                                };
                            }
                        }
                    }
                }
            },
            rules: { "translations/literal": "error" }
        },
        { filename: "translation-source.jsx", allowInlineConfig: false }
    );
    const errors = messages.map((message) => ({ filename, line: message.line, column: message.column, message: message.message }));
    return { calls, errors };
}

function validateTranslationCatalogs(catalogs, calls) {
    const references = new Map();

    for (const call of calls) {
        if (!references.has(call.source)) references.set(call.source, []);
        references.get(call.source).push(call);
    }

    const sources = new Set([...references.keys(), ...Object.keys(catalogs.en), ...Object.keys(catalogs.de)]);
    const warnings = [];

    for (const source of [...sources].sort()) {
        for (const language of languages) {
            const present = Object.hasOwn(catalogs[language], source);
            if (present && catalogs[language][source] !== "") continue;

            const otherLanguage = language === "en" ? "de" : "en";
            const crossCatalog = !present && Object.hasOwn(catalogs[otherLanguage], source);

            warnings.push({
                language,
                source,
                kind: present ? "empty" : "missing",
                references: references.get(source) || [],
                message: `${language} catalog ${present ? "has an empty translation for" : "is missing"} ${JSON.stringify(source)}${crossCatalog ? ` (present in ${otherLanguage})` : ""}. English/source fallback remains available.`
            });
        }
    }
    return warnings;
}

function checkTranslations(directory = applicationDirectory) {
    const catalogDirectory = join(directory, "src/renderer/windowMain/assets/languages");
    const rendererDirectory = join(directory, "src/renderer");
    const catalogs = Object.create(null);
    const calls = [];
    const errors = [];

    for (const language of languages) {
        const filename = join(catalogDirectory, `${language}.csv`);

        try {
            catalogs[language] = parseTranslationCsv(readFileSync(filename, "utf8"), filename);
        }
        catch (error) {
            errors.push({ filename, message: error.message });
        }
    }
    function inspectDirectory(currentDirectory) {
        let entries;

        try {
            entries = readdirSync(currentDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        }
        catch (error) {
            errors.push({ filename: currentDirectory, message: error.message });
            return;
        }
        for (const entry of entries) {
            const filename = join(currentDirectory, entry.name);

            if (entry.isDirectory()) {
                inspectDirectory(filename);
            }
            else if (entry.isFile() && [".js", ".jsx", ".mjs", ".cjs"].includes(extname(filename))) {
                try {
                    const result = collectTranslationCalls(readFileSync(filename, "utf8"), filename);
                    calls.push(...result.calls);
                    errors.push(...result.errors);
                }
                catch (error) {
                    errors.push({ filename, message: error.message });
                }
            }
        }
    }

    inspectDirectory(rendererDirectory);
    const warnings = catalogs.en && catalogs.de ? validateTranslationCatalogs(catalogs, calls) : [];

    return { calls, errors, warnings };
}

module.exports = async function (context = {}) {
    const result = checkTranslations(context.appDir || applicationDirectory);

    for (const error of result.errors) {
        const location = error.line ? `:${error.line}:${error.column || 1}` : "";
        console.error(`[error] ${error.filename}${location}: ${error.message}`);
    }
    for (const warning of result.warnings) {
        const references = warning.references.map((reference) => `${reference.filename}:${reference.line}:${reference.column}`);
        console.warn(`[warning] ${warning.message}${references.length ? ` Referenced at ${references.join(", ")}` : " Catalog-only entry."}`);
    }

    console.log(`Translation check: ${result.calls.length} literal calls, ${result.warnings.length} warnings, ${result.errors.length} errors. Catalogs were not modified.`);
    if (result.errors.length) throw new Error(`Translation check failed with ${result.errors.length} errors.`);

    return result;
};

if (require.main === module) {
    if (process.argv.length > 3) {
        console.error("Usage: node build_scripts/translation-checker.js [application-directory]");
        process.exitCode = 1;
    }
    else {
        module.exports({ appDir: process.argv[2] ? resolve(process.argv[2]) : applicationDirectory }).catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
    }
}

module.exports.collectTranslationCalls = collectTranslationCalls;
module.exports.validateTranslationCatalogs = validateTranslationCatalogs;
module.exports.checkTranslations = checkTranslations;
