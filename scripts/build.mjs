import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const shared = { bundle: true, platform: "node", format: "esm", packages: "external", sourcemap: true, logLevel: "info" };
await build({ ...shared, entryPoints: ["src/web/server.ts"], outfile: "dist/server.js" });
// One touring host's Tour Core. The shared service forks it per touring tenant.
await build({ ...shared, entryPoints: ["src/hosted/touringWorker.ts"], outfile: "dist/touringWorker.js" });
cpSync("src/web/public", "dist/public", { recursive: true });
