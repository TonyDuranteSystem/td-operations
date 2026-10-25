/**
 * TD Marketing — which tours a person has finished or skipped (dev job 9aec66fa; table marketing_tour_seen, one row per person, team and tour). Failing safe: when the table cannot be read
 * (the migration is not on this database yet, or the database is slow) the tour is treated as SEEN, so a person is never nagged with a tour that cannot be remembered.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isTourKey, type TourKey } from "@/lib/marketing/tour"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

/** Has this person already finished or skipped this tour? True when we cannot tell. */
export async function tourSeen(userId: string, teamId: string, key: TourKey): Promise<boolean> {
  try {
    const { data, error } = await db().from("marketing_tour_seen").select("status").eq("user_id", userId).eq("team_id", teamId).eq("tour_key", key).maybeSingle()
    if (error) { console.error("[marketing] tour seen read failed:", error.message); return true }
    return !!data
  } catch (e) {
    console.error("[marketing] tour seen read failed:", e instanceof Error ? e.message : e)
    return true
  }
}

/** Remember that this person finished or skipped this tour (again later just updates the time). */
export async function markTourSeen(input: { userId: string; teamId: string; key: unknown; status: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTourKey(input.key)) return { ok: false, error: "Unknown tour." }
  if (input.status !== "done" && input.status !== "skipped") return { ok: false, error: "Unknown status." }
  const { error } = await db().from("marketing_tour_seen")
    .upsert({ user_id: input.userId, team_id: input.teamId, tour_key: input.key, status: input.status, seen_at: new Date().toISOString() }, { onConflict: "user_id,team_id,tour_key" })
  if (error) { console.error("[marketing] tour seen save failed:", error.message); return { ok: false, error: "Could not save. It will start again next time." } }
  return { ok: true }
}
