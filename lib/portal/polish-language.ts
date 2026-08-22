import { detectDraftLanguage } from "@/lib/ai-agent/draft-language"

/**
 * AI Polish's target-language decision — extracted so the rule can be pinned by a
 * test independent of the route's DB/AI-provider dependencies (dev job 9c251e65).
 *
 * Antonio, 2026-08-22 (verbatim intent): "the worker shouldn't guess or read the
 * primary contact — should just see the language that the client is writing. If
 * we send a new message... the worker can just ask... Stop! Easy!"
 *
 * This deliberately does NOT read `contacts.language` or any account-contact
 * lookup — that stored field, and the "primary contact" it depends on, is
 * exactly what turned out to be unreliable (230/230 sole-contact active accounts
 * had no primary contact flagged, dev job 9c251e65 investigation). The client's
 * own most recent message in the conversation is read directly instead.
 */
export type PolishLanguageDecision =
  | { kind: "language"; language: string | null } // null = keep the draft's own language
  | { kind: "ask" } // nothing reliable to go on — the caller must ask a human

/**
 * Picks the client's own most recent message out of a conversation row list
 * (ordered newest-first, as the caller's query already returns it).
 *
 * `portal_messages.sender_type` is a closed 3-value enum: 'client' | 'admin' |
 * 'system'. A positive match on 'client' is deliberate — 'system' rows are
 * automated notices (out-of-office auto-replies, banking/tax/formation
 * status notices, etc.), never the client's own words, and a prior version
 * of this logic (`sender_type !== 'admin'`) mistook them for client speech
 * whenever one landed as the most recent non-admin row (dev job 9c251e65,
 * live-QA incident 2026-08-22: an out-of-office auto-reply in English got
 * read as "what the client said" right after the client had actually
 * written in Italian).
 */
export function pickLastClientMessage(
  rows: { sender_type: string; message: string }[],
): string | null {
  return rows.find((m) => m.sender_type === "client")?.message ?? null
}

export function decidePolishLanguage(input: {
  /** A language the staff member explicitly picked for this message (the "ask" answer). Always wins. */
  explicitTargetLanguage?: string | null
  /** Staff opted to keep the draft's own language for this one message. Wins over detection. */
  preserveLanguage: boolean
  /** The client's own most recent message in this conversation, verbatim, or null/absent if there is none yet. */
  lastClientMessage: string | null | undefined
}): PolishLanguageDecision {
  if (input.explicitTargetLanguage) return { kind: "language", language: input.explicitTargetLanguage }
  if (input.preserveLanguage) return { kind: "language", language: null }
  const detected = detectDraftLanguage(input.lastClientMessage)
  if (detected === "it") return { kind: "language", language: "Italian" }
  if (detected === "en") return { kind: "language", language: "English" }
  // "unknown" covers both "no client message yet" and "too short/ambiguous to
  // tell" — Antonio's ruling (2026-08-22): both count as nothing to read from,
  // so both ask rather than guess.
  return { kind: "ask" }
}
