/**
 * TD Marketing — the "choose a new password" email (pure; dev job 9aec66fa). Same look and the same MIME builder as the invitation (invite-email.ts). The link is placed as given:
 * the caller builds it from the app's own address (never from user input). No database and no sending here.
 */
import { escapeHtml } from "@/lib/html-escape"
import type { Lang } from "@/lib/marketing/templates"
import { INVITE_FROM_NAME, type InviteEmail } from "@/lib/marketing/invite-email"

const whenOf = (iso: string, lang: Lang) =>
  new Intl.DateTimeFormat(lang === "it" ? "it-IT" : "en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(new Date(iso))

export interface ResetEmailInput { lang: Lang; toName: string | null; link: string; expiresAt: string }

export function buildResetEmail(i: ResetEmailInput): InviteEmail {
  const it = i.lang === "it"
  const hello = i.toName ? (it ? `Ciao ${i.toName},` : `Hi ${i.toName},`) : (it ? "Ciao," : "Hi,")
  const subject = it ? "Scegli una nuova password per TD Marketing" : "Choose a new password for TD Marketing"
  const intro = it
    ? "Hai chiesto di cambiare la password del tuo accesso a TD Marketing. Premi il pulsante e scegline una nuova."
    : "You asked to change the password of your TD Marketing login. Press the button and choose a new one."
  const cta = it ? "Scegli la nuova password" : "Choose a new password"
  const foot = it
    ? `Il link funziona una sola volta ed è valido fino al ${whenOf(i.expiresAt, "it")} (ora di Roma). Se non sei stato tu, ignora questa email: la tua password non cambia.`
    : `The link works once and is valid until ${whenOf(i.expiresAt, "en")} (Rome time). If it was not you, ignore this email: your password does not change.`
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
