import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mapSendblueError } from "../messaging/sendblue/adapter";
import { checkSendblue } from "../messaging/sendblue/readiness";
import { mask, readSendblueEnv, sendblueRuntime, webhookUrlFor, type SendblueEnv } from "../messaging/sendblue/runtime";
import { toE164 } from "../messaging/Messenger";
import { loadLocalEnv } from "../web/env";

/**
 * Developer tooling for Sendblue. Never part of `npm test`.
 *   npm run sendblue:status                    what's configured (no secrets shown)
 *   npm run sendblue:configure                 register Tour Core's receive webhook (adds; never replaces others)
 *   npm run sendblue:add-contact -- +1555...   sandbox: add a verified test contact
 *   npm run sendblue:test -- --to +1555...     send one real test message
 */

const say = (line = "") => console.log(line ? `  ${line}` : "");
const ok = (line: string) => say(`\u2713 ${line}`);
const bad = (line: string) => say(`\u2717 ${line}`);

function client(env: SendblueEnv) {
  if (!env.apiKey || !env.apiSecret) {
    bad("SENDBLUE_API_API_KEY and SENDBLUE_API_API_SECRET aren't set. Add them to .env (see .env.example).");
    process.exit(1);
  }
  return sendblueRuntime.client(env);
}

function hookUrl(h: string | { url: string }) {
  return typeof h === "string" ? h : h.url;
}

async function status(): Promise<void> {
  const env = readSendblueEnv();
  say("Sendblue settings on this computer:");
  say(`  API key ............ ${mask(env.apiKey)}`);
  say(`  API secret ......... ${mask(env.apiSecret)}`);
  say(`  From number ........ ${env.fromNumber ?? env.fromNumberRaw ?? "not set"}`);
  say(`  Webhook secret ..... ${mask(env.webhookSecret)}`);
  say(`  PUBLIC_BASE_URL .... ${env.publicBaseUrl ?? (env.publicBaseUrlRaw ? `${env.publicBaseUrlRaw} (must be https)` : "not set")}`);
  say(`  Webhook URL ........ ${webhookUrlFor(env) ?? "(needs PUBLIC_BASE_URL)"}`);
  say();
  const c = client(env);
  try {
    const lines = (await c.lines.getState()).data;
    say("Lines on this account:");
    for (const l of lines) say(`  ${l.sendblue_number ?? "(unassigned)"}  ${l.status}  ${l.assignment ?? ""}`);
  } catch (err) {
    say(`Couldn't list lines (${mapSendblueError(err).code}).`);
  }
  try {
    const hooks = (await c.webhooks.list()).webhooks?.receive ?? [];
    say("Receive webhooks:");
    if (!hooks.length) say("  (none)");
    for (const h of hooks) say(`  ${hookUrl(h)}${typeof h === "object" && h.secret ? "  (has a secret)" : ""}${hookUrl(h) === webhookUrlFor(env) ? "  <- Tour Core" : ""}`);
  } catch (err) {
    bad(`Couldn't list webhooks (${mapSendblueError(err).code}).`);
  }
  try {
    const contacts = (await c.verifiedContacts.list()).data;
    if (contacts?.line?.type === "shared") {
      say();
      say(`Free sandbox: shared line ${contacts.line.phone_number ?? "(unknown)"}. Verified contacts:`);
      for (const ct of contacts.contacts) say(`  ${ct.phone_number}  ${ct.verified ? "verified" : ct.verification_status}`);
    }
  } catch {
    // Not a sandbox account, or the endpoint isn't available on this plan.
  }
  say();
  for (const check of await checkSendblue(env)) (check.ok ? ok : bad)(`${check.message}${check.ok || !check.code ? "" : `  [${check.code}]`}`);
}

