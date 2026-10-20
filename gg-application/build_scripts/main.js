const checkTranslations = require("./translation-checker.js");
const handleGstLib = require("./gst-lib-handler.js");

module.exports = async function (context) {
    await checkTranslations(context);
    await handleGstLib(context);
};
