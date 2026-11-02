/**
 * TD Marketing — preview and send a password-reset link by email (dev job 9aec66fa). Antonio just made a reset link for a person on the admin Teams page: first he SEES the exact email (preview),
 * then he presses Send. The recipient is always the address of the login the link was made for (never typed here), the link is rebuilt from the app's own address and the token the caller
 * holds (checked against the stored hash), and only a link made on the Teams page (not a person's own "Forgot password?" link) can be emailed from here. Sent through the shared send rule
 * (safeSend). There is no "emailed" mark on the link (that would need a database column): pressing Send twice sends the same valid link twice, which is harmless, and the panel shows "Sent".
 * SERVER-ONLY.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { gmailPost } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import { hashInviteToken, inviteUsable, normalizeEmail, plausibleToken } from "@/lib/marketing/invite-rules"
import { GENERIC_RESET_ERROR, resetUrl } from "@/lib/marketing/reset-rules"
import { buildResetEmail } from "@/lib/marketing/reset-email"
import { INVITE_FROM, buildInviteMime, firstNameFromEmail, langFromContact } from "@/lib/marketing/invite-email"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

export interface ResetEmailPreview { to: string; from: string; replyTo: string | null; subject: string; html: string; lang: "en" | "it" }
type Res<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

const NO_LONGER_OPEN = "This link is no longer open. Make a new one."

async function prepare(token: unknown, actorLabel: string, langOverride?: unknown): Promise<Res<{ to: string; mail: ReturnType<typeof buildResetEmail>; lang: "en" | "it"; replyTo: string | null }>> {
  if (!plausibleToken(token)) return { ok: false, error: GENERIC_RESET_ERROR, status: 400 }
  const { data: row, error } = await db().from("marketing_password_resets").select("*").eq("token_hash", hashInviteToken(token)).maybeSingle()
  if (error) return { ok: false, error: "Could not read the link. Please try again.", status: 502 }
  if (!row || !inviteUsable(row, new Date())) return { ok: false, error: NO_LONGER_OPEN, status: 400 }
  if (row.requested_by === "self") return { ok: false, error: "This link was asked for by the person himself; it is not emailed from here.", status: 400 }
  const to = normalizeEmail(row.email_lower)
  if (!to) return { ok: false, error: "This login has no email address.", status: 400 }
  // The CRM contact (first name, language) is looked up for Antonio's own scope. An address with a wildcard character is never looked up (PostgREST reads * % _ in ilike as patterns). R109.
  let contact: { first_name?: string | null; language?: string | null } | null = null
  if (!/[*%_\\]/.test(to)) {
    const r = await db().from("contacts").select("first_name, language").ilike("email", to).limit(1).maybeSingle()
    contact = r?.data ?? null
  }
  const lang: "en" | "it" = langOverride === "en" || langOverride === "it" ? langOverride : langFromContact(contact?.language)
  const maker = normalizeEmail(actorLabel)
  const mail = buildResetEmail({
    lang, kind: "owner", senderName: firstNameFromEmail(actorLabel) ?? "Antonio",
    toName: (contact?.first_name as string | undefined)?.trim() || firstNameFromEmail(to), link: resetUrl(APP_BASE_URL, token), expiresAt: row.expires_at,
  })
  // answers go to whoever made the link (his login email), unless that is the recipient himself
  return { ok: true, data: { to, mail, lang, replyTo: maker && maker !== to ? maker : null } }
}

/** The exact email, without sending anything. */
export async function previewResetEmail(token: unknown, actorLabel: string, wantLang?: unknown): Promise<Res<ResetEmailPreview>> {
  const p = await prepare(token, actorLabel, wantLang)
  if (p.ok === false) return p
  const { to, mail, lang, replyTo } = p.data
  return { ok: true, data: { to, from: INVITE_FROM, replyTo, subject: mail.subject, html: mail.html, lang } }
}

/** Email the link. When the send does not go out nothing is marked and it can be tried again. */
export async function sendResetEmail(token: unknown, actorLabel: string, wantLang?: unknown): Promise<Res<{ to: string; from: string; sentAt: string }>> {
  const p = await prepare(token, actorLabel, wantLang)
  if (p.ok === false) return p
  const { to, mail, replyTo } = p.data
  try {
    const r = await safeSend({
      idempotencyCheck: async () => null,
      sendFn: async () => gmailPost("/messages/send", { raw: Buffer.from(buildInviteMime(to, mail, undefined, replyTo)).toString("base64url") }),
      postSendSteps: [],
    })
    if (r.alreadySent) return { ok: false, error: r.idempotencyMessage ?? "Already emailed.", status: 409 }
    return { ok: true, data: { to, from: INVITE_FROM, sentAt: new Date().toISOString() } }
  } catch (e) {
    console.error("[marketing] reset link email failed:", e instanceof Error ? e.message : String(e))
    return { ok: false, error: "The email could not be sent. Nothing was sent; try again, or copy the link.", status: 502 }
  }
}
