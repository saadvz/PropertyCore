import type { Hub } from "../hub/hub";
import { ASSISTANT_PROFILES, cleanerAssistant, type CleanerAssistant } from "./assistant";
import { cleanerCoreEnabled } from "./flag";
import { liveDeskFor } from "./liveDesk";
import type { SaveSecrets } from "./mcp";

/**
 * The private page behind a one-time upload link, for a Claude, ChatGPT, or Muse deployment. None
 * has a secure card that can hold the value, so the host opens the link (on Muse, in Muse's own
 * browser) and types the value here. The form posts back to the same link, through the same checks
 * as a JSON upload. Nothing typed is ever shown back, logged, or put in the reply.
 */
export type UploadPageKind = "door-code" | "calendar-link" | "alert-routine";

/** A browser form post. A JSON post still goes to the JSON upload handler. */
export function isFormPost(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("application/x-www-form-urlencoded");
}

const HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

const GONE_TITLE = "This link isn't valid anymore";
const goneText = (chat: string) => `It was already used, or it expired after 10 minutes. Go back to ${chat} and ask for a new link.`;
const once = (chat: string) => `This private page works once and expires 10 minutes after ${chat} made it. Cleaner Core never shows what you type back to anyone, ${chat} included.`;

interface PageCopy {
  title: string;
  lead: (chat: string, name?: string) => string;
  fields: string;
  refused: string;
}

const COPY: Record<UploadPageKind, PageCopy> = {
  "door-code": {
    title: "Save the door code",
    lead: (chat) => `Type the door code the cleaner uses. It goes to the cleaner only after you tell ${chat} the guests have left.`,
    fields: `<label for="code">Door code</label>
        <input id="code" name="code" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required>
        <p class="hint">4 to 8 digits.</p>`,
    refused: "Type the door code as 4 to 8 digits.",
  },
  "calendar-link": {
    title: "Save a calendar link",
    lead: (_chat, name) => `Paste the export link for ${name ? escape(name) : "the booking calendar"}. Cleaner Core reads bookings from it and never shares it.`,
    fields: `<label for="url">Calendar export link</label>
        <input id="url" name="url" type="url" autocomplete="off" spellcheck="false" placeholder="https://" required>`,
    refused: "Paste the calendar's public https export link.",
  },
  "alert-routine": {
    title: "Connect Cleaner Core alerts",
    lead: () => "Paste the Fire URL and the token from the Cleaner Core scheduled task's API trigger. Cleaner Core uses them only to wake that task when something happens.",
    fields: `<label for="url">Fire URL</label>
        <input id="url" name="url" type="url" autocomplete="off" spellcheck="false" placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire" required>
        <label for="token">Token</label>
        <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>`,
    refused: "Paste the Fire URL from the scheduled task's API trigger, and its token.",
  },
};

