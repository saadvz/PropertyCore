/**
 * Calls to an account's line: a known caller leaves a voicemail, Twilio transcribes it, and the
 * transcript becomes news for the host. Nobody else is recorded.
 */

/** Where every account's line sends its calls. The `To` number picks the account. */
export const VOICE_PATH = "/webhooks/twilio/voice";
/** Where Twilio sends a voicemail's transcript. */
export const VOICE_TRANSCRIPT_PATH = "/webhooks/twilio/voice/transcript";
