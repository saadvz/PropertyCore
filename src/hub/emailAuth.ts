/**
 * The sender check from an email's Authentication-Results header (#263). The host's mailbox provider
 * adds that header on top of the email when it arrives; a sender can put fake ones further down. So
 * only the topmost header counts, and only when a mailbox provider this knows wrote it. Pure.
 * See docs/superpowers/specs/2026-11-20-booking-platforms-design.md.
 */

export type AuthVerdict = "pass" | "fail" | "unknown";

/** Mailbox providers whose Authentication-Results this trusts, by their authserv-id. */
const PROVIDERS = [/^mx\.google\.com$/, /\.protection\.outlook\.com$/, /(^|\.)icloud\.com$/, /(^|\.)yahoo\.com$/];

/** The most of the header text that is read. */
export const MAX_AUTHENTICATION = 4000;

/**
 * pass: the provider's header shows DMARC passing for the From domain, or DKIM or SPF passing for a
 * domain aligned with it. fail: the header shows a DMARC failure, or no aligned pass at all. unknown:
 * no header, or the topmost isn't from a provider this knows.
 */
export function authVerdict(authentication: string | undefined, fromDomain: string): AuthVerdict {
  const top = topmost(authentication);
  if (!top) return "unknown";
  const body = top.replace(/\([^()]*\)/g, " ");
  const [authserv = "", ...parts] = body.split(";").map((part) => part.trim());
  // An authserv-id is a host name with no "=": "spf=pass ..." first means there's none.
  if (authserv.includes("=") || !PROVIDERS.some((provider) => provider.test(authserv.split(/\s+/)[0]!.toLowerCase()))) return "unknown";
  const from = fromDomain.toLowerCase();
  let pass = false;
  for (const part of parts) {
    const method = /^(dmarc|dkim|spf)\s*=\s*([a-z]+)/i.exec(part);
    if (!method) continue;
    const name = method[1]!.toLowerCase();
    const result = method[2]!.toLowerCase();
    const prop = (key: string) => new RegExp(`(?:^|\\s)${key.replace(".", "\\.")}\\s*=\\s*"?([^\\s";]+)`, "i").exec(part)?.[1]?.toLowerCase();
    if (name === "dmarc") {
      if (result === "fail") return "fail";
      if (result === "pass" && aligned(prop("header.from"), from)) pass = true;
    } else if (name === "dkim" && result === "pass") {
      const domain = prop("header.d") ?? prop("header.i")?.split("@").at(-1);
      if (aligned(domain, from)) pass = true;
    } else if (name === "spf" && result === "pass") {
      const domain = prop("smtp.mailfrom")?.split("@").at(-1);
      if (aligned(domain, from)) pass = true;
    }
  }
  return pass ? "pass" : "fail";
}

/** The topmost header's value, without its name. */
function topmost(text: string | undefined): string | undefined {
  const raw = text?.slice(0, MAX_AUTHENTICATION).replace(/\r\n?/g, "\n").trim();
  if (!raw) return undefined;
  const headers = raw.split(/^authentication-results:/im).map((part) => part.replace(/\n[ \t]+/g, " ").trim());
  // With names, the text before the first one is something else; without, the whole text is one value.
  const values = /^authentication-results:/i.test(raw) ? headers.slice(1) : [headers[0]!.split("\n")[0]!];
  return values.find((value) => value !== "")?.split("\n")[0];
}

/** Relaxed alignment: the same domain, or one a subdomain of the other. */
function aligned(domain: string | undefined, from: string): boolean {
  // A bare top-level domain ("com") is nobody's sender.
  if (!domain || !from || !domain.includes(".")) return false;
  return domain === from || from.endsWith(`.${domain}`) || domain.endsWith(`.${from}`);
}
