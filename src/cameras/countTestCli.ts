import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHubFile } from "../hub/store";
import { exportRows, formatReport, fromCsv, scoreRows, toCsv } from "./countTest";
import type { StoredLine } from "./lines";

/**
 * `npm run cameras:count-test -- export --root <property folder> --from YYYY-MM-DD --to YYYY-MM-DD --out sheet.csv [--counter gemini-4-neon-low-v1]`
 * `npm run cameras:count-test -- score --file sheet.csv`
 *
 * Run on the server against one test property's folder. It only reads the shared event log
 * (`visit-events/<YYYY-MM>.jsonl`) and writes the sheet where it's told. It never calls the camera provider.
 */

const DIR = "visit-events";

/** Every line in the property's shared event log, oldest month first. A line that won't parse is skipped. */
export function readLogLines(root: string): StoredLine[] {
  const dir = join(root, DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  return files.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .flatMap((text) => {
        if (!text.trim()) return [];
        try {
          const line = JSON.parse(text) as StoredLine;
          return line && typeof line.type === "string" && typeof line.id === "string" && typeof line.at === "string" ? [line] : [];
        } catch {
          return [];
        }
      }),
  );
}

const flag = (args: string[], name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function runCountTest(args: string[], say: (text: string) => void = (text) => console.log(text)): Promise<number> {
  const [command] = args;
  if (command === "export") {
    const root = flag(args, "root");
    const from = flag(args, "from");
    const to = flag(args, "to");
    const out = flag(args, "out");
    if (!root || !from || !to || !out || !DATE.test(from) || !DATE.test(to)) {
      say("Usage: export --root <property folder> --from YYYY-MM-DD --to YYYY-MM-DD --out sheet.csv [--counter <name>] (the end date isn't included; without --counter, the newest count per event)");
      return 2;
    }
    const timeZone = readHubFile(root)?.property.timeZone;
    if (!timeZone) {
      say("The property has no time zone, so its events can't be put in local time.");
      return 1;
    }
    const counter = flag(args, "counter");
    const rows = exportRows(readLogLines(root), { timeZone, from, to, ...(counter ? { counter } : {}) });
    writeFileSync(out, toCsv(rows), { mode: 0o600 });
    say(`Wrote ${rows.length} counted events to ${out}. The host fills in host_people, host_vehicles and host_animals for each, from their own camera app, then run score.`);
    return 0;
  }
  if (command === "score") {
    const file = flag(args, "file");
    if (!file || !existsSync(file)) {
      say("Usage: score --file sheet.csv");
      return 2;
    }
    say(formatReport(scoreRows(fromCsv(readFileSync(file, "utf8")))));
    return 0;
  }
  say("Commands: export, score");
  return 2;
}

if (process.argv[1] && /countTestCli\.[tj]s$/.test(process.argv[1])) {
  void runCountTest(process.argv.slice(2)).then((code) => process.exit(code));
}
