import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ################################################
// ############ PUBLIC API ########################
// ################################################
function createSessionStore(resultsRoot, filesystem = { mkdir, rename, rm, writeFile }) {
    let sessionDirectory = null;

    async function create(session) {
        const directory = join(resultsRoot, session);

        await filesystem.mkdir(directory, { recursive: false });
        sessionDirectory = directory;

        return {
            directory: sessionDirectory,
            metadata: join(sessionDirectory, "session.json"),
            audioBaseline: join(sessionDirectory, "audio_baseline.wav"),
            audioGainRecording: join(sessionDirectory, "audio_gain_recording.wav"),
            audioGainMerged: join(sessionDirectory, "audio_gain_merged.wav")
        };
    }

    async function write(metadata) {
        if (!sessionDirectory) {
            throw new Error("Session storage has not been created");
        }
        const directory = sessionDirectory;

        // Exclude internal stimulus and audio filenames from persisted participant results
        const serializedMetadata = { ...metadata };
        for (const key of ["headphone_stimulus", "reference_stimulus", "audio_baseline", "audio_gain_recording", "audio_gain_merged"]) {
            delete serializedMetadata[key];
        }

        // Keep ratings last in the serialized field order
        if (Object.hasOwn(serializedMetadata, "ratings")) {
            const ratings = serializedMetadata.ratings;

            delete serializedMetadata.ratings;
            serializedMetadata.ratings = ratings;
        }

        // Replace the checkpoint only after writing the complete temporary file
        const serialized = `${JSON.stringify(serializedMetadata, null, 4)}\n`;
        const temporary = join(directory, `.session-${randomUUID()}.tmp`);

        try {
            await filesystem.writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
            await filesystem.rename(temporary, join(directory, "session.json"));
        }
        catch (error) {
            try {
                await filesystem.rm(temporary, { force: true });
            }
            catch {
                // Temporary file cleanup must not hide the failed checkpoint
            }
            throw error;
        }
    }

    async function remove() {
        if (sessionDirectory) {
            await filesystem.rm(sessionDirectory, { recursive: true, force: true });
            sessionDirectory = null;
        }
    }

    return { create, write, remove };
}

// ################################################
// ############ EXPORTS ###########################
// ################################################
export { createSessionStore };
