import { AudioServiceContext } from "@/lib/helper-audio";
import { createAudioTransport, createRendererBridge } from "@/lib/helper-bridge";
import { AudioSession } from "@/lib/helper-webrtc";
import { useStoreSnapshot } from "@/stores/snapshot";
import ReactDOM from "react-dom/client";
import Root from "@/root";
import "@/assets/css/main.css";

// Bootstrap owns the documents audio session, renderer bridge, and React root
// Keep this owner across component Fast Refresh and dispose the bridge on pagehide
function bootstrap() {
    let service;
    let root;

    const ipc = window.appApi.ipcRenderer;
    const audio = new AudioSession(createAudioTransport(ipc, () => Boolean(service && service.isActive())));

    service = createRendererBridge({
        ipc,
        audio,
        onSnapshot(snapshot) {
            useStoreSnapshot.setState({ snapshot });

            if (!root) {
                root = ReactDOM.createRoot(document.getElementById("root"));
                root.render(
                    <AudioServiceContext.Provider value={service}>
                        <Root />
                    </AudioServiceContext.Provider>
                );
            }
        }
    });

    const dispose = () => {
        service.dispose();
        window.removeEventListener("pagehide", dispose);
    };
    window.addEventListener("pagehide", dispose);

    service.invoke("ipc:rendererReadyCall").catch((error) => {
        if (service.isActive()) console.error("Renderer initialization failed", error);
    });

    return dispose;
}

// Replacing bootstrap disposes the document-scoped owner above
// Reload the document instead of creating a second audio service and React root in the same document
if (import.meta.hot && import.meta.hot.data.ownerDisposed) {
    window.location.reload();
}
else {
    const dispose = bootstrap();

    if (import.meta.hot) {
        import.meta.hot.accept();
        import.meta.hot.dispose((data) => {
            data.ownerDisposed = true;
            dispose();
        });
    }
}
