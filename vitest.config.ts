import { existsSync, mkdirSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";

// Every live-app test writes its records through fsync. On a RAM disk that is
// nearly free; on the runner's real disk it was about 40% of the suite's time.
const RAM_TMP = "/dev/shm/tourcore-tests";
const tmp = existsSync("/dev/shm") ? (mkdirSync(RAM_TMP, { recursive: true }), RAM_TMP) : undefined;

// vi.mock replaces a module for the whole worker, so these files get their own.
const OWN_MODULES = ["test/cleanerResetProperty.test.ts"];

// test/noPaidApis.ts runs first in both projects: no test reaches a paid API or sends a text.
export default defineConfig({
  test: {
    // Live-app tests make many webhook round trips. The 5s default killed
    // "holds the question, opens a flag with no draft, and still answers rent"
    // on the GitHub runner while the rest of the suite passed.
    testTimeout: 20_000,
    exclude: [...configDefaults.exclude, "test/eval/**", "**/.cursor/**"],
    ...(tmp ? { env: { TMPDIR: tmp } } : {}),
    projects: [
      {
        extends: true,
        // Reusing one module graph across files saves about a second of imports per file.
        test: { name: "shared", isolate: false, setupFiles: ["test/noPaidApis.ts", "test/resetGlobals.ts"], exclude: [...configDefaults.exclude, "test/eval/**", "**/.cursor/**", ...OWN_MODULES] },
      },
      { extends: true, test: { name: "isolated", include: OWN_MODULES, setupFiles: ["test/noPaidApis.ts"] } },
    ],
  },
});
