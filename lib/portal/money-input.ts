/**
 * Text handling for the price / discount boxes on the invoice form.
 *
 * A number box that starts at 0 left the 0 in place while typing ("0" + "15" showed "015"). These boxes now start empty
 * (a faint 0.00 hint) and keep the typed text themselves; the number is worked out from the text.
 */

/** What a person typed → the text we keep, or null when it is not a number being typed (letters, two dots...). A comma counts as a dot (Italian keyboards). */
export function cleanMoneyText(raw: string): string | null {
  const text = raw.replace(',', '.')
  return /^\d*\.?\d*$/.test(text) ? text : null
}

/** The typed text → the number (empty or a lone dot = 0). */
export function moneyTextToNumber(text: string): number {
  const n = Number(text)
  return Number.isFinite(n) ? n : 0
}

/** The number → what to show when it comes from outside (a template, editing an invoice): 0 shows as an empty box. */
export function moneyNumberToText(value: number): string {
  return value ? String(value) : ''
}
