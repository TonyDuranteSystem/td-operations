/**
 * Business Brain — shared "learn from this turn" capture (dev job 203cda1a, P2).
 *
 * ONE write path for every worker surface (Portal Chats, Inbox, Team chat, Slack,
 * and the CRM sidebar once it becomes the worker). Extracts the durable, reusable
 * lesson — situation + decision + the WHY (reasoning) — from a single turn and
 * saves it via saveDecisionMemory.
 *
 * D1 (Antonio, binding): SAVE-BY-DEFAULT, CLIENT-SCOPED. Auto-capture NEVER
 * auto-globalizes — a lesson becomes global ONLY via an explicit human promote
 * (P3), never here. So a capture with NO clientKey is SUPPRESSED (we do not write
 * a global row). This is the code-side guarantee that pairs with the P1 read wall
 * (match_decision_memory returns global-only): private facts can neither be
 * written global by accident nor read cross-client.
 *
 * INPUTS ARE THE STAFF MESSAGE + THE PRIOR WORKER REPLY ONLY. We deliberately do
 * NOT feed enriched/fenced client content (attachment text, referenced threads,
 * the assembled worker context) into the extractor — that untrusted-content →
 * global-lesson path is the Adam-Marra incident class (council bug-hunter). The
 * lesson is what a human said to correct/confirm, grounded against what the worker
 * had proposed — nothing else.
 */

import { callAI } from "@/lib/portal/ai-provider"
import { saveDecisionMemory } from "./decision-memory"

/** Why this capture fired — correction supersedes later (P4); additive never does. */
export type CaptureMode = "correction" | "additive"

export interface CaptureLessonParams {
  /** The human/staff message this turn (the correction or the thing being saved). */
  staffMessage: string
  /** The worker's prior reply being corrected/confirmed. Empty => nothing to ground against. */
  priorReply: string
  /**
   * Client scope, canonical form "account:<id>" | "contact:<id>" | "lead:<id>".
   * REQUIRED for a save. null/empty => SUPPRESSED (D1: auto-capture never globalizes).
   */
  clientKey: string | null | undefined
  /** Which surface fired this — becomes source_type, e.g. "portal_chat", "inbox", "team_chat", "slack". */
  surface: string
  /** Opaque source reference (message id, thread id) for idempotency/audit. */
  sourceRef?: string
  /** Who was involved. Defaults to ["antonio", "claude"]. */
  actors?: string[]
  /** correction = replacing a wrong answer (supersede-eligible in P4); additive = ask-to-save/confirm. */
  mode?: CaptureMode
}

export type CaptureSkipReason =
  | "message_too_short"
  | "no_prior_reply"
  | "no_lesson"
  | "scrub_empty"
  | "error"

export interface CaptureLessonResult {
  saved: boolean
  memoryId?: string
  /** Scope the lesson was written at (only present when saved). */
  scope?: "client" | "global"
  skipReason?: CaptureSkipReason
}

/** A bare "no" / "ok" is too thin to be a durable lesson; require some substance. */
const MIN_MESSAGE_LEN = 15

/**
 * The lesson the extractor is asked to emit. `reasoning` (the WHY) is new in P2 —
 * the brain must capture context, not just the answer (charter req 3).
 */
interface ExtractedLesson {
  situation?: string
  lesson?: string
  reasoning?: string
  domain?: string
  no_lesson?: boolean
}

/**
 * Extract the durable business lesson from (priorReply, staffMessage). Returns
 * null when there is no reusable lesson (or on any extractor failure — best-effort).
 * Exported for unit testing the parse/guard logic without a live model call is done
 * via the injected `callFn` seam.
 */
