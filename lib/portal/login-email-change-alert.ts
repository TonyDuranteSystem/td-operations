/**
 * Tell staff — in the team chat they actually read — that a client pressed "This wasn't me" on the note about a
 * login-email change. That is the one moment someone else may have had the client's login or mailbox, so it needs a
 * person to look. Same pattern as the other automatic alerts (td-bug channel, "who / what happened / what to do").
 * SERVER-ONLY. Never throws.
 */
import { postTeamMessage } from "@/lib/team/post-message"

const CHANNEL = "td-bug"

export function undoStaffMessage(params: { fullName: string | null; contactId: string; restoredEmail: string; undoneEmail: string }): string {
  const who = params.fullName?.trim() || "A client"
  return `${who} pressed "This wasn't me" after their portal login email was changed. The login is back on ${params.restoredEmail}; ${params.undoneEmail} no longer works as a login, the CRM email went back, and the client chose a new password. Someone else may have had access to this client's mailbox or login. Fix: write to the client in the portal chat to check all is well (contact ${params.contactId}).`
}

export async function alertLoginEmailUndone(params: { fullName: string | null; contactId: string; restoredEmail: string; undoneEmail: string }): Promise<void> {
  try {
    await postTeamMessage({ channel: CHANNEL, message: `⚠️ ${undoStaffMessage(params)}` })
  } catch (e) {
    console.warn("[login-email-change] could not alert staff:", e instanceof Error ? e.message : e)
  }
}
