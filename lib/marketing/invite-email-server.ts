/**
 * TD Marketing — preview and send an invitation by email (dev job 9aec66fa). The CRM person who just made an invitation link can have the system email it to the invited person: first he SEES
 * the exact email (preview), then he presses Send. The recipient is always the email the invitation was made for (never typed here), the link is rebuilt from the app's own address and the
 * token the caller holds (checked against the stored hash), and an invitation is emailed once (a new link = a new email). Sent through the shared send rule (safeSend: send first, mark after).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { gmailPost } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import { GENERIC_INVITE_ERROR, hashInviteToken, inviteUsable, plausibleToken } from "@/lib/marketing/invite-rules"
import { INVITE_FROM, buildInviteEmail, buildInviteMime, firstNameFromEmail, langFromContact } from "@/lib/marketing/invite-email"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

/** Who may email which invitation: `teamId` set = only invitations of that team; `allowOwnerInvite` = may also email an invitation for a team owner (Antonio only). */
export interface InviteEmailScope { teamId: string | null; allowOwnerInvite: boolean; actorLabel: string }

export interface InviteEmailPreview { to: string; from: string; subject: string; html: string; lang: "en" | "it"; alreadyEmailedAt: string | null }
type Res<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

interface Prepared { invite: { id: string; email_lower: string; team_id: string; expires_at: string; created_by: string | null; emailed_at?: string | null }; to: string; mail: ReturnType<typeof buildInviteEmail>; lang: "en" | "it" }

async function prepare(token: unknown, scope: InviteEmailScope, langOverride?: unknown): Promise<Res<Prepared>> {
  if (!plausibleToken(token)) return { ok: false, error: GENERIC_INVITE_ERROR, status: 400 }
  const { data: inv } = await db().from("marketing_invites").select("*").eq("token_hash", hashInviteToken(token)).maybeSingle()
  if (!inv || !inviteUsable(inv, new Date())) return { ok: false, error: "This invitation is no longer open. Make a new link.", status: 400 }
  if (scope.teamId && inv.team_id !== scope.teamId) return { ok: false, error: GENERIC_INVITE_ERROR, status: 400 }
  if (inv.member_role === "owner" && !scope.allowOwnerInvite) return { ok: false, error: "Only Antonio can send an owner's invitation.", status: 403 }
  const { data: team } = await db().from("marketing_teams").select("name").eq("id", inv.team_id).maybeSingle()
  // The CRM contact (first name, language) is looked up ONLY for Antonio's own scope: showing a team manager "Hi Giovanni" for an address would tell him that address is a TD client.
  // An address with a wildcard character is never looked up (PostgREST reads * % _ in ilike as patterns). R109: look it up, never ask.
  let contact: { first_name?: string | null; language?: string | null } | null = null
  if (scope.allowOwnerInvite && !/[*%_\\]/.test(String(inv.email_lower))) {
    const r = await db().from("contacts").select("first_name, language").ilike("email", inv.email_lower).limit(1).maybeSingle()
    contact = r.data ?? null
  }
  const lang: "en" | "it" = langOverride === "en" || langOverride === "it" ? langOverride : langFromContact(contact?.language)
  const sender = firstNameFromEmail(inv.created_by) ?? "Antonio"
  const mail = buildInviteEmail({
    lang, toName: (contact?.first_name as string | undefined)?.trim() || firstNameFromEmail(inv.email_lower), senderName: sender,
    teamName: team?.name ?? "TD Marketing", link: `${APP_BASE_URL}/marketing/accept?token=${token}`, expiresAt: inv.expires_at,
  })
  return { ok: true, data: { invite: inv, to: inv.email_lower, mail, lang } }
}

/** The exact email, without sending anything. */
export async function previewInviteEmail(token: unknown, scope: InviteEmailScope, wantLang?: unknown): Promise<Res<InviteEmailPreview>> {
  const p = await prepare(token, scope, wantLang)
  if (p.ok === false) return p
  const { invite, to, mail, lang } = p.data
  return { ok: true, data: { to, from: INVITE_FROM, subject: mail.subject, html: mail.html, lang, alreadyEmailedAt: invite.emailed_at ?? null } }
}

/**
 * Email the invitation (once). The invitation is CLAIMED first with one conditional update (emailed_at is null -> now): of two people pressing Send together only one wins the claim and sends;
 * if the send then fails the claim is released so it can be tried again. When the database cannot claim (the migration with the emailed_at column is not on it yet) NOTHING is sent.
 */
export async function sendInviteEmail(token: unknown, scope: InviteEmailScope, wantLang?: unknown): Promise<Res<{ to: string; sentAt: string }>> {
  const p = await prepare(token, scope, wantLang)
  if (p.ok === false) return p
  const { invite, to, mail } = p.data
  const sentAt = new Date().toISOString()
  // give the claim back when the send did not go out; returns false when even that could not be saved (then the invitation would wrongly show as emailed)
  const release = async (): Promise<boolean> => {
    for (let k = 0; k < 2; k++) {
      const { error } = await db().from("marketing_invites").update({ emailed_at: null, emailed_by: null }).eq("id", invite.id)
      if (!error) return true
    }
    return false
  }
  try {
    const r = await safeSend({
      idempotencyCheck: async () => {
        const { data, error } = await db().from("marketing_invites").update({ emailed_at: sentAt, emailed_by: scope.actorLabel }).eq("id", invite.id).is("emailed_at", null).is("used_at", null).is("revoked_at", null).select("id")
        if (error) throw new Error(`cannot claim: ${error.message}`)
        return Array.isArray(data) && data.length === 1 ? null : { alreadySent: true as const, message: "This invitation was already emailed. Make a new link to send it again." }
      },
      sendFn: async () => gmailPost("/messages/send", { raw: Buffer.from(buildInviteMime(to, mail)).toString("base64url") }),
      postSendSteps: [],
    })
    if (r.alreadySent) return { ok: false, error: r.idempotencyMessage ?? "Already emailed.", status: 409 }
    return { ok: true, data: { to, sentAt } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[marketing] invitation email failed:", msg)
    if (msg.startsWith("cannot claim")) return { ok: false, error: "Sending by email is not ready yet (a database step is pending). Copy the link and send it yourself for now.", status: 503 }
    // the send did not go out: let it be tried again
    if (!(await release().catch(() => false))) {
      return { ok: false, error: "The email could not be sent, and this invitation may now show as emailed although nothing was sent. Make a new link and copy it, or send the new one.", status: 502 }
    }
    return { ok: false, error: "The email could not be sent. Nothing was sent; try again, or copy the link.", status: 502 }
  }
}
