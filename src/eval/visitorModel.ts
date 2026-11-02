import { LLMIntentInterpreter, LayeredIntentInterpreter, RuleBasedIntentInterpreter, intentModelFromEnv } from "../intent";
import { CATALOG, catalogContext } from "../../test/visitorScenarios.data";

/**
 * `npm run eval:visitor-model`: runs each visitor scenario catalog text through the rules plus the
 * configured model (TOURCORE_INTENT_MODEL_URL, _KEY, TOURCORE_INTENT_MODEL), the same layering touring
 * uses, and through the model alone. Prints PASS or FAIL per entry and a total. Not a gate: it always
 * exits 0. It prints the model's name and nothing secret. Run it locally, never in CI.
 */

/** Questions the demo property answers from setup details, so touring never asks the model about them. */
const SETTLED = new Set(["How much is 1A?", "Is there parking?", "How long does the tour take?", "Do I need ID?"]);

async function main(): Promise<void> {
  const model = intentModelFromEnv(process.env);
  if (!model) {
    console.log("No model configured. Set TOURCORE_INTENT_MODEL_URL, TOURCORE_INTENT_MODEL_KEY, and TOURCORE_INTENT_MODEL to run the check.");
    return;
  }
  const timeoutMs = Number(process.env.TOURCORE_INTENT_MODEL_TIMEOUT_MS) || undefined;
  const semantic = new LLMIntentInterpreter(model, { timeoutMs });
  const layered = new LayeredIntentInterpreter(new RuleBasedIntentInterpreter(), semantic);
  console.log(`Visitor model check: ${model.name}`);
  let layeredPass = 0;
  let modelPass = 0;
  for (const entry of CATALOG) {
    const ctx = catalogContext(entry);
    // The same two reads touring makes: rules (then the model when they're unsure), then the model's
    // second read of an unrecognized property question. The catalog's property has no facts here.
    let read = await layered.interpret(ctx);
    if (read.intent.type === "ASK_PROPERTY_QUESTION" && read.interpreter === "rules" && !SETTLED.has(entry.text)) read = (await layered.reclassify(ctx)) ?? read;
    const both = read.intent.type;
    let alone: string;
    try {
      alone = (await semantic.interpret(ctx)).intent.type;
    } catch (err) {
      alone = `error (${err instanceof Error ? err.message.replace(/Bearer\s+\S+/g, "Bearer [hidden]") : "unknown"})`;
    }
    if (both === entry.intent) layeredPass++;
    if (alone === entry.intent) modelPass++;
    console.log(`${both === entry.intent ? "PASS" : "FAIL"}  row ${entry.row}  "${entry.text}"  expected ${entry.intent}, got ${both}; model alone: ${alone}`);
  }
  console.log(`Rules + model: ${layeredPass}/${CATALOG.length} passed. Model alone: ${modelPass}/${CATALOG.length}.`);
}

main().catch((err) => {
  console.log(`The check couldn't finish: ${err instanceof Error ? err.message : "unknown error"}`);
});
