import eslint from "@electron-toolkit/eslint-config";
import eslintConfigPrettier from "@electron-toolkit/eslint-config-prettier";
import eslintPluginReact from "eslint-plugin-react";
import eslintPluginReactHooks from "eslint-plugin-react-hooks";
import eslintPluginReactRefresh from "eslint-plugin-react-refresh";
import eslintPluginSimpleImportSort from "eslint-plugin-simple-import-sort";
import eslintPluginSimpleImportSortInternals from "eslint-plugin-simple-import-sort/shared.js";

function reportImportSort(chunk, context) {
    const sourceCode = eslintPluginSimpleImportSortInternals.getSourceCode(context);
    const items = eslintPluginSimpleImportSortInternals.getImportExportItems(chunk, sourceCode, getImportStyle, (importNode) => importNode.specifiers.filter((specifier) => specifier.type === "ImportSpecifier"));
    const sortedItems = [[items.slice().sort(compareImportItems)]];
    const sorted = eslintPluginSimpleImportSortInternals.printSortedItems(sortedItems, items, sourceCode);

    const { start } = items[0];
    const { end } = items[items.length - 1];

    eslintPluginSimpleImportSortInternals.maybeReportSorting(context, sorted, start, end);
}

function getImportStyle(importNode, sourceCode) {
    let importStyle;

    if (importNode.specifiers.length === 0) {
        importStyle = eslintPluginSimpleImportSortInternals.isPunctuator(sourceCode.getFirstToken(importNode, { skip: importNode.importKind === "type" ? 2 : 1 }), "{") ? 3 : eslintPluginSimpleImportSortInternals.SideEffectImport;
    }
    else {
        const [firstSpecifier] = importNode.specifiers;
        importStyle = firstSpecifier.type === "ImportNamespaceSpecifier" ? 1 : firstSpecifier.type === "ImportDefaultSpecifier" ? 2 : 3;
    }

    return importStyle;
}

function compareImportItems(importA, importB) {
    const rankA = getImportRank(importA);
    const rankB = getImportRank(importB);

    return (
        compareNumbers(rankA[0], rankB[0]) ||
        compareNumbers(rankA[1], rankB[1]) ||
        compareNumbers(rankA[2], rankB[2]) ||
        compareNumbers(rankA[3], rankB[3]) ||
        compareNumbers(rankA[4], rankB[4]) ||
        compareStrings(importA.source.source, importB.source.source) ||
        compareStrings(importA.source.originalSource, importB.source.originalSource) ||
        compareStrings(importA.source.kind, importB.source.kind) ||
        importA.style - importB.style ||
        importA.index - importB.index
    );
}

function getImportRank(item) {
    const aliasImportGroups = [/^@\/components\/ui(?:\/.*|$)/u, /^@\/lib(?:\/.*|$)/u, /^@\/components(?:\/.*|$)/u, /^@\/views(?:\/.*|$)/u, /^@\/stores(?:\/.*|$)/u, /^@\//u];
    const hasNamedImport = item.node.specifiers.some((specifier) => specifier.type === "ImportSpecifier") || item.style === 3;
    const aliasGroupIndex = aliasImportGroups.findIndex((group) => group.test(item.source.originalSource));
    const aliasGroupRank = aliasGroupIndex === -1 ? aliasImportGroups.length : aliasGroupIndex;

    return [hasNamedImport ? 0 : 1, item.source.originalSource.startsWith("@") ? 1 : 0, hasNamedImport && item.source.originalSource === "react" ? 0 : 1, item.style === eslintPluginSimpleImportSortInternals.SideEffectImport ? 1 : 0, aliasGroupRank];
}

function compareNumbers(a, b) {
    return a - b;
}

function compareStrings(a, b) {
    const collator = new Intl.Collator("en", {
        numeric: true,
        sensitivity: "base"
    });

    return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export default [
    {
        ignores: ["**/node_modules", "**/dist", "**/out", "**/components/ui"]
    },
    eslint,
    eslintPluginReact.configs.flat.recommended,
    eslintPluginReact.configs.flat["jsx-runtime"],
    {
        settings: {
            react: {
                version: "detect"
            }
        }
    },
    {
        files: ["**/*.{js,jsx}"],
        plugins: {
            "react-hooks": eslintPluginReactHooks,
            "react-refresh": eslintPluginReactRefresh,
            "simple-import-sort": {
                ...eslintPluginSimpleImportSort,
                rules: {
                    ...eslintPluginSimpleImportSort.rules,
                    imports: {
                        meta: {
                            type: "layout",
                            fixable: "code",
                            schema: [],
                            messages: {
                                sort: "Sort imports by project order."
                            }
                        },
                        create(context) {
                            const parents = new Set();

                            return {
                                ImportDeclaration(node) {
                                    parents.add(node.parent);
                                },
                                "Program:exit"() {
                                    for (const parent of parents) {
                                        for (const chunk of eslintPluginSimpleImportSortInternals.extractChunks(parent, (node) => (node.type === "ImportDeclaration" ? "PartOfChunk" : "NotPartOfChunk"))) {
                                            reportImportSort(chunk, context);
                                        }
                                    }
                                    parents.clear();
                                }
                            };
                        }
                    }
                }
            }
        },
        rules: {
            ...eslintPluginReactHooks.configs.recommended.rules,
            ...eslintPluginReactRefresh.configs.vite.rules,
            "react/prop-types": "off",
            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error"
        }
    },
    eslintConfigPrettier
];
