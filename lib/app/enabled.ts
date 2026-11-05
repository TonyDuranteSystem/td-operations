/**
 * TD Social (iPhone app) — the runtime on/off switch (server; dev job 2072bc3e, Step 2 pull request A).
 *
 * The first thing every TD Social route does. OFF means the route answers "not switched on" and has NOT read any TD Social table, so
 * this code can be merged (and goes live on production the moment it merges) before the database file that creates its tables has
 * been run there. Only a stored `true` turns it on; a missing row, any other value or a failed read is OFF (fails CLOSED), the opposite
 * of a switch that removes something people already have.
 *
 * Lives in app_settings so it can be flipped without a deploy (a Vercel environment change needs a redeploy). There is no screen for it:
 * Claude sets it on Antonio's word.
 */
import { getAppSetting } from "@/lib/settings"

export const SOCIAL_APP_NOT_ENABLED = { error: "TD Social is not switched on yet.", code: "APP_NOT_ENABLED" } as const

export async function isSocialAppEnabled(): Promise<boolean> {
  try {
    return (await getAppSetting<unknown>("social_app_enabled", false)) === true
  } catch {
    return false
  }
}
