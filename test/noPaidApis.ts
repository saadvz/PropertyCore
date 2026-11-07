/**
 * Runs before every test file, ahead of resetGlobals so its env snapshot never holds these.
 * Unit tests never call a paid API: a shell with the visitor model or a texting account set
 * up must not spend credits or send a text from `npm test`, and must not change results.
 */

/** Settings that point Tour Core at a paid service. Tests that need one set a fake value and stub the call. */
const PAID = /^(TOURCORE_INTENT_MODEL(_|$)|(TOURCORE_|CLEANER_CORE_)?TWILIO_|SENDBLUE_)/;
for (const key of Object.keys(process.env)) if (PAID.test(key)) delete process.env[key];

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const g = globalThis as { __tourCoreRealFetch?: typeof fetch };
// The shared project re-runs setup per file; wrap the real fetch once.
g.__tourCoreRealFetch ??= globalThis.fetch;
const realFetch = g.__tourCoreRealFetch;

/** Only this computer: the live-app tests' own servers. Anything else is a test that forgot a stub. */
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOCAL.has(url.hostname)) throw new Error(`Tests may not call ${url.host}; stub the request instead.`);
  return realFetch(input, init);
}) as typeof fetch;
