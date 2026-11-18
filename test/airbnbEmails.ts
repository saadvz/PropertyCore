import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BookingEmailInput } from "../src/hub/airbnbEmail";

/** A made-up Airbnb email from test/fixtures/airbnb-emails: a From line, a Subject line, a blank line, then the body. */
export function sampleEmail(name: string, receivedAt = "2026-10-14T15:00:00.000Z", dir = "test/fixtures/airbnb-emails"): BookingEmailInput {
  const raw = readFileSync(join(dir, `${name}.txt`), "utf8");
  const [head, ...rest] = raw.split("\n\n");
  const lines = (head ?? "").split("\n");
  const header = (key: string) => lines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2) ?? "";
  return { from: header("From"), subject: header("Subject"), body: rest.join("\n\n"), messageId: `<${name}@example.test>`, receivedAt };
}

/** A made-up Airbnb guest-message email from test/fixtures/airbnb-messages (#242), in the same shape. */
export function sampleMessage(name: string, receivedAt = "2026-10-14T15:00:00.000Z"): BookingEmailInput {
  return sampleEmail(name, receivedAt, "test/fixtures/airbnb-messages");
}
