import { create } from "zustand";

const storeCreate = (defaultStates) =>
    create((set) => {
        const setActions = Object.keys(defaultStates).reduce((actions, key) => {
            const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
            actions[setterName] = (value) => set({ [key]: value });
            return actions;
        }, {});

        return {
            ...defaultStates,
            ...setActions
        };
    });

export { storeCreate };
