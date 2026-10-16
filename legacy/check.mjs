// Import definitions only: no CLI startup or model requests. Run with isolated data paths.
import "./register-loader.mjs";
const modules = ["qq", "qq-admin", "matrix", "bridge", "mobile", "config-tui", "plugin-manager", "session", "tui", "image-input"];
for (const name of modules) await import(`./bin/${name}.js`);
await import("./relay/server.mjs");
console.log("Legacy JavaScript modules loaded; no TypeScript loader required.");
