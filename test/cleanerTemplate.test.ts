import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { askNext } from "../src/cleaner-core/setupAsk";
import { DOOR_CODE } from "./wiringProof";
import { filesUnder } from "./files";
import { SUPPLY_FRONT_NAMES } from "../src/supply-core/hosted";

/** The Cleaner Core paste-in prompt, setup guide, and Grok Bot template: pinned, consistent with the tools, and free of secrets. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(ROOT, "cleaner-template");
const BOOTSTRAP = join(ROOT, "CLEANER_CORE_BOOTSTRAP.md");
const HOSTED = "https://tourcore-production-8b80.up.railway.app";
const REPO = "https://github.com/saadvz/TourCore";
const ROUTINES = ["Cleaner Core Check", "Cleaner Core Alerts"];
/** The setup order get_state asks for: the diagram's 8 steps, the checks once numbers are approved, then the routines and the first times. */
const SETUP_TOOLS = ["get_state", "save_property", "save_sources", "save_people", "save_schedule", "save_door_code", "save_preferences", "save_alert_routine", "activate", "run_checks", "confirm_times"];
/** Tools that need the host's yes in chat. A routine runs unattended, so it never holds them. */
const NEEDS_HOST_YES = ["send_message", "mark_guests_left", "save_door_code", "save_sources", "activate", "retry_send", "hold_job", "resume_job", "reset_property"];

/** LF bytes, so the pin matches on a Windows (CRLF) checkout and on CI. */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

async function rpc(method: string): Promise<Record<string, unknown>> {
  // initialize and tools/list never touch the desk.
  const reply = await handleCleanerMcpMessage({} as LiveDesk, { jsonrpc: "2.0", id: 1, method }, undefined, true);
  return (reply.body as { result: Record<string, unknown> }).result;
}

async function toolNames(): Promise<string[]> {
  return ((await rpc("tools/list")).tools as { name: string }[]).map((tool) => tool.name);
}

interface Manifest {
  name: string;
  profile: string;
  setupPrompt: string;
  readme: string;
  hostedCleanerCoreUrl: string;
  repository: { url: string; bootstrap: string };
  integrations: { name: string; type: string; url?: string; auth: string; travelsWithTemplate: boolean }[];
  routines: { name: string; doc: string; trigger: string; allowedTools: string[]; credentialsTravelWithTemplate: boolean }[];
  suggestedPrompts: string[];
  neverIncluded: string[];
}

const manifest = (): Manifest => JSON.parse(read(join(TEMPLATE, "template.json"))) as Manifest;

/** SHA-256 of cleaner-template/SETUP_PROMPT.md with LF line endings. Change the prompt only on purpose. */
const SETUP_PROMPT_SHA256 = "6c23392e133f6ffe7cb11d949477a3d06337df64784e0ac936832fd062b23ead";

describe("Cleaner Core paste-in prompt", () => {
  it("is pinned, names the repository and the bootstrap, and uses the secure card", () => {
    const prompt = read(join(TEMPLATE, "SETUP_PROMPT.md"));
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(SETUP_PROMPT_SHA256);
    expect(prompt).toContain(REPO);
    expect(prompt).toContain("CLEANER_CORE_BOOTSTRAP.md");
    expect(prompt).toContain("secure");
    expect(prompt).toMatch(/hosted Cleaner Core service/);
    expect(prompt).toMatch(/Never ask me to paste API keys, passwords, tokens, or door codes into chat/);
    expect(prompt).toMatch(/Allow/);
    // The multi-tenant service: the host types Saad's invite code on the Allow page, never in chat.
    expect(prompt).toMatch(/invite code/);
    expect(prompt).toMatch(/Never ask me for the invite code in chat\./);
    expect(prompt).not.toMatch(/ask me only to click Allow/);
    expect(prompt).toContain("get_state");
    expect(prompt).toMatch(/Start now\./);
  });
});