async function configure(): Promise<void> {
  const env = readSendblueEnv();
  const c = client(env);
  if (!env.fromNumber) bad("SENDBLUE_FROM_NUMBER isn't set (or isn't a full number like +15551234567). Set it before texting visitors.");
  else ok(`Sendblue line: ${env.fromNumber}`);

  const url = webhookUrlFor(env);
  if (!url) {
    bad("PUBLIC_BASE_URL isn't set to an https address. Start a tunnel (see docs/tour-core/README.md) and set it in .env first.");
    process.exit(1);
  }

  let secret = env.webhookSecret;
  if (!secret) {
    secret = randomBytes(24).toString("base64url");
    const existing = existsSync(".env") ? readFileSync(".env", "utf8") : "";
    appendFileSync(".env", `${existing && !existing.endsWith("\n") ? "\n" : ""}SENDBLUE_WEBHOOK_SECRET=${secret}\n`);
    ok("Created a new webhook secret and saved it to .env (not shown).");
  }

  const hooks = (await c.webhooks.list()).webhooks?.receive ?? [];
  const mine = hooks.find((h) => hookUrl(h) === url);
  const replace = process.argv.includes("--replace");
  if (mine && !replace) {
    const mineSecret = typeof mine === "object" ? mine.secret : undefined;
    if (mineSecret && mineSecret !== secret) {
      bad("This webhook is already registered with a different secret.");
      say("  Re-run with --replace to re-register just this URL with the secret in .env (other webhooks are untouched).");
      process.exit(1);
    }
    ok(`Already registered: ${url}`);
  } else {
    if (mine) {
      // Remove only Tour Core's own URL, then add it back with the right secret. Other webhooks are never touched.
      await c.webhooks.delete({ webhooks: [url], type: "receive" });
    }
    await c.webhooks.create({ webhooks: [{ url, secret, ...(env.fromNumber ? { sendblue_numbers: [env.fromNumber] } : {}) }], type: "receive" });
    ok(`Registered receive webhook: ${url}`);
  }
  const others = hooks.filter((h) => hookUrl(h) !== url).length;
  if (others) say(`  (${others} other receive webhook${others === 1 ? "" : "s"} left as they were.)`);
  say();
  say("Restart `npm run setup` so it picks up the secret, then text the Sendblue number.");
}

async function addContact(): Promise<void> {
  const raw = process.argv.slice(3).find((a) => !a.startsWith("--"));
  const phone = raw ? toE164(raw) : undefined;
  if (!phone) {
    bad("Give the tester's phone number, e.g. npm run sendblue:add-contact -- +15551234567");
    process.exit(1);
  }
  const c = client(readSendblueEnv());
  try {
    const created = (await c.verifiedContacts.create({ phone_number: phone })).data;
    ok(`Contact added: ${phone}`);
    if (created?.line?.phone_number) say(`  Shared Sendblue sandbox number: ${created.line.phone_number}`);
    if (created?.verification_instructions) say(`  ${created.verification_instructions}`);
  } catch (err) {
    const e = mapSendblueError(err);
    if (e.code !== "SENDBLUE_REJECTED") throw e;
    say(`  ${phone} may already be a contact; checking its status.`);
  }
  const current = (await c.verifiedContacts.retrieve(phone)).data;
  say();
  say(`Status: ${current?.contact?.verified ? "verified" : (current?.contact?.verification_status ?? "unknown")}`);
  say("The free sandbox is inbound-first: the tester must send a text to the shared Sendblue number");
  say(`${current?.line?.phone_number ? `(${current.line.phone_number}) ` : ""}from ${phone} before Tour Core can message them.`);
}

async function test(): Promise<void> {
  const env = readSendblueEnv();
  const c = client(env);
  say("Checking the Sendblue connection (read-only)...");
  const checks = await checkSendblue(env);
  for (const check of checks) (check.ok ? ok : bad)(`${check.message}${check.ok || !check.code ? "" : `  [${check.code}]`}`);
  const toArg = process.argv.indexOf("--to");
  let to = toArg > 0 ? toE164(process.argv[toArg + 1] ?? "") : undefined;
  if (!to) {
    try {
      to = (await c.verifiedContacts.list()).data?.contacts.find((ct) => ct.verified)?.phone_number;
    } catch {
      // not a sandbox account
    }
  }
  if (!to || !env.fromNumber) {
    say();
    say("To send a test message: npm run sendblue:test -- --to +15551234567 (and set SENDBLUE_FROM_NUMBER).");
    return;
  }
  say();
  say(`Sending a test message from ${env.fromNumber} to ${to}...`);
  try {
    const res = await c.messages.send({ from_number: env.fromNumber, number: to, content: "Tour Core test message. Reply HI to start a practice tour." }, { maxRetries: 0 });
    ok(`Sendblue accepted it: status ${res.status ?? "unknown"}, message ${res.message_handle ?? "(no id)"}`);
    say("Now reply from that phone. With `npm run setup` running and the tunnel up, Tour Core will answer.");
  } catch (err) {
    const e = mapSendblueError(err);
    bad(`${e.message} [${e.code}]`);
    if (e.code === "SENDBLUE_REJECTED") say("On the free sandbox, the number must be a verified contact and must have texted the shared line first.");
  }
}

loadLocalEnv();
const commands: Record<string, () => Promise<void>> = { status, configure, "add-contact": addContact, test };
const name = process.argv[2] ?? "status";
const run = commands[name];
if (!run) {
  say(`Unknown command "${name}". Use: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
run().catch((err) => {
  const e = mapSendblueError(err);
  bad(`${e.message} [${e.code}]`);
  process.exit(1);
});
