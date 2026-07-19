/**
 * Identifier redaction — PURE, no server-only import, so it is unit-testable.
 *
 * Lives apart from worker-bug-report.ts deliberately: that module is `server-only`
 * and therefore cannot be imported by vitest, and an untested redactor is a redactor
 * nobody knows the shape of. Same split the codebase uses for handler param schemas.
 */

/**
 * Strip identifiers before any excerpt reaches a team channel (dev job 17459c25).
 *
 * Worker wall reports quote the staff message and the draft reply verbatim. On Portal
 * Chats and the Inbox those strings routinely carry a real client's tax IDs, bank
 * details and email addresses — and a channel has a wider readership than the
 * one-client thread the text came from. The wall diagnosis is what makes the report
 * useful; the identifiers never were.
 *
 * Order matters: most specific formats first, so an ITIN is not half-eaten by the
 * generic long-digit rule and left partially readable.
 *
 * This is a blunt instrument on purpose. It is the last line before client data leaves
 * a client conversation, so it errs toward over-redacting; the alternative failure —
 * a tax ID sitting in a channel forever — is not recoverable.
 */
export function redactIdentifiers(s: string): string {
  return (s ?? '')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[id]')                     // SSN / ITIN
    .replace(/\b\d{2}-\d{7}\b/g, '[ein]')                          // EIN
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/gi, '[iban]')       // IBAN-shaped
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]')           // any address
    .replace(/\b\d[\d\s-]{7,}\d\b/g, '[number]')                   // card/account runs
}