describe("Cleaner Core template manifest", () => {
  it("points at the hosted Cleaner Core and its one connector", () => {
    const m = manifest();
    expect(m.hostedCleanerCoreUrl).toBe(HOSTED);
    const activation = (JSON.parse(read(join(TEMPLATE, "template.json"))) as { marketplace: { activation: string } }).marketplace.activation;
    expect(activation).toMatch(/invite code/);
    expect(activation).not.toMatch(/clicks Allow once/);
    expect(m.repository).toEqual(expect.objectContaining({ url: REPO, bootstrap: "CLEANER_CORE_BOOTSTRAP.md" }));
    const connectors = m.integrations.filter((i) => i.type === "custom-mcp-server");
    expect(connectors).toEqual([
      expect.objectContaining({
        name: "Cleaner Core",
        url: "hostedCleanerCoreUrl/mcp/cleaner-core",
        auth: expect.stringMatching(/types the invite code from Saad on the Cleaner Core page and clicks Allow\. Grok cannot approve itself\./),
        travelsWithTemplate: false,
      }),
    ]);
    expect(m.integrations).toContainEqual(expect.objectContaining({ name: "Google Calendar", type: "first-party-connector", travelsWithTemplate: false }));
  });

  it("lists only files that exist", () => {
    const m = manifest();
    for (const f of [m.profile, m.setupPrompt, m.readme, ...m.routines.map((r) => r.doc)]) expect(existsSync(join(TEMPLATE, f)), f).toBe(true);
    expect(existsSync(join(ROOT, m.repository.bootstrap))).toBe(true);
  });

  it("names both routines, with real tools and no credentials", async () => {
    const m = manifest();
    expect(m.routines.map((r) => r.name)).toEqual(ROUTINES);
    expect(m.routines.map((r) => r.trigger)).toEqual(["scheduled", "authenticated-webhook"]);
    const tools = await toolNames();
    for (const routine of m.routines) {
      expect(routine.credentialsTravelWithTemplate, routine.name).toBe(false);
      expect(routine.doc.startsWith("routines/"), routine.name).toBe(true);
      for (const tool of routine.allowedTools) {
        expect(tools, `${routine.name} lists ${tool}`).toContain(tool);
        expect(NEEDS_HOST_YES, `${routine.name} lists ${tool}`).not.toContain(tool);
      }
      expect(read(join(TEMPLATE, routine.doc))).toContain(`# Routine: ${routine.name}`);
    }
  });

  it("lets a bot from the team template start setup with no paste-in prompt", () => {
    const m = manifest();
    const profile = read(join(TEMPLATE, m.profile));
    const instructions = profile.slice(profile.indexOf("## Standing instructions"));
    // A Grok Bot template carries only the profile and instructions, so they name the repository and the service.
    expect(instructions).toContain(m.repository.url);
    expect(instructions).toContain(`${m.hostedCleanerCoreUrl}/mcp/cleaner-core`);
    expect(instructions).toContain(`\`${m.repository.bootstrap}\``);
    expect(instructions).not.toContain("hostedCleanerCoreUrl");
    expect(instructions).toMatch(/clone[\s\S]{0,40}only to read/);
    expect(instructions).toMatch(/never start a tunnel/i);
    expect(m.suggestedPrompts[0]).toBe("Set up Cleaner Core");
    // A shared template is a frozen copy, so the repository's address wins if it ever changes.
    expect(instructions).toContain("If `cleaner-template/template.json` in the repository names a\n  different address, use that one.");
    expect(instructions).toMatch(/Don't clone it when a routine wakes you/);
    // The safety rules the guide holds, kept where a template bot reads them every turn.
    expect(instructions).toMatch(/Only the host's answer says the guests have left\. Never decide it from the\s+calendar/);
    for (const tool of ["mark_guests_left", "hold_job", "resume_job", "reset_property", "retry_send", "send_message"]) {
      expect(instructions, tool).toContain(`\`${tool}\``);
    }
    expect(instructions).toMatch(/Never pause on your\s+own/);
    expect(instructions).toMatch(/quote it, and ask whether to pause/);
    // Setup lets the host skip the group, so the description doesn't promise one.
    expect(profile).toMatch(/to the cleaner, or to a group if you want one/);
    expect(profile).not.toMatch(/in one group with you and the cleaner/);
    // The build guide keeps the template bot from claiming the hosted service or carrying memories.
    const readme = read(join(TEMPLATE, m.readme));
    expect(readme).toContain("## Build the team template");
    expect(readme).toMatch(/Don't connect Cleaner Core, don't create the routines, and don't run setup/);
    expect(readme).toMatch(/no\s+memories/);
    // One multi-tenant service: a new bot joins with an invite code, never by resetting an owner.
    expect(readme).toMatch(/invite code/);
    expect(readme).not.toContain("CLEANER_CORE_HOSTED_OWNER_RESET");
  });

  it("has the suggested prompts in the bot profile", () => {
    const m = manifest();
    const profile = read(join(TEMPLATE, m.profile));
    expect(m.suggestedPrompts.length).toBeGreaterThan(2);
    for (const prompt of m.suggestedPrompts) expect(profile).toContain(`- ${prompt}`);
    expect(profile).toMatch(/one question at a time/i);
    expect(profile).toMatch(/secure card/);
    expect(profile).toMatch(/only\s+the\s+calendar\s+the\s+host\s+named\s+for\s+bookings/);
    expect(profile).toMatch(/use\s+your\s+secure\s+card\s+for\s+the\s+door\s+code/i);
    expect(profile).toMatch(/only\s+to\s+the\s+one-time\s+upload\s+link,\s+from\s+your\s+own\s+computer/);
    expect(profile).not.toMatch(/webhook\s+addresses, or door codes\. Use your secure card\./);
  });

  it("knows the Venmo payments step and the Supply Core add-on", () => {
    const profile = read(join(TEMPLATE, manifest().profile));
    const instructions = profile.slice(profile.indexOf("## Standing instructions"));
    expect(profile.slice(0, profile.indexOf("## Standing instructions"))).toMatch(/Venmo[\s\S]*Supply Core/);
    for (const tool of ["save_payments", "mark_paid", "choose_supplies", "turn_on_supplies", "get_supply_state", "report_low", "check_cart", "approve_cart", "turn_off_supplies"]) {
      expect(instructions, tool).toContain(`\`${tool}\``);
    }
    expect(instructions).toContain("`SUPPLY_CORE_BOOTSTRAP.md`");
    expect(instructions).toContain("`supply-template/routines/`");
    const flat = instructions.replace(/\s+/g, " ");
    expect(flat).toMatch(/Call `check_cart` before Place Order, every time/);
    expect(flat).toMatch(/Never type, paste, or pass a card number, expiry, or security code to Supply Core/);
    expect(flat).toMatch(/A cleaner's words only mark list items low/);
    expect(flat).toMatch(/A routine run never calls `approve_cart` with a code/);
  });

  it("leaves the Tour Core template alone", () => {
    const tour = read(join(ROOT, "grok-template", "template.json"));
    expect(tour).not.toMatch(/cleaner/i);
    expect(readdirSync(join(ROOT, "grok-template", "routines")).some((f) => f.startsWith("cleaner-core"))).toBe(false);
  });
});

describe("CLEANER_CORE_BOOTSTRAP.md", () => {
  it("stays a short entry point that connects to the hosted service", () => {
    const text = read(BOOTSTRAP);
    expect(text.split("\n").length).toBeLessThan(80);
    expect(text).toMatch(/No attachments are needed/);
    expect(text).toContain("`cleaner-template/template.json`");
    expect(text).toContain("`hostedCleanerCoreUrl`");
    expect(text).toContain("/mcp/cleaner-core");
    expect(text).toMatch(/Do not run Cleaner Core on your computer/);
    expect(text).toMatch(/tunnel/);
    expect(text).toMatch(/clicks Allow/);
  });

  it("names every setup tool in the order get_state asks for them", () => {
    const text = read(BOOTSTRAP);
    const positions = SETUP_TOOLS.map((tool) => text.indexOf(`\`${tool}\``));
    for (const [i, p] of positions.entries()) expect(p, SETUP_TOOLS[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("links both routine docs and covers every booking", () => {
    const text = read(BOOTSTRAP);
    for (const name of ROUTINES) expect(text).toContain(name);
    for (const doc of manifest().routines.map((r) => r.doc)) expect(text).toContain(`(cleaner-template/${doc})`);
    for (const field of ["check_now", "messages", "needsTimes", "completed", "wouldCancel", "save_arrival", "send_message", "mark_guests_left", "get_job_photos"]) {
      expect(text, field).toContain(`\`${field}\``);
    }
    expect(text).toMatch(/Have the guests left\?/);
    expect(text).toMatch(/7 days ago to 60 days ahead/);
    expect(text).toMatch(/timed event/);
  });

  it("picks cleaning with the choice value it names", async () => {
    const choice = /`choice: "([^"]+)"`/.exec(read(BOOTSTRAP))?.[1];
    expect(choice).toBe("cleaners");
    const root = mkdtempSync(join(tmpdir(), "cleaner-template-"));
    try {
      const desk = liveDeskFor(root, () => ({}), () => new Date());
      const reply = await desk.getState(choice as "cleaners");
      expect(reply.ok).toBe(true);
      expect((reply.result as { done: string[] }).done).toContain("You chose cleaning.");
    } finally {
      resetLiveDesks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops at unapproved numbers, then runs the checks", () => {
    const text = read(BOOTSTRAP);
    expect(text).toMatch(/If `activate` says the numbers aren't approved for texts/);
    expect(text).toMatch(/Cleaner Core operator has to approve/);
    expect(text).toMatch(/stop there/);
    expect(text).toMatch(/call `run_checks`, with `googleEvents`/);
    expect(read(join(ROOT, "src", "cleaner-core", "liveDesk.ts"))).toContain("only after those numbers are approved for texts.");
  });

  it("names who send_message can reach, and that YES comes twice in every mode", () => {
    const text = read(BOOTSTRAP);
    expect(text).toMatch(/With a group, `send_message` posts to the group: `to` is `group`/);
    expect(text).toMatch(/Without one, `to` is `cleaner`/);
    expect(text).toMatch(/Never a phone number\./);
    expect(text).toMatch(/The cleaner replies YES twice/);
    expect(text).toMatch(/then once to schedule the cleaning/);
  });

  it("connects alerts with the one-time upload link, never the secure card or chat", () => {
    const text = read(BOOTSTRAP);
    for (const doc of [text, read(join(TEMPLATE, "routines", "cleaner-core-alerts.md"))]) {
      expect(doc).toMatch(/`save_alert_routine` with no arguments/);
      expect(doc).toMatch(/one-time upload link/);
      expect(doc).toMatch(/from (your|Grok's) own cloud\s+computer/i);
      expect(doc).toContain("Content-Type: application/json");
      expect(doc).not.toMatch(/secure card into `save_alert_routine`|secure card, and pass them to `save_alert_routine`/);
    }
  });

  it("ships both routine docs: each calls check_now and keeps keys out of chat", () => {
    for (const name of ["cleaner-core-check.md", "cleaner-core-alerts.md"]) {
      const doc = read(join(TEMPLATE, "routines", name));
      expect(doc, name).toContain("`check_now`");
      expect(doc, name).toContain("never in chat");
    }
    expect(read(join(TEMPLATE, "routines", "cleaner-core-alerts.md"))).toContain("Cleaner Core alerts are connected.");
  });

  it("asks which Google calendar holds the bookings and reads only that one", () => {
    for (const doc of [read(BOOTSTRAP), read(join(TEMPLATE, "routines", "cleaner-core-check.md"))]) {
      expect(doc).toMatch(/which\s+Google\s+calendar\s+holds\s+the\s+bookings/);
      expect(doc).toMatch(/only\s+that\s+calendar/);
      expect(doc).toMatch(/never\s+the\s+primary\s+calendar\s+unless\s+the\s+host\s+says/i);
    }
  });

  it("keeps the safety rules", () => {
    const text = read(BOOTSTRAP);
    for (const doc of [text, read(join(TEMPLATE, "bot-profile.md"))]) {
      expect(doc).toMatch(/Live texts go only to numbers the Cleaner Core operator approved/);
      expect(doc).toMatch(/Saving a\s+number doesn't approve it/);
    }
    expect(text).toMatch(/Never ask for a secret in chat/);
    expect(text).toMatch(/door code goes only on your secure card/);
    expect(text).toMatch(/after the host says the guests have left/);
    expect(text).toMatch(/only after the host's yes/);
  });
});

describe("Cleaner Core setup: one question per message", () => {
  /** Every place Grok reads how to ask: each step's next line, the guide, the bot profile, and the initialize instructions. */
  async function sources(): Promise<[string, string][]> {
    return [
      ["askNext", askNext("save_property")],
      ["bootstrap", read(BOOTSTRAP)],
      ["bot profile", read(join(TEMPLATE, "bot-profile.md"))],
      ["initialize", String((await rpc("initialize")).instructions)],
    ];
  }

  it("asks exactly one question per message, never two joined, and shows options as a tappable choice card", async () => {
    for (const [name, text] of await sources()) {
      const flat = text.replace(/\s+/g, " ");
      expect(flat, name).toMatch(/exactly one question/);
      expect(flat, name).toMatch(/the checkout and check-in times/);
      expect(flat, name).toMatch(/choice card the host can tap/);
    }
  });

  it("asks nothing about the property before get_state answers", async () => {
    for (const [name, text] of await sources()) {
      if (name === "askNext") continue;
      expect(text.replace(/\s+/g, " "), name).toMatch(/Ask the host nothing about the property until `?get_state`? answers/);
    }
  });
});

describe("Cleaner Core initialize instructions", () => {
  it("point at the setup order", async () => {
    const text = String((await rpc("initialize")).instructions);
    // save_alert_routine is named earlier for its upload link, so read the order from the setup line.
    const setup = text.slice(text.indexOf("Setup goes in this order"));
    const order = SETUP_TOOLS.slice(1, 9);
    const positions = order.map((tool) => setup.indexOf(tool));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text.startsWith("Call get_state first and follow its next step.")).toBe(true);
  });
});

describe("Cleaner Core template docs", () => {
  const docs = () => [BOOTSTRAP, ...filesUnder(TEMPLATE)].map((f) => ({ f, text: read(f) }));

  it("name only real Cleaner Core tools, or Supply Core's when the add-on is on", async () => {
    const tools = [...(await toolNames()), ...SUPPLY_FRONT_NAMES];
    for (const { f, text } of docs()) {
      for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) expect(tools, `${f}: ${m[1]}`).toContain(m[1]);
    }
  });

  it("contain no secrets, real phone numbers, or door-code-like digits", () => {
    const envValues = existsSync(join(ROOT, ".env"))
      ? read(join(ROOT, ".env"))
          .split("\n")
          .map((l) => /^[A-Z_]+=(.+)$/.exec(l.trim())?.[1]?.trim())
          .filter((v): v is string => !!v && v.length >= 8)
      : [];
    for (const { f, text } of docs()) {
      expect(text, f).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
      expect(text, f).not.toMatch(/\b(sk|xai|sb)[-_][A-Za-z0-9]{16,}/);
      expect(text, f).not.toMatch(/\b(AC|SK)[0-9a-f]{32}\b/);
      expect(text, f).not.toMatch(/[A-Z_]+(KEY|SECRET|TOKEN)\s*=\s*\S/);
      expect(text, f).not.toMatch(/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/);
      for (const m of text.matchAll(/\+?1?[\s.-]?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{2})(\d{2}|xx)/g)) {
        expect(`${m[1]}-${m[2]}-${m[3]}`, `${f}: ${m[0]}`).toMatch(/^\d{3}-555-01$|^555-01\d-\d{2}$/);
      }
      // A bare run of 4 to 8 digits reads like a door code. Years, clock times, and 555 numbers are fine.
      for (const m of text.matchAll(/(?<![\d:.-])\d{4,8}(?![\d:-])/g)) expect(m[0], `${f}: ${m[0]}`).toMatch(/^20\d\d$/);
      expect(text.includes(DOOR_CODE), f).toBe(false);
      for (const v of envValues) expect(text.includes(v), `${f} contains a value from .env`).toBe(false);
    }
  });
});
