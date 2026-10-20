import pkg from "../../../package.json";

// ################################################
// ############ PUBLIC API ########################
// ################################################
const appInfo = {
    name: pkg.name,
    displayName: pkg.displayName,
    version: pkg.version,
    company: pkg.company
};

// ################################################
// ############ EXPORTS ###########################
// ################################################
export default appInfo;
