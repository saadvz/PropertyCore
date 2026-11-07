/** Digit helpers the hub and Cleaner Core share. */

/**
 * Joins digits split by spaces, dots, dashes, underscores, or slashes, so "8 0 8 8", "80-88", and
 * "8.0.8.8" read as 8088. A host message is checked for the door code in this form too.
 */
export function joinSplitDigits(text: string): string {
  return text.replace(/(\d)[\s.\-_/\u2010-\u2015]+(?=\d)/g, "$1");
}

/**
 * True when `code` sits in `text` as its own token, the rule of containsCodeToken in
 * src/cleaner-core/redact.ts, which the hub can't import. Only for "can this file be written" guards.
 */
export function holdsCodeToken(text: string, code: string): boolean {
  if (!code) return false;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:(?<![A-Za-z0-9_-])|(?<=\\\\[bfnrt])|(?<=\\\\u[0-9A-Fa-f]{4}))${escaped}(?![A-Za-z0-9_-])`).test(text);
}