export async function handleCleanerUploadPage(input: {
  kind: UploadPageKind;
  code: string;
  method: string;
  contentType: string;
  /** Undefined when the body is over the upload cap. */
  readBody: () => Promise<Buffer | undefined>;
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
  saveSecrets: SaveSecrets;
  /**
   * Multi-tenant Cleaner Core: the page speaks as the chat that made the link, and this chat when
   * the link doesn't say. Never put into the env: the desk's env decides texts and alerts.
   */
  multiTenant?: { fallback: CleanerAssistant | undefined };
  /**
   * The property's hub, on the shared service. A calendar link is the hub's, so its page works while
   * any flow is on for the property, Cleaner Core or not.
   */
  hub?: Hub;
}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const env = input.env();
  const missing = { status: 404, body: "Not found", headers: { "Content-Type": "text/plain" } };
  // A ChatGPT or Muse chat has no Fire URL or token, so it has no alert page.
  const noPage = (assistant: CleanerAssistant | undefined) => !assistant || !ASSISTANT_PROFILES[assistant].privatePages || (input.kind === "alert-routine" && ASSISTANT_PROFILES[assistant].polledTask);
  const hub = input.kind === "calendar-link" ? input.hub : undefined;
  if ((!hub && !cleanerCoreEnabled(env)) || (!input.multiTenant && noPage(cleanerAssistant(env)))) return missing;
  const desk = hub ? undefined : liveDeskFor(input.root, input.env, input.now);
  const html = (status: number, body: string) => ({ status, body, headers: { "Content-Type": "text/html; charset=utf-8", ...HEADERS } });
  const link = hub ? (hub.uploadLinkOpen(input.code) as { open: boolean; name?: string; by?: { assistant: CleanerAssistant } }) : await desk!.uploadLinkOpen(input.kind, input.code);
  const assistant = input.multiTenant ? (link.by?.assistant ?? input.multiTenant.fallback) : cleanerAssistant(env);
  if (noPage(assistant)) return missing;
  const chat = ASSISTANT_PROFILES[assistant!].helper;
  const copy = COPY[input.kind];
  if (!link.open) return html(404, page(GONE_TITLE, `<p>${goneText(chat)}</p>`));
  const shown = assistant === "muse" ? museCopy(copy, input.kind) : copy;
  if (input.method === "GET") return html(200, formPage(shown, chat, link.name));
  const raw = await input.readBody();
  if (!raw) return html(413, formPage(shown, chat, link.name, "That was too long. Try again."));
  const form = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
  const result = hub
    ? await hub.uploadCalendarLink(input.code, { url: form.url ?? "" })
    : input.kind === "door-code"
      ? await desk!.uploadDoorCode(input.code, { code: form.code ?? "" })
      : input.kind === "calendar-link"
        ? await desk!.uploadCalendarLink(input.code, { url: form.url ?? "" })
        : await desk!.uploadAlertRoutine(input.code, { url: form.url ?? "", token: form.token ?? "" }, input.saveSecrets);
  if (result.status === 200) return html(200, page("Saved", `<p>${escape(result.body.message ?? "Saved.")}</p>\n        <p>You can close this page and go back to ${chat}.</p>`));
  if (result.status === 404) return html(404, page(GONE_TITLE, `<p>${goneText(chat)}</p>`));
  if (result.status === 409) return html(409, page("Not saved", `<p>Saving this link would call off upcoming cleanings, so it wasn't saved. Tell ${chat}, and it will ask you what to do.</p>`));
  // A door code in the right shape that was still refused has a reason of its own, like a lock location.
  const reason = input.kind === "door-code" && /^\d{4,8}$/.test((form.code ?? "").trim()) && result.body.error ? result.body.error : copy.refused;
  return html(400, formPage(shown, chat, link.name, reason));
}

/**
 * On Muse the calendar link is a password field too: Meta keeps what the host types in a password
 * field of Muse's browser away from the model, so the link stays out of it like the door code.
 */
function museCopy(copy: PageCopy, kind: UploadPageKind): PageCopy {
  if (kind !== "calendar-link") return copy;
  return { ...copy, fields: copy.fields.replace('type="url"', 'type="password"') };
}

function formPage(copy: PageCopy, chat: string, name: string | undefined, error?: string): string {
  return page(
    copy.title,
    `<p>${copy.lead(chat, name)}</p>
      ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
      <form method="post">
        ${copy.fields}
        <button type="submit">Save</button>
      </form>
      <p class="hint">${once(chat)}</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta name="robots" content="noindex">
    <title>${escape(title)} · Cleaner Core</title>
    <style>
      :root { color-scheme: light dark; --bg: #f7f7f5; --card: #ffffff; --ink: #1f1f1d; --muted: #5f5f5a; --line: #d9d9d4; --accent: #1f5f4a; --error: #a3261c; }
      @media (prefers-color-scheme: dark) { :root { --bg: #171716; --card: #222220; --ink: #ececea; --muted: #a6a6a0; --line: #3a3a37; --accent: #7cc4a8; --error: #f08a80; } }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { max-width: 30rem; margin: 3rem auto; padding: 0 16px; }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
      h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
      label { display: block; font-weight: 600; margin: 1rem 0 0.35rem; }
      input { width: 100%; font: inherit; padding: 0.6rem 0.7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); }
      button { margin-top: 1.25rem; font: inherit; font-weight: 600; padding: 0.6rem 1.2rem; border: 0; border-radius: 8px; background: var(--accent); color: var(--card); cursor: pointer; }
      .hint { color: var(--muted); font-size: 0.9rem; }
      .error { color: var(--error); font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
      <h1>${escape(title)}</h1>
      ${body}
      </div>
    </main>
  </body>
</html>
`;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
