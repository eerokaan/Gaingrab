import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

// ################################################
// ############ PUBLIC API ########################
// ################################################
function createMediaEngineEnvironment(executablePath, { requireBundledRuntime = false } = {}) {
    const platform = process.platform;
    const baseEnvironment = process.env;
    const path = platform === "win32" ? win32 : posix;

    const runtimeName = platform === "win32" ? "x86_64-windows" : "x86_64-linux-gnu";
    const runtimeRoot = path.join(path.dirname(executablePath), "gst-lib", runtimeName);

    if (!existsSync(runtimeRoot)) {
        if (requireBundledRuntime) {
            throw new Error(`Bundled GStreamer runtime is missing: ${runtimeRoot}`);
        }
        return baseEnvironment;
    }

    const environment = { ...baseEnvironment };

    if (platform === "linux") {
        const libraryDirectory = path.join(runtimeRoot, "lib");
        const pluginDirectory = path.join(libraryDirectory, "gstreamer-1.0");
        environment.LD_LIBRARY_PATH = prependPath(libraryDirectory, baseEnvironment.LD_LIBRARY_PATH, path.delimiter);
        environment.GST_PLUGIN_PATH = pluginDirectory;
    }
    else if (platform === "win32") {
        const pluginDirectory = path.join(runtimeRoot, "lib", "gstreamer-1.0");
        environment.PATH = prependPath(path.join(runtimeRoot, "bin"), baseEnvironment.PATH, path.delimiter);
        environment.GST_PLUGIN_PATH = pluginDirectory;
    }

    return environment;
}

// ################################################
// ############ PRIVATE HELPERS ###################
// ################################################
function prependPath(value, current, separator) {
    return current ? `${value}${separator}${current}` : value;
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createMediaEngineEnvironment };
