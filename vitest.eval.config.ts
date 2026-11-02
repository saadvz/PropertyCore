import { defineConfig } from "vitest/config";

/** The baseline harness is its own CI step so it does not race the product suite. */
export default defineConfig({
  test: {
    include: ["test/eval/**/*.test.ts"],
    // Like the product suite: no test reaches a paid API or sends a text, whatever the shell has set.
    setupFiles: ["test/noPaidApis.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
