/**
 * The emails of the "client changes their login email" flow (dev job beb43385, step 2).
 *
 *   1. To the NEW address, with the 6-digit code.
 *   2. To the OLD address, after the change, with the red "This wasn't me" button.
 *
 * The builders are pure (no network) so the wording and the link placement are unit-tested.
 * Same sender, same MIME shape and same RFC 2047 subject as every other portal email
 * (lib/portal/password-reset.ts). Both client emails go out in the client's own language.
 */
import type { Locale } from "@/lib/locale"
import { formatCodeForEmail, LOGIN_EMAIL_CHANGE } from "@/lib/portal/login-email-change"

export interface BuiltEmail {
  subject: string
  html: string
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const WRAP = 'font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#3f3f46'
const MUTED = "font-size:13px;color:#71717a"
const FOOT = "font-size:13px;color:#a1a1aa"

function greeting(fullName: string | null, locale: Locale): string {
  const name = (fullName ?? "").trim()
  if (locale === "it") return name ? `Ciao ${esc(name)},` : "Ciao,"
  return `Hi ${name ? esc(name) : "there"},`
}

/** "18 Nov 2026" / "18 novembre 2026", in New York time (the firm's day). */
export function formatChangeDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: locale === "it" ? "long" : "short",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(date)
}

/** Email 1 — to the NEW address, with the code. */
export function buildChangeCodeEmail(params: {
  fullName: string | null
  locale: Locale
  newEmail: string
  code: string
}): BuiltEmail {
  const { fullName, locale, newEmail, code } = params
  const minutes = Math.round(LOGIN_EMAIL_CHANGE.codeTtlMs / 60000)
  const big = `<p style="font-size:28px;font-weight:700;letter-spacing:.12em;margin:14px 0">${esc(formatCodeForEmail(code))}</p>`
  if (locale === "it") {
    return {
      subject: "Il tuo codice per confermare la nuova email di accesso",
      html: `<div style="${WRAP}">
<p>${greeting(fullName, locale)}</p>
<p>Usa questo codice nel portale clienti per confermare che <strong>${esc(newEmail)}</strong> è la tua nuova email di accesso:</p>
${big}
<p>Il codice vale ${minutes} minuti. Se non l'hai richiesto tu, ignora questa email: non cambierà nulla.</p>
<p style="${FOOT}">Tony Durante LLC</p></div>`,
    }
  }
  return {
    subject: "Your code to confirm your new login email",
    html: `<div style="${WRAP}">
<p>${greeting(fullName, locale)}</p>
<p>Use this code in the client portal to confirm that <strong>${esc(newEmail)}</strong> is your new login email:</p>
${big}
<p>The code works for ${minutes} minutes. If you did not ask for this, ignore this email. Nothing will change.</p>
<p style="${FOOT}">Tony Durante LLC</p></div>`,
  }
}

/** Email 2 — to the OLD address, after the change, with the red button. */
export function buildChangedNoticeEmail(params: {
  fullName: string | null
  locale: Locale
  oldEmail: string
  newEmail: string
  changedAt: Date
  undoUrl: string
}): BuiltEmail {
  const { fullName, locale, oldEmail, newEmail, changedAt, undoUrl } = params
  const days = Math.round(LOGIN_EMAIL_CHANGE.undoTtlMs / (24 * 60 * 60 * 1000))
  const when = formatChangeDate(changedAt, locale)
  const button = (label: string) =>
    `<p><a href="${esc(undoUrl)}" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${label}</a></p>`
  if (locale === "it") {
    return {
      subject: "L'email di accesso al tuo portale è stata cambiata",
      html: `<div style="${WRAP}">
<p>${greeting(fullName, locale)}</p>
<p>Il ${esc(when)} l'email di accesso al tuo portale clienti Tony Durante è stata cambiata da <strong>${esc(oldEmail)}</strong> a <strong>${esc(newEmail)}</strong>. La password non è cambiata.</p>
<p>Se sei stato tu, non devi fare nulla.</p>
<p><strong>Se non sei stato tu</strong>, premi subito il pulsante. Rimette la tua vecchia email e ti fa scegliere una nuova password.</p>
${button("Non sono stato io")}
<p style="${MUTED}">Il pulsante funziona per ${days} giorni. Puoi anche scrivere a support@tonydurante.us.</p>
<p style="${FOOT}">Tony Durante LLC</p></div>`,
    }
  }
  return {
    subject: "Your portal login email was changed",
    html: `<div style="${WRAP}">
<p>${greeting(fullName, locale)}</p>
<p>On ${esc(when)} the login email for your Tony Durante client portal was changed from <strong>${esc(oldEmail)}</strong> to <strong>${esc(newEmail)}</strong>. Your password has not changed.</p>
<p>If this was you, there is nothing to do.</p>
<p><strong>If it was not you</strong>, press the button now. It puts your old email back and lets you choose a new password.</p>
${button("This wasn't me")}
<p style="${MUTED}">The button works for ${days} days. You can also write to support@tonydurante.us.</p>
<p style="${FOOT}">Tony Durante LLC</p></div>`,
  }
}

/**
 * Send through OUR Gmail, like every other client email. Returns "sandbox_blocked" (not "sent")
 * when SANDBOX_MODE turns the send into a no-op, so an audit row never claims a mail left the
 * building when it did not. Never throws.
 */
export async function sendLoginEmailChangeMail(params: {
  to: string
  email: BuiltEmail
}): Promise<"sent" | "sandbox_blocked" | "send_failed"> {
  const { to, email } = params
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const encodedSubject = `=?utf-8?B?${Buffer.from(email.subject).toString("base64")}?=`
    const boundary = `boundary_${Buffer.from(to).toString("hex").slice(0, 12)}`
    const raw = [
      "From: Tony Durante <support@tonydurante.us>",
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(email.html).toString("base64"),
      `--${boundary}--`,
    ].join("\r\n")
    const res = (await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })) as { sandbox?: boolean } | null
    return res?.sandbox ? "sandbox_blocked" : "sent"
  } catch (err) {
    console.error("[login-email-change] mail send failed:", err)
    return "send_failed"
  }
}
