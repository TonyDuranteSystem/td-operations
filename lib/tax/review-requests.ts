/**
 * Staff requests written NEXT TO a client's answer during the tax questionnaire review (dev job 7df278cd, Shipment 1).
 *
 * Staff open the submitted answers, click the pencil beside an answer, write what the client must fix, and press Request Changes.
 * What staff wrote but have not sent is the DRAFT; every Request Changes press that carried requests becomes one ROUND (the story).
 * Everything is stored in ONE optional field on the tax submission (`review_requests`). This file is the pure core — no database,
 * no network — so the rules are testable on their own:
 *   - what a stored value means (defensive parse: a damaged or missing field reads as "nothing written", never throws),
 *   - adding / clearing one note, counting notes,
 *   - turning the draft into a round (remembering each answer as it was when staff asked),
 *   - after the client resubmits: which flagged answers were updated, which were not,
 *   - the words of the message the client receives.
 */

import { describeAnswerKey, formatValue } from "@/lib/flows/submitted-data"

export const MAX_NOTE_CHARS = 1000
export const MAX_MESSAGE_CHARS = 2000
/** A review has at most as many requests as the questionnaire has answers; this only stops a runaway client of the API. */
export const MAX_REQUESTS = 200

export interface ReviewRequest {
  /** the answer's own key in the saved submission */
  key: string
  /** the answer's label and its card ("Tax Questions"), as shown on the review screen */
  label: string
  group: string
  /** what staff wrote */
  note: string
  /** the answer as it was when staff asked, for display ("No", "1 file") and for the later comparison (raw JSON) */
  was: string | null
  was_raw: unknown
}

export interface ReviewRound {
  sent_at: string
  by: string
  /** an optional note to the client that is not about one answer */
  message: string | null
  requests: ReviewRequest[]
}

export interface ReviewDraft {
  requests: Record<string, string>
  message: string
}

export interface ReviewRequestsData {
  draft: ReviewDraft
  rounds: ReviewRound[]
}

export const EMPTY_REVIEW_REQUESTS: ReviewRequestsData = { draft: { requests: {}, message: "" }, rounds: [] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : ""
}

/** Read the stored field. Anything unexpected reads as "nothing written" — a damaged value must never break the review screen. */
export function parseReviewRequests(raw: unknown): ReviewRequestsData {
  if (!isRecord(raw)) return { draft: { requests: {}, message: "" }, rounds: [] }
  const draftRaw = isRecord(raw.draft) ? raw.draft : {}
  const requests: Record<string, string> = {}
  if (isRecord(draftRaw.requests)) {
    for (const [k, v] of Object.entries(draftRaw.requests)) {
      const note = cleanText(v, MAX_NOTE_CHARS)
      if (k && note) requests[k] = note
    }
  }
  const rounds: ReviewRound[] = []
  if (Array.isArray(raw.rounds)) {
    for (const r of raw.rounds) {
      if (!isRecord(r) || typeof r.sent_at !== "string") continue
      const reqs: ReviewRequest[] = []
      if (Array.isArray(r.requests)) {
        for (const q of r.requests) {
          if (!isRecord(q) || typeof q.key !== "string" || !q.key) continue
          const note = cleanText(q.note, MAX_NOTE_CHARS)
          if (!note) continue
          reqs.push({
            key: q.key,
            label: typeof q.label === "string" && q.label ? q.label : describeAnswerKey(q.key).label,
            group: typeof q.group === "string" && q.group ? q.group : describeAnswerKey(q.key).group,
            note,
            was: typeof q.was === "string" ? q.was : null,
            was_raw: q.was_raw === undefined ? null : q.was_raw,
          })
        }
      }
      rounds.push({
        sent_at: r.sent_at,
        by: typeof r.by === "string" ? r.by : "staff",
        message: cleanText(r.message, MAX_MESSAGE_CHARS) || null,
        requests: reqs,
      })
    }
  }
  return { draft: { requests, message: cleanText(draftRaw.message, MAX_MESSAGE_CHARS) }, rounds }
}

/** Write (or, with an empty note, clear) the draft request next to ONE answer. */
export function setDraftNote(data: ReviewRequestsData, key: string, note: string): ReviewRequestsData {
  const requests = { ...data.draft.requests }
  const clean = cleanText(note, MAX_NOTE_CHARS)
  if (clean) requests[key] = clean
  else delete requests[key]
  return { ...data, draft: { ...data.draft, requests } }
}

export function setDraftMessage(data: ReviewRequestsData, message: string): ReviewRequestsData {
  return { ...data, draft: { ...data.draft, message: cleanText(message, MAX_MESSAGE_CHARS) } }
}

/** How many answers have a written, unsent request. */
export function draftCount(data: ReviewRequestsData): number {
  return Object.keys(data.draft.requests).length
}

/** True when pressing Request Changes would send something staff wrote (a request next to an answer, or an overall message). */
export function hasDraftToSend(data: ReviewRequestsData): boolean {
  return draftCount(data) > 0 || data.draft.message !== ""
}

