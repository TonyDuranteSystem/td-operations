/**
 * The Accounts list's "Message" pop-up: what a staff message to ONE company's chat needs to know.
 *
 * Same pop-up and same send as the Contacts list's Message icon (lib/portal/contact-message-context.ts), but the recipient is the company the
 * row is about, so that company is pre-selected: Antonio clicked its row, there is nothing to guess (the 2026-08-07 leak rule is about a
 * session silently picking a company, which cannot happen here). The pop-up says plainly "Visible to everyone in <company>".
 *
 * Two lines under the choices, both worked out here when the pop-up OPENS (never per list row):
 *  - an amber warning when NOBODY can read the chat yet (no linked person has a working login and no chat teammate is active);
 *  - a grey line saying who the portal alert and email go to. A company message is readable by everyone linked, but the staff send
 *    nudges ONE person — resolveAdminReplyContact (last client who wrote in the chat, else the main contact, else the first by id) —
 *    exactly the one the real send will pick, because it is the same helper.
 * A lookup that fails says nothing rather than a false warning. The send itself is not here: the pop-up posts to POST /api/portal/chat.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { resolveDocLocale } from "@/lib/portal/document-alerts"
import { buildShareTargets } from "@/lib/portal/document-share-message"
import { listAllAuthUsers } from "@/lib/auth-admin-helpers"
import { accountAudience, resolveAdminReplyContact } from "@/lib/portal/admin-send-scope"
import { contactsWithWorkingLogin, type LoginLike } from "@/lib/portal/contact-message-context"
import { companyAlertInfo, companyReachNotice, type ShareContext } from "@/lib/portal/document-share-text"

/** null when the company does not exist. */
export async function getAccountMessageContext(accountId: string): Promise<ShareContext | null> {
  const { data: account, error } = await supabaseAdmin.from("accounts").select("id, company_name").eq("id", accountId).maybeSingle()
  if (error) throw new Error(`Could not read the company (${error.message}).`)
  if (!account) return null
  const name = ((account.company_name as string | null) ?? "").trim()

  const targets = await buildShareTargets({ accountIds: [accountId], contactId: null, defaultAccountId: accountId, personIsDefault: false })
  const locale = await resolveDocLocale(accountId, null)
  const [notice, info] = await Promise.all([reachNotice(accountId, name), alertInfo(accountId)])
  return {
    askable: true, fileName: "", locale, defaultTopic: "", targets, recipientName: name || undefined,
    ...(notice ? { notice } : {}), ...(info ? { info } : {}),
  }
}

/** The amber "nobody can read it yet" line, or undefined (also when the lookup fails — never a false warning). */
async function reachNotice(accountId: string, name: string): Promise<string | undefined> {
  try {
    const { data: links } = await supabaseAdmin.from("account_contacts").select("contact_id").eq("account_id", accountId)
    const contactIds = Array.from(new Set(((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id)))
    let contactsWithLogin = 0
    if (contactIds.length > 0) {
      const { data: contacts } = await supabaseAdmin.from("contacts").select("id, email").in("id", contactIds)
      contactsWithLogin = contactsWithWorkingLogin((contacts ?? []) as { id: string; email: string | null }[], (await listAllAuthUsers()) as LoginLike[])
    }
    const audience = await accountAudience(accountId)
    return companyReachNotice(name, { contactCount: contactIds.length, contactsWithLogin, chatTeammates: audience.chatTeammateCount }) ?? undefined
  } catch {
    return undefined
  }
}

/** The grey "the alert goes to one person: X" line, or undefined. */
async function alertInfo(accountId: string): Promise<string | undefined> {
  try {
    const contactId = await resolveAdminReplyContact(accountId, null)
    if (!contactId) return undefined
    const { data: c } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contactId).maybeSingle()
    return companyAlertInfo((c?.full_name as string | null) ?? null) ?? undefined
  } catch {
    return undefined
  }
}
