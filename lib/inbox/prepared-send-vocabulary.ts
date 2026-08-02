/**
 * Vocabulary for `worker_prepared_sends` — the frozen "confirm before it goes"
 * payload shared by the email and portal-chat send paths.
 *
 * Registered against the database CHECK constraints in `lib/db-contract.ts`, so a
 * value the code writes and the database rejects is a build failure rather than a
 * silently discarded write. (supabase-js RETURNS constraint rejections; it does not
 * throw — which is exactly how the esign expiry audit lost every row.)
 */

/**
 * WHICH CHANNEL a frozen payload will go out on.
 *
 * The column is NOT NULL with **no default** on purpose: a default of "email"
 * would make any insert that forgets the discriminator send a real email to a real
 * person. With no default the insert raises instead.
 */
export const PREPARED_SEND_KINDS = ["email", "portal"] as const
export type PreparedSendKind = (typeof PREPARED_SEND_KINDS)[number]

/**
 * The language a frozen PORTAL message is written in.
 *
 * Antonio, 2026-07-31 (verbatim): "Luca will choose the language in the dropdown:
 * Italian or English. When Luca chooses English, Luca can also speak in Italian for
 * the message, but the system will always go out in English. If Luca chooses Italian
 * in the card, but he will speak to the worker in English, the worker will write in
 * Italian."
 *
 * So this is the staff member's CHOICE, carried from the card — never a detector
 * verdict. There is deliberately no "unknown": a human always picked one. The
 * EN/IT draft detector (`lib/ai-agent/draft-language.ts`) is NOT used on this path;
 * it stays in place for the pinned direct-send surfaces that have no card.
 *
 * NULL on an email row — the email path has no language control.
 */
export const PREPARED_SEND_LOCALES = ["en", "it"] as const
export type PreparedSendLocale = (typeof PREPARED_SEND_LOCALES)[number]

/** Human label for the language, for card copy and worker instructions. */
export const LOCALE_LABEL: Record<PreparedSendLocale, string> = {
  en: "English",
  it: "Italian",
}