/** Which review states let staff write requests: a submission staff are looking at, never one the client is editing or that is released. */
export function canWriteReviewRequests(reviewStatus: string | null): boolean {
  return reviewStatus === null || ["submitted", "resubmitted", "under_review", "reopened"].includes(reviewStatus)
}

function rawOf(data: Record<string, unknown> | null | undefined, key: string): unknown {
  const v = data ? data[key] : undefined
  return v === undefined ? null : v
}

/**
 * Turn the draft into one round, remembering each flagged answer AS IT IS NOW (so "Updated by client" can compare later).
 * Requests next to an answer that no longer exists in the submission are dropped (a stale pencil). Returns null when there is
 * nothing to send. `requestKeysInData` guards against a request for an answer the submission does not hold.
 */
export function buildRound(params: {
  draft: ReviewDraft
  submittedData: Record<string, unknown> | null | undefined
  by: string
  at: string
}): ReviewRound | null {
  const { draft, submittedData, by, at } = params
  const requests: ReviewRequest[] = []
  for (const [key, note] of Object.entries(draft.requests)) {
    if (!note) continue
    if (!submittedData || !(key in submittedData)) continue
    const raw = rawOf(submittedData, key)
    const { group, label } = describeAnswerKey(key)
    requests.push({ key, label, group, note, was: formatValue(raw), was_raw: raw })
    if (requests.length >= MAX_REQUESTS) break
  }
  const message = draft.message || null
  if (requests.length === 0 && !message) return null
  return { sent_at: at, by, message, requests }
}

/** The stored field after a round is sent: the round is added to the story and the draft is emptied. */
export function appendRound(data: ReviewRequestsData, round: ReviewRound): ReviewRequestsData {
  return { draft: { requests: {}, message: "" }, rounds: [...data.rounds, round] }
}

export type AnswerOutcome = "updated" | "unchanged" | "removed"

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function isEmptyAnswer(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)
}

/**
 * After the client resubmits: for each answer staff flagged in a round, did the client change it?
 *  - the answer is empty now but was not → "removed" (the row may be gone),
 *  - the answer equals what it was → "unchanged",
 *  - otherwise → "updated".
 */
export function answerOutcomes(
  round: ReviewRound,
  submittedData: Record<string, unknown> | null | undefined,
): Array<ReviewRequest & { outcome: AnswerOutcome; now: string | null }> {
  return round.requests.map((q) => {
    const nowRaw = rawOf(submittedData, q.key)
    const outcome: AnswerOutcome = isEmptyAnswer(nowRaw) && !isEmptyAnswer(q.was_raw) ? "removed" : same(nowRaw, q.was_raw) ? "unchanged" : "updated"
    return { ...q, outcome, now: formatValue(nowRaw) }
  })
}

/** The newest round, or null when none was ever sent. */
export function latestRound(data: ReviewRequestsData): ReviewRound | null {
  return data.rounds.length > 0 ? data.rounds[data.rounds.length - 1] : null
}

/** The text of the plain history note for a round ("2 requests next to answers: …"). */
export function roundHistoryNote(round: ReviewRound): string {
  const parts: string[] = []
  if (round.requests.length > 0) {
    // an answer on a numbered card is named with its card ("Statements (Bank Account 2)"), so two accounts' answers are never confused
    const named = (q: ReviewRequest) => (/ \d+$/.test(q.group) ? `${q.label} (${q.group})` : q.label)
    parts.push(`${round.requests.length} request${round.requests.length === 1 ? "" : "s"} next to answers: ${round.requests.map(named).join(", ")}`)
  }
  if (round.message) parts.push(round.message)
  return parts.join(" — ") || "Changes requested from the flow workspace"
}

export interface LocalizedLine {
  en: string
  it: string
}

/**
 * The message the client receives when Request Changes carries requests. `labelFor` gives each answer's name in the client's
 * language where the questionnaire has one (the notes themselves are free text and go out exactly as staff wrote them).
 */
export function buildClientMessage(round: ReviewRound, labelFor: (q: ReviewRequest, locale: "en" | "it") => string): LocalizedLine {
  const list = (locale: "en" | "it") => round.requests.map((q) => `• ${labelFor(q, locale)}: ${q.note}`).join("\n")
  const parts = (locale: "en" | "it"): string => {
    const lead =
      locale === "en"
        ? round.requests.length > 0
          ? "Our team reviewed your tax submission and needs these changes:"
          : "Our team reviewed your tax submission and needs a change:"
        : round.requests.length > 0
          ? "Il nostro team ha revisionato la tua dichiarazione e servono queste modifiche:"
          : "Il nostro team ha revisionato la tua dichiarazione e serve una modifica:"
    const tail =
      locale === "en"
        ? "Please open your portal, fix the marked answers, and resubmit."
        : "Accedi al portale, correggi le risposte segnate e reinvia."
    return [lead, round.requests.length > 0 ? list(locale) : "", round.message ?? "", tail].filter((x) => x !== "").join("\n\n")
  }
  return { en: parts("en"), it: parts("it") }
}
