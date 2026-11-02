/**
 * TD Marketing — tell Antonio (in the team chat he reads, not only in the error log) that a "Forgot your password?" request could not be served: the person was told "a link is on its way" and
 * nothing arrived. Says WHO, WHAT went wrong and the exact way to fix it (make the link by hand from the Team page and send it). Said once per person per six hours so a person pressing the
 * button again cannot flood the channel. SERVER-ONLY. Never throws.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { reportSystemError } from "@/lib/system-errors"
import { postTeamMessage } from "@/lib/team/post-message"

export const FORGOT_ALERT_ROUTE = "/api/marketing/forgot"
const QUIET_HOURS = 6
const CHANNEL = "td-bug"

export function forgotProblemMessage(email: string, reason: string): string {
  return `TD Marketing: ${email} pressed "Forgot your password?" but no email reached them (${reason}). They were told a link is on its way. Fix: open the TD Marketing Team page, find their row, press "Reset password", copy the link and send it to them yourself (it works once, for 24 hours).`
}

/** `_` and `%` mean "any" in a LIKE pattern: an address with an underscore must still match only itself. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`)

export async function alertForgotProblem(email: string, reason: string): Promise<void> {
  try {
    const since = new Date(Date.now() - QUIET_HOURS * 3600 * 1000).toISOString()
    const { data } = await supabaseAdmin
      .from("system_errors")
      .select("id")
      .eq("route", FORGOT_ALERT_ROUTE)
      .ilike("message", `%${likeEscape(email)} pressed%`)
      .gte("created_at", since)
      .limit(1)
    if (data && data.length > 0) return
    const message = forgotProblemMessage(email, reason)
    await reportSystemError({ source: "server", route: FORGOT_ALERT_ROUTE, message })
    await postTeamMessage({ channel: CHANNEL, message: `⚠️ ${message}` })
  } catch (e) {
    console.warn("[marketing] could not alert staff about a failed Forgot password request:", e instanceof Error ? e.message : e)
  }
}
