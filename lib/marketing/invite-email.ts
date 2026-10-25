/**
 * TD Marketing — the invitation email (pure; dev job 9aec66fa). The text of the email a person receives with his one-time link, in English or Italian, as plain text and as HTML, plus the raw MIME
 * message. The person in the CRM sees EXACTLY this before pressing Send. No database and no sending here.
 */
import { escapeHtml } from "@/lib/html-escape"
import type { Lang } from "@/lib/marketing/templates"

export const INVITE_FROM = "support@tonydurante.us"
export const INVITE_FROM_NAME = "Tony Durante LLC"

/** "rocco@x.us" -> "Rocco", "cristina.rossi@x.us" -> "Cristina"; null when the part before the @ does not look like a first name. */
export function firstNameFromEmail(email: string | null | undefined): string | null {
  const local = (email ?? "").split("@")[0] ?? ""
  const m = /^([A-Za-zÀ-ſ]{2,30})(?:[._+\-\d]|$)/.exec(local)
  if (!m) return null
  return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
}

/** The language of a person's CRM record ("Italian" / "English" / "it" / "en"); anything else is Italian (the workspace's own default). */
export function langFromContact(language: string | null | undefined): Lang {
  const v = (language ?? "").trim().toLowerCase()
  if (v.startsWith("en")) return "en"
  return "it"
}

const dateOf = (iso: string, lang: Lang) => new Intl.DateTimeFormat(lang === "it" ? "it-IT" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Rome" }).format(new Date(iso))

export interface InviteEmailInput { lang: Lang; toName: string | null; senderName: string; teamName: string; link: string; expiresAt: string }
export interface InviteEmail { subject: string; text: string; html: string }

/** The subject, the plain text and the HTML. The link is placed as given: the caller builds it from the app's own address (never from user input). */
export function buildInviteEmail(i: InviteEmailInput): InviteEmail {
  const it = i.lang === "it"
  const hello = i.toName ? (it ? `Ciao ${i.toName},` : `Hi ${i.toName},`) : (it ? "Ciao," : "Hi,")
  const subject = it ? "Il tuo accesso a TD Marketing" : "Your access to TD Marketing"
  const intro = it
    ? `${i.senderName} ha preparato il tuo accesso allo spazio di lavoro "${i.teamName}" su TD Marketing. Premi il pulsante, scegli una password e un breve giro guidato ti mostrerà tutto.`
    : `${i.senderName} has set up your access to the "${i.teamName}" workspace on TD Marketing. Press the button, choose a password, and a short guided tour will show you around.`
  const cta = it ? "Apri il mio spazio di lavoro" : "Open my workspace"
  const until = dateOf(i.expiresAt, i.lang)
  const foot = it
    ? `Il link funziona una sola volta ed è valido fino al ${until}. Se smette di funzionare, chiedi un nuovo link a ${i.senderName}.`
    : `The link works once and is valid until ${until}. If it stops working, ask ${i.senderName} for a new one.`
  const text = [hello, "", intro, "", `${cta}: ${i.link}`, "", foot, "", INVITE_FROM_NAME].join("\n")
  const html = `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
  <div style="background: #0f766e; padding: 18px 22px; border-radius: 12px 12px 0 0;"><h1 style="color: #ffffff; margin: 0; font-size: 18px;">TD Marketing</h1></div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>${escapeHtml(hello)}</p>
    <p style="color: #374151;">${escapeHtml(intro)}</p>
    <p style="margin: 22px 0;"><a href="${escapeHtml(i.link)}" style="display: inline-block; padding: 12px 22px; background: #0f766e; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold;">${escapeHtml(cta)}</a></p>
    <p style="color: #6b7280; font-size: 13px;">${escapeHtml(foot)}</p>
    <p style="color: #9ca3af; font-size: 12px; margin-top: 22px;">${escapeHtml(INVITE_FROM_NAME)}</p>
  </div>
</div>`
  return { subject, text, html }
}

/** The finished message for the Gmail API: multipart (plain text + HTML), Subject encoded as RFC 2047 (rule R041), body parts in base64. */
export function buildInviteMime(to: string, mail: InviteEmail, boundary = `td_${Date.now().toString(36)}`): string {
  const encodedSubject = `=?utf-8?B?${Buffer.from(mail.subject).toString("base64")}?=`
  return [
    `From: ${INVITE_FROM_NAME} <${INVITE_FROM}>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.text).toString("base64"),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.html).toString("base64"),
    `--${boundary}--`,
  ].join("\r\n")
}
