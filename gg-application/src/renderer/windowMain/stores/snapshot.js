import { create } from "zustand";

// Cache the snapshot in the renderer (Single source of truth within mains state)
const snapshotStore = create(() => ({ snapshot: null }));
const useStoreSnapshot = (selector) => snapshotStore(selector);

// Expose imperative accessors for reading and updating the renderers cached snapshot
useStoreSnapshot.getState = snapshotStore.getState;
useStoreSnapshot.setState = snapshotStore.setState;

export { useStoreSnapshot };
