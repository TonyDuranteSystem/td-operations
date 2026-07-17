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

    const clientKey = deriveClientKey(input.accountId, input.contactId)
    await saveDecisionMemory({
      situation: `Explicitly marked important by ${input.savedByName} via 🧠 in the CRM ${input.surface === "team" ? "Team chat" : "Portal chat"}`,
      decision,
      sourceType,
      sourceRef,
      actors: [input.savedByName.toLowerCase()],
      tags: ["explicit_save"],
      ...(clientKey ? { clientKey } : {}),
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
