const { resolve } = require("node:path");
const { defineConfig } = require("electron-vite");
const tailwindcss = require("@tailwindcss/vite").default;
const react = require("@vitejs/plugin-react").default;

module.exports = defineConfig({
    main: {
        resolve: {
            alias: [{ find: "@", replacement: resolve(__dirname, "./src") }]
        }
    },
    preload: {
        resolve: {
            alias: [{ find: "@", replacement: resolve(__dirname, "./src") }]
        }
    },
    renderer: {
        resolve: {
            alias: [{ find: "@", replacement: resolve(__dirname, "./src/renderer/windowMain") }]
        },
        build: {
            rollupOptions: {
                input: {
                    windowMain: resolve(__dirname, "./src/renderer/windowMain.html")
                }
            }
        },
        plugins: [react(), tailwindcss()]
    }
});
