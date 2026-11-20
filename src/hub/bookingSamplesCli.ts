import { resolve } from "node:path";
import { writeSamples } from "./bookingSamples";

/**
 * npm run booking:samples -- <property folder> <out folder>
 * Writes the Vrbo and Booking.com emails a host agreed to share (#263), with guest names, phones and
 * email addresses replaced, for Saad to read before any goes into test/fixtures/. Sends nothing.
 */
const [folder, out] = process.argv.slice(2);
if (!folder || !out) {
  console.error("Usage: npm run booking:samples -- <property folder> <out folder>");
  process.exit(2);
}
const count = writeSamples(resolve(folder), resolve(out));
console.log(count === 0 ? "No samples: the host hasn't agreed, or no Vrbo or Booking.com email was confirmed yet." : `Wrote ${count} ${count === 1 ? "sample" : "samples"} to ${resolve(out)}. Read each one before it goes into test/fixtures/.`);
