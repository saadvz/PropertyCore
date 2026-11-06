/**
 * Supply Core never takes card details. A run of 13 to 19 digits, with single spaces or dashes
 * between them, that passes the Luhn check is treated as a card number wherever it appears.
 */

// Exactly 13 to 19 digits, not part of a longer digit run.
const RUN = /(?<![\d])\d(?:[ -]?\d){12,18}(?![ -]?\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function looksLikeCard(text: string): boolean {
  for (const match of text.matchAll(RUN)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (luhn(digits)) return true;
  }
  return false;
}

/** True when any string anywhere in the arguments looks like a card number. */
export function refuseCards(args: unknown): boolean {
  if (typeof args === "string") return looksLikeCard(args);
  if (Array.isArray(args)) return args.some(refuseCards);
  if (args && typeof args === "object") return Object.values(args).some(refuseCards);
  return false;
}
