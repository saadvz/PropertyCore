import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const shared = { bundle: true, platform: "node", format: "esm", packages: "external", sourcemap: true, logLevel: "info" };
await build({ ...shared, entryPoints: ["src/web/server.ts"], outfile: "dist/server.js" });
// One touring host's Tour Core. The shared service forks it per touring tenant.
await build({ ...shared, entryPoints: ["src/hosted/touringWorker.ts"], outfile: "dist/touringWorker.js" });
// The operator's sandbox keypad entry (#303), so it runs on the service without tsx: node dist/sandboxEntryCli.js
await build({ ...shared, entryPoints: ["src/locks/sandboxEntryCli.ts"], outfile: "dist/sandboxEntryCli.js" });
// The camera counting week's server commands (#239), so they run on the service without tsx:
// node dist/getDetectorCli.js --out <model.onnx> and node dist/countTestCli.js export|score ...
await build({ ...shared, entryPoints: ["src/cameras/getDetectorCli.ts"], outfile: "dist/getDetectorCli.js" });
await build({ ...shared, entryPoints: ["src/cameras/countTestCli.ts"], outfile: "dist/countTestCli.js" });
cpSync("src/web/public", "dist/public", { recursive: true });
