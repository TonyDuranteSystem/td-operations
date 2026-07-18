/**
 * 🧠 reaction → save a chat message to memory, for the CRM chat surfaces
 * (Team Workspace + Portal Chats). Brings Antonio's Slack "react 🧠 to save"
 * behavior into the CRM (council redo WS1, dev job a9477d06). The Slack handler
 * lives in the Slack webhook; this is the CRM twin.
 *
 * SAFETY: the caller MUST have already established the reactor is STAFF (portal
 * messages can be reacted to by clients — only a staff 🧠 may write memory) and
 * that the reaction was ADDED (not removed). This module does the save; the
 * route does the gating.
 */

import { createHash } from "crypto"
import { saveDecisionMemory } from "@/lib/ai-agent/decision-memory"
import { supabaseAdmin } from "@/lib/supabase-admin"

/** The brain emoji, in the unicode form the CRM stores (Slack uses the "brain"
 * shortcode instead; that path is handled in the Slack webhook). */
export function isBrainEmoji(emoji: string | null | undefined): boolean {
  return (emoji ?? "").trim() === "🧠"
}

/**
 * Canonical per-client memory namespace ("account:<id>" | "contact:<id>"), the
 * same form the worker's client-scoped recall/save uses. Account wins when both
 * are present (an LLC message). Returns null when neither is set.
 */
export function deriveClientKey(
  accountId: string | null | undefined,
  contactId: string | null | undefined,
): string | null {
  if (accountId) return `account:${accountId}`
  if (contactId) return `contact:${contactId}`
  return null
}

/**
 * Save a chat message as an explicit decision memory. Best-effort — never
 * throws (a memory-write failure must never break the reaction toggle).
 * Idempotent per (source_ref, source_type): re-reacting / a retry won't
 * double-save. Returns true if a new memory was written.
 */
export async function saveChatMessageAsMemory(input: {
  messageText: string
  savedByName: string
  surface: "team" | "portal"
  messageId: string
  accountId?: string | null
  contactId?: string | null
}): Promise<boolean> {
  try {
    const decision = (input.messageText ?? "").trim()
    if (!decision) return false

    const sourceType = "crm_reaction"
    const sourceRef = `${input.surface}:${input.messageId}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data: existing } = await db
      .from("decision_memory")
      .select("id")
      .eq("source_ref", sourceRef)
      .eq("source_type", sourceType)
      .limit(1)
    if (existing?.length) return false

    // 🧠 = make it GLOBAL (Antonio 2026-07-17), even from a client's Portal chat.
    // Distill the marked message into a general, client-free rule (strips
    // names/amounts/ids) with a content-based situation so it's recalled by
    // meaning — the old save embedded the "marked important" meta-string and saved
    // client-scoped. The scrub is what keeps a client's private fact out of the
    // shared brain. Fails closed: nothing general survives → no save.
    const { distillMarkedMessage } = await import("@/lib/ai-agent/lesson-capture")
    const lesson = await distillMarkedMessage(decision)
    if (!lesson) return false
    await saveDecisionMemory({
      situation: lesson.situation,
      decision: lesson.decision,
      reasoning: lesson.reasoning,
      sourceType,
      sourceRef,
      actors: [input.savedByName.toLowerCase()],
      tags: ["explicit_save"],
      // GLOBAL — no clientKey.
    })
    return true
  } catch (err) {
    console.warn("[chat-memory-reaction] 🧠 save failed (non-fatal):", err)
    return false
  }
}

/** SHA-1 fingerprint of the message text — reserved for a future content-level
 * dedup if needed; kept tiny + pure for reuse/testing. */
export function messageFingerprint(text: string): string {
  return createHash("sha1").update(text ?? "").digest("hex").slice(0, 16)
}
