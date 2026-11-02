import { LLMIntentInterpreter, OpenAICompatibleModel, type LanguageModel } from "./llm";
import { isConfident, type IntentInterpretation, type IntentInterpreter, type InterpretContext } from "./model";
import { RuleBasedIntentInterpreter } from "./ruleBased";

export * from "./model";
export { keywordOf, messagingKeyword, isPlainLanguageStop, isMedicalEmergency, interpretByRules, isCancelTourAsk, isUnbookedCancelAsk, isConcreteHelpProblem, isOnTourDoorAsk, onTourDoorIntent, RuleBasedIntentInterpreter, type Keyword } from "./ruleBased";
export { LLMIntentInterpreter, OpenAICompatibleModel, ModelReplySchema, type LanguageModel } from "./llm";
export { normalize } from "./normalize";

/** Steps where nothing typed changes what happens next, so a model call would be wasted. */
const RULES_ONLY_STEPS = new Set(["intro", "identity", "done", "stopped"]);

/**
 * Rules first; the semantic interpreter only for messages the rules can't
 * place confidently. If the model is slow, down or returns something
 * invalid, the rules' answer stands (which usually means Tour Core asks).
 */
export class LayeredIntentInterpreter implements IntentInterpreter {
  constructor(
    private readonly rules: IntentInterpreter = new RuleBasedIntentInterpreter(),
    private readonly semantic?: IntentInterpreter,
    private readonly log?: (line: string) => void,
  ) {}

  get description(): string {
    return this.semantic ? `rules + ${this.semantic.description}` : "rules";
  }

  /** Only with a model: the semantic interpreter's fact pick. Undefined (none) on any failure. */
  async pickFact(question: string, facts: string[], options: { name?: string } = {}): Promise<number | undefined> {
    if (!this.semantic?.pickFact) return undefined;
    try {
      return await this.semantic.pickFact(question, facts, options);
    } catch {
      return undefined;
    }
  }

  get hasSemantic(): boolean {
    return !!this.semantic;
  }

  async interpret(ctx: InterpretContext): Promise<IntentInterpretation> {
    const byRules = await this.rules.interpret(ctx);
    // Rules that recognised an attempt to instruct the assistant, or that already have Tour Core's own follow-up, are final.
    if (!this.semantic || isConfident(byRules) || byRules.manipulation || byRules.clarificationQuestion || RULES_ONLY_STEPS.has(ctx.step)) return byRules;
    let bySemantic: IntentInterpretation;
    try {
      bySemantic = await this.semantic.interpret(ctx);
    } catch (err) {
      this.log?.(`Couldn't reach the language model, so the built-in rules handled a text (${err instanceof Error ? err.message : "unknown error"}).`);
      return byRules;
    }
    if (bySemantic.intent.type === "UNKNOWN") return byRules;
    return byRules.intent.type === "UNKNOWN" || bySemantic.confidence >= byRules.confidence ? bySemantic : byRules;
  }
}

/**
 * Settings for the optional semantic interpreter. All three must be set; with
 * any missing, Tour Core runs on the built-in rules alone.
 */
export function intentModelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModel | undefined {
  const baseUrl = env.TOURCORE_INTENT_MODEL_URL?.trim();
  const apiKey = env.TOURCORE_INTENT_MODEL_KEY?.trim();
  const model = env.TOURCORE_INTENT_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) return undefined;
  return new OpenAICompatibleModel({ baseUrl, apiKey, model });
}

export function createIntentInterpreter(options: { env?: NodeJS.ProcessEnv; model?: LanguageModel; log?: (line: string) => void } = {}): LayeredIntentInterpreter {
  const model = options.model ?? intentModelFromEnv(options.env);
  const timeoutMs = Number(options.env?.TOURCORE_INTENT_MODEL_TIMEOUT_MS ?? process.env.TOURCORE_INTENT_MODEL_TIMEOUT_MS) || undefined;
  return new LayeredIntentInterpreter(new RuleBasedIntentInterpreter(), model ? new LLMIntentInterpreter(model, { timeoutMs }) : undefined, options.log);
}
