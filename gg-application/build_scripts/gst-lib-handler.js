const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

module.exports = async function (context) {
    const projectDir = path.resolve(__dirname, "..");
    const platformTarget = context.electronPlatformName;
    const platformThis = process.platform;

    let buildSubDir;
    if (platformTarget === "linux") buildSubDir = "linux";
    else if (platformTarget === "win32") buildSubDir = "win";
    else return;

    const buildDir = path.join(projectDir, "build", buildSubDir);
    const zipPath = path.join(buildDir, "gst-lib.zip");
    const extractedDir = path.join(buildDir, "gst-lib");

    if (!fs.existsSync(zipPath)) {
        console.warn("[gst-lib-handler] GStreamer libraries not found: " + zipPath);
        return;
    }
    if (fs.existsSync(extractedDir)) {
        console.log("[gst-lib-handler] GStreamer libraries already unpacked at " + extractedDir + ", skipping.");
        return;
    }

    console.log("[gst-lib-handler] Unpacking GStreamer libraries from " + zipPath + "...");

    if (platformThis === "win32") {
        execSync("powershell -Command \"Expand-Archive -Path '" + zipPath + "' -DestinationPath '" + buildDir + "'\"", { stdio: "inherit" });
    }
    else {
        execSync('unzip -q "' + zipPath + '" -d "' + buildDir + '"', {
            stdio: "inherit"
        });
    }

    console.log("[gst-lib-handler] GStreamer libraries unpacked successfully.");
};
