import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { findContactIdByEmail } from "@/lib/operations/find-contact-by-email"

/**
 * CAN THIS TARGET ACTUALLY RECEIVE A PORTAL MESSAGE — and have they ever signed in?
 *
 * Antonio, 2026-08-02: "before the send is allowed, check whether the chosen target
 * already has access to the system and if it accessed."
 *
 * WHY. The Confirm card's client picker searches every role, and until now the card
 * assumed a company or a person could always receive a message. Two ways that was
 * wrong, both found the same day:
 *
 *  - A LEAD was refused outright with "there's no portal chat to send to". False:
 *    sending an offer creates a portal login for that person and resolves/creates a
 *    CONTACT to hang it on, so the same human appears in the search twice — once as a
 *    lead, once as a contact — and the contact CAN receive messages. Refusing the lead
 *    row while its twin sat in the same list was a bug in my own design, not a limit
 *    of the system. Now a lead resolves to that contact.
 *
 *  - A CONTACT WITH NO PORTAL AT ALL was fully selectable — co-members who never
 *    activated, spouses, a client's accountant. Confirm succeeded, the card said
 *    "posted", and the person got a "you have a new message" email pointing at a
 *    portal they cannot open. Nobody would ever read the message.
 *
 * Returns a verdict the card can render honestly, never a silent guess.
 */

export type Reachability =
  | {
      reachable: true
      /** What the send should actually be addressed to (a lead resolves to its contact). */
      target: { accountId?: string; contactId?: string }
      /** Display name of the resolved target, when it differs from what was picked. */
      resolvedName?: string | null
      /** Every member who would receive it — one for a person, all members for a company. */
      recipients: Array<{ name: string | null; email: string | null; hasLogin: boolean; lastSignInAt: string | null }>
      /** True when NOBODY in `recipients` has ever signed in. The send is still allowed. */
      neverSignedIn: boolean
    }
  | { reachable: false; reason: string }

async function describe(email: string | null, name: string | null) {
  if (!email) return { name, email, hasLogin: false, lastSignInAt: null }
  try {
    const user = await findAuthUserByEmail(email)
    return {
      name,
      email,
      hasLogin: !!user,
      lastSignInAt: (user?.last_sign_in_at as string | undefined) ?? null,
    }
  } catch {
    // A lookup failure must not read as "no access" — that would block a legitimate
    // send. Report it as unknown-but-present and let the human decide.
    return { name, email, hasLogin: true, lastSignInAt: null }
  }
}

export async function checkPortalReachability(input: {
  type: "account" | "contact" | "lead" | "partner"
  id: string
}): Promise<Reachability> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  if (input.type === "partner") {
    // Nothing in the codebase files a portal message against a partner, and portal
    // messages are keyed to an account or a contact only. Say so rather than failing
    // at the last step with a misleading "no longer exists".
    return { reachable: false, reason: "Partners don't have a portal chat — pick the company or the person." }
  }

  if (input.type === "lead") {
    // THE FIX FOR THE REFUSAL THAT WAS WRONG. Same resolution the offer flow uses.
    const { data: lead } = await db.from("leads").select("email, full_name").eq("id", input.id).maybeSingle()
    if (!lead?.email) {
      return { reachable: false, reason: "This lead has no email on file, so there's no portal account to reach." }
    }
    const contactId = await findContactIdByEmail(lead.email)
    if (!contactId) {
      return {
        reachable: false,
        reason: `${lead.full_name ?? "This lead"} doesn't have a portal account yet — one is created when an offer is sent to them.`,
      }
    }
    const { data: contact } = await db.from("contacts").select("full_name, email").eq("id", contactId).maybeSingle()
    const who = await describe(contact?.email ?? lead.email, contact?.full_name ?? lead.full_name)
    if (!who.hasLogin) {
      return {
        reachable: false,
        reason: `${who.name ?? "This person"} has no portal login yet — they wouldn't see the message.`,
      }
    }
    return {
      reachable: true,
      target: { contactId },
      resolvedName: contact?.full_name ?? lead.full_name ?? null,
      recipients: [who],
      neverSignedIn: !who.lastSignInAt,
    }
  }

  if (input.type === "contact") {
    const { data: contact } = await db.from("contacts").select("full_name, email").eq("id", input.id).maybeSingle()
    if (!contact) return { reachable: false, reason: "That person no longer exists — pick the client again." }
    const who = await describe(contact.email, contact.full_name)
    if (!who.hasLogin) {
      return {
        reachable: false,
        reason: `${contact.full_name ?? "This person"} has no portal login, so they would never see this message. Send it to their company instead, or set up their portal access first.`,
      }
    }
    return { reachable: true, target: { contactId: input.id }, recipients: [who], neverSignedIn: !who.lastSignInAt }
  }

  // ACCOUNT — every member sees a company message (Antonio's routing ruling), so the
  // card should say who "everyone" actually is, and whether any of them has ever
  // logged in.
  const { data: acct } = await db.from("accounts").select("company_name").eq("id", input.id).maybeSingle()
  if (!acct) return { reachable: false, reason: "That company no longer exists — pick the client again." }

  const { data: links } = await db.from("account_contacts").select("contact_id").eq("account_id", input.id)
  const ids = ((links ?? []) as Array<{ contact_id: string | null }>).map((l) => l.contact_id).filter(Boolean)
  if (!ids.length) {
    return {
      reachable: false,
      reason: `${acct.company_name ?? "This company"} has nobody linked to it, so there is no one to receive the message.`,
    }
  }
  const { data: contacts } = await db.from("contacts").select("full_name, email").in("id", ids)
  const recipients = await Promise.all(
    ((contacts ?? []) as Array<{ full_name: string | null; email: string | null }>).map((ct) =>
      describe(ct.email, ct.full_name),
    ),
  )
  if (!recipients.some((r) => r.hasLogin)) {
    return {
      reachable: false,
      reason: `Nobody at ${acct.company_name ?? "this company"} has a portal login, so the message would not be seen.`,
    }
  }
  return {
    reachable: true,
    target: { accountId: input.id },
    recipients,
    neverSignedIn: recipients.every((r) => !r.lastSignInAt),
  }
}
