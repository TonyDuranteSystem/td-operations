/**
 * Canonical language → locale normalization. THE single source of truth.
 *
 * `contacts.language` is messy free text in production ("Italian", "English",
 * "Italiano", "Italian - englis", "it", "en", "", null). Before this module
 * existed, four separate normalizers lived in greeting.ts, auto-create.ts,
 * welcome-message.ts and wizard-failure-notify.ts — and a fifth site
 * (notifications.ts) used a broken strict `=== 'it'` check that sent English
 * emails to Italian clients. Every language read MUST go through this helper;
 * adding a future locale means extending it here only.
 */

export type Locale = "it" | "en"

/** Normalize a free-text contacts.language value to a portal locale.
 * Anything that looks Italian → "it"; everything else (including blank,
 * null and unknown values) → "en". */
export function localeFromLanguage(language: string | null | undefined): Locale {
  const v = (language ?? "").trim().toLowerCase()
  return v === "it" || v.startsWith("ital") ? "it" : "en"
}

/** Convenience predicate for call sites that only branch on Italian. */
export function isItalian(language: string | null | undefined): boolean {
  return localeFromLanguage(language) === "it"
}
