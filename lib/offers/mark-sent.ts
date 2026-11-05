/**
 * The last write of Send (offer builder Part 3, item A, dev job d2971d11): flip the offer to "sent" — but ONLY if it is still a draft.
 *
 * Send reads the offer's status once at the start, then creates the login, sends the email, and only then writes "sent" (the
 * order is deliberate: an offer is never marked sent when the email failed). That write used to have no condition and its
 * result was never looked at, so whatever happened to the offer while the email was going out — someone else changed it, a
 * second Send finished first — was silently overwritten with "sent", and a failed write was invisible.
 *
 * It does NOT stop a second email (the email is already gone by now); it stops the late write from overwriting a newer state
 * and makes a failed or skipped write visible: it throws, and Send turns that into a warning on the result and in the log.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function markOfferSent(token: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("offers")
    .update({ status: "sent" })
    .eq("token", token)
    .eq("status", "draft")
    .select("token")
  if (error) throw new Error(`could not mark the offer as sent (${error.message})`)
  if (!data || data.length === 0) {
    throw new Error("the offer was no longer a draft when the email went out, so its status was left as it is")
  }
}
