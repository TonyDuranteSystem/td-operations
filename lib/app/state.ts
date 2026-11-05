/**
 * TD Social — read and write one person's switches and "last opened" times (server; dev job 2072bc3e, Step 2 pull request B).
 * Writes go through the two database functions so two phones (or the phone and the web) can never undo each other's change:
 * the switches merge KEY BY KEY, and a "last opened" time only moves FORWARD. The person is always the session's, never the request's.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { PrefsPatch, StoredPrefs } from "@/lib/app/prefs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer table and functions than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any }

export interface StoredState extends StoredPrefs {
  inbox_opened?: Record<string, unknown> | null
}

/** null = this person has no row yet (everything is the rule defaults). Throws on a database error (callers decide how to degrade). */
export async function readState(userId: string): Promise<StoredState | null> {
  const { data, error } = await db().from("social_app_user_state").select("muted_tabs, alerts, inbox_opened").eq("user_id", userId).maybeSingle()
  if (error) throw new Error(`social_app_user_state read failed: ${error.code ?? "unknown"}`)
  return (data as StoredState | null) ?? null
}

export async function mergePrefs(userId: string, patch: PrefsPatch): Promise<void> {
  const { error } = await db().rpc("social_app_merge_prefs", { p_user: userId, p_mute: patch.mute, p_alerts: patch.alerts })
  if (error) throw new Error(`social_app_merge_prefs failed: ${error.code ?? "unknown"}`)
}

/** Record that the person opened this mailbox at `at`. Never moves an existing time backwards. With `onlyIfMissing` it only sets a first baseline. */
export async function markInboxOpened(userId: string, mailbox: string, at: Date, onlyIfMissing = false): Promise<string | null> {
  const { data, error } = await db().rpc("social_app_mark_inbox_opened", { p_user: userId, p_mailbox: mailbox, p_at: at.toISOString(), p_only_if_missing: onlyIfMissing })
  if (error) throw new Error(`social_app_mark_inbox_opened failed: ${error.code ?? "unknown"}`)
  return typeof data === "string" ? data : null
}