export async function extractLesson(
  priorReply: string,
  staffMessage: string,
  callFn: typeof callAI = callAI,
): Promise<ExtractedLesson | null> {
  try {
    const { text } = await callFn({
      systemPrompt:
        "Antonio (CEO of Tony Durante LLC) or his staff may be correcting or confirming a prior worker reply. " +
        "Extract the durable, reusable business lesson — and WHY it is the right answer. " +
        'Return ONLY JSON: {"situation": "...", "lesson": "...", "reasoning": "...", "domain": "..."} ' +
        "when there is a real, reusable lesson (situation = when this applies; lesson = the decision/answer; " +
        "reasoning = why, the thinking behind it; domain = a short bucket like billing/tax/formation/onboarding). " +
        'Return {"no_lesson": true} when the message is not a correction/confirmation or carries no reusable lesson. ' +
        "No prose, JSON only.",
      userPrompt: `PRIOR WORKER REPLY:\n${(priorReply || "").slice(0, 1200)}\n\nSTAFF MESSAGE:\n${staffMessage.trim()}`,
      maxTokens: 400,
      temperature: 0,
      model: "sonnet",
    })

    // Tolerant parse: strip code fences and grab the first {...} block.
    const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    let parsed: ExtractedLesson
    try {
      parsed = JSON.parse(match[0]) as ExtractedLesson
    } catch {
      return null
    }
    if (parsed.no_lesson || !parsed.situation?.trim() || !parsed.lesson?.trim()) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * D1-SAFETY scrub: rewrite a lesson as a GENERAL, client-free rule before any
 * GLOBAL write (no-client auto-capture, 🧠, promote-to-global). Strips client
 * names / company names / people / amounts / account numbers so a shared lesson
 * never carries one client's private fact (council BLOCKER-2; Antonio's "🧠 must
 * go through the name-scrubbing review"). CLIENT-SCOPED writes never call this —
 * they stay private to that client, raw.
 *
 * Best-effort: on any extractor/parse failure returns null so the caller can
 * decide (we FAIL CLOSED — a global write is skipped rather than written unscrubbed).
 */
export async function generalizeForGlobal(
  lesson: { situation: string; decision: string; reasoning?: string },
  callFn: typeof callAI = callAI,
): Promise<{ situation: string; decision: string; reasoning?: string } | null> {
  try {
    const { text } = await callFn({
      systemPrompt:
        "Rewrite this business lesson as a GENERAL rule that applies to ANY client. " +
        "REMOVE every client-specific detail: company names, people's names, dollar amounts, " +
        "account/EIN/ID numbers, addresses, dates tied to one client. Keep the reusable " +
        "principle and the reasoning. If after removing specifics nothing reusable remains, " +
        'return {"empty": true}. Return ONLY JSON: ' +
        '{"situation":"...","decision":"...","reasoning":"..."} or {"empty": true}. JSON only.',
      userPrompt: `SITUATION:\n${lesson.situation}\n\nDECISION:\n${lesson.decision}\n\nREASONING:\n${lesson.reasoning ?? ""}`,
      maxTokens: 400,
      temperature: 0,
      model: "sonnet",
    })
    const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    let parsed: { situation?: string; decision?: string; reasoning?: string; empty?: boolean }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return null
    }
    if (parsed.empty || !parsed.situation?.trim() || !parsed.decision?.trim()) return null
    return {
      situation: parsed.situation.trim(),
      decision: parsed.decision.trim(),
      reasoning: parsed.reasoning?.trim() || undefined,
    }
  } catch {
    return null
  }
}

/**
 * Turn a message a human explicitly marked (🧠 / "make this a rule") into a
 * GENERAL, client-free lesson for the shared brain. Antonio (2026-07-17): "🧠
 * means make it global." Strips client specifics (names / companies / amounts /
 * ids) AND derives a content-based `situation` so the lesson is recalled by
 * MEANING — unlike the old 🧠 save, which embedded the meta-string "marked
 * important" and so was effectively unrecallable by content. Fails closed:
 * returns null if nothing generally reusable survives (caller skips the save).
 */
export async function distillMarkedMessage(
  messageText: string,
  callFn: typeof callAI = callAI,
): Promise<{ situation: string; decision: string; reasoning?: string } | null> {
  const text = (messageText ?? "").trim()
  if (!text) return null
  try {
    const { text: out } = await callFn({
      systemPrompt:
        "A staff member marked this message as important, reusable business knowledge. " +
        "Turn it into a GENERAL rule that applies to ANY client. REMOVE every client-specific " +
        "detail: company names, people's names, dollar amounts, account/EIN/ID numbers, addresses. " +
        "Derive a `situation` (when this rule applies), a `decision` (what to do), and short `reasoning`. " +
        'If nothing generally reusable remains, return {"empty": true}. ' +
        'Return ONLY JSON: {"situation":"...","decision":"...","reasoning":"..."} or {"empty": true}. JSON only.',
      userPrompt: `MARKED MESSAGE:\n${text.slice(0, 1500)}`,
      maxTokens: 400,
      temperature: 0,
      model: "sonnet",
    })
    const cleaned = out.replace(/```json\s*/gi, "").replace(/```/g, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    let parsed: { situation?: string; decision?: string; reasoning?: string; empty?: boolean }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return null
    }
    if (parsed.empty || !parsed.situation?.trim() || !parsed.decision?.trim()) return null
    return {
      situation: parsed.situation.trim(),
      decision: parsed.decision.trim(),
      reasoning: parsed.reasoning?.trim() || undefined,
    }
  } catch {
    return null
  }
}

/**
 * Capture a lesson from one turn and save it. Best-effort: never throws — a
 * memory-write failure must never break the surface that called it.
 *
 * Scope (D1, Antonio 2026-07-17):
 *  - clientKey present → CLIENT-SCOPED, raw text (stays private to that client).
 *  - clientKey absent  → GLOBAL, but SCRUBBED first (generalizeForGlobal) so no
 *    named client's fact reaches the shared brain. Fails closed: if the scrub
 *    can't produce a client-free rule, the global write is skipped.
 *
 * Guards (in order): substance → prior reply present → a real lesson extracted.
 */
export async function captureLessonFromTurn(
  params: CaptureLessonParams,
  deps: { callFn?: typeof callAI; saveFn?: typeof saveDecisionMemory } = {},
): Promise<CaptureLessonResult> {
  const callFn = deps.callFn ?? callAI
  const saveFn = deps.saveFn ?? saveDecisionMemory

  const staffMessage = (params.staffMessage ?? "").trim()
  const priorReply = (params.priorReply ?? "").trim()
  const clientKey = (params.clientKey ?? "").trim()

  if (staffMessage.length < MIN_MESSAGE_LEN) return { saved: false, skipReason: "message_too_short" }
  if (!priorReply) return { saved: false, skipReason: "no_prior_reply" }

  try {
    const lesson = await extractLesson(priorReply, staffMessage, callFn)
    if (!lesson) return { saved: false, skipReason: "no_lesson" }

    let situation = lesson.situation!.trim()
    let decision = lesson.lesson!.trim()
    let reasoning = lesson.reasoning?.trim() || undefined

    // GLOBAL write (no client in context) → scrub to a client-free general rule
    // first. Fail closed: if nothing reusable survives the scrub, skip the save.
    if (!clientKey) {
      const scrubbed = await generalizeForGlobal({ situation, decision, reasoning }, callFn)
      if (!scrubbed) return { saved: false, skipReason: "scrub_empty" }
      situation = scrubbed.situation
      decision = scrubbed.decision
      reasoning = scrubbed.reasoning
    }

    const mode: CaptureMode = params.mode ?? "correction"
    const memoryId = await saveFn({
      situation: situation.slice(0, 500),
      decision: decision.slice(0, 1000),
      reasoning: reasoning ? reasoning.slice(0, 1000) : undefined,
      botSaid: priorReply.slice(0, 300),
      correctionType: mode === "correction" ? "auto_detected" : "confirmed",
      domain: lesson.domain?.trim() || undefined,
      sourceType: params.surface,
      sourceRef: params.sourceRef,
      actors: params.actors ?? ["antonio", "claude"],
      tags: [mode === "correction" ? "auto_correction" : "explicit_save"],
      clientKey: clientKey || null,
    })
    return { saved: true, memoryId, scope: clientKey ? "client" : "global" }
  } catch (err) {
    console.warn(`[lesson-capture] capture failed on ${params.surface} (non-fatal):`, err)
    return { saved: false, skipReason: "error" }
  }
}
