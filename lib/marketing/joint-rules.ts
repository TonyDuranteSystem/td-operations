/**
 * TD Marketing — the rules of the booking link WITH the owner (pure; dev job 0b916784, 1 Nov 2026). A link is single-use in the sense that it books ONE call: before booking it shows the free times, after
 * booking it is the page where the client cancels or moves that call. Only the HASH of the token is stored (invite-rules.ts makes and hashes it). Every refusal the client can see is ONE generic message,
 * so a link can never be used to learn anything about a lead. No database and no network here.
 */
import { INVITE_TTL_MS } from "@/lib/marketing/invite-rules"
import { INVITE_FROM, INVITE_FROM_NAME } from "@/lib/marketing/invite-email"

export type JointLang = "it" | "en"
export const JOINT_TTL_MS = INVITE_TTL_MS
export const JOINT_CALL_MINUTES_FALLBACK = 30
export const GENERIC_LINK_ERROR = "This link cannot be used any more. Ask the person who sent it for a new one."
export const TIME_TAKEN_ERROR = "That time was just taken. Please choose another one."
export const GENERIC_LINK_ERROR_IT = "Questo link non è più valido. Chiedi un nuovo link a chi te lo ha inviato."
export const TIME_TAKEN_ERROR_IT = "Quell'orario è stato appena occupato. Scegline un altro."

/** Italian for a lead with an Italian number or country; English for everybody else. The client can switch on the page. */
export function pickJointLang(lead: { phone?: string | null; country?: string | null }): JointLang {
  const phone = (lead.phone ?? "").replace(/[\s().-]/g, "")
  if (/^(\+39|0039)/.test(phone)) return "it"
  const c = (lead.country ?? "").trim().toLowerCase()
  return c === "it" || c === "italy" || c === "italia" ? "it" : "en"
}

export interface LinkRow {
  status: "open" | "booking" | "booked" | "cancelled" | "failed"
  expires_at: string
  revoked_at: string | null
  starts_at: string | null
}
export type LinkState = "open" | "booked" | "cancelled" | "unusable"

/** What the page should show for a link: the free times (open), the booked call (booked), a cancelled call, or the generic "cannot be used". A call already in the past is no longer manageable. */
export function linkState(row: LinkRow | null | undefined, nowMs: number): LinkState {
  if (!row || row.revoked_at) return "unusable"
  if (row.status === "booked") return row.starts_at && Date.parse(row.starts_at) > nowMs ? "booked" : "unusable"
  if (row.status === "cancelled") return "cancelled"
  if (row.status === "open" || row.status === "failed") return Date.parse(row.expires_at) > nowMs ? "open" : "unusable"
  return "unusable" // "booking": being finished by somebody else right now
}

/** The range that is held for a call: the call itself with the gap kept around it (ms). */
export function lockRange(startMs: number, minutes: number, gapMin: number): { startMs: number; endMs: number; fromMs: number; toMs: number } {
  const endMs = startMs + minutes * 60_000
  return { startMs, endMs, fromMs: startMs - gapMin * 60_000, toMs: endMs + gapMin * 60_000 }
}

/** The exclusion constraint's answer for two holds on the same time. */
export const isOverlapViolation = (err: { code?: string; message?: string } | null | undefined): boolean =>
  !!err && (err.code === "23P01" || /marketing_joint_links_no_overlap|conflicting key value violates exclusion/i.test(err.message ?? ""))

const firstWord = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0]?.slice(0, 40) || "Lead"

export function eventTitle(leadName: string | null | undefined): string { return `${firstWord(leadName)} · Call with Antonio` }
export function eventDescription(i: { joinUrl: string; manageUrl: string; sellerLabel: string; clientName: string }): string {
  return [`Zoom: ${i.joinUrl}`, `Booked by ${i.clientName} through the booking link of ${i.sellerLabel}.`, `The client can cancel or move the call here: ${i.manageUrl}`].join("\n")
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export interface JointMail { subject: string; text: string; html: string }
export type JointMailKind = "booked" | "moved" | "cancelled"

/** The confirmation the client gets, in the language of the link: the time in the client's own zone, the Zoom link (not for a cancellation) and the page to cancel or move. */
export function buildJointMail(i: { kind: JointMailKind; lang: JointLang; name: string; whenText: string; zoneText: string; joinUrl: string | null; manageUrl: string }): JointMail {
  const it = i.lang === "it"
  const first = firstWord(i.name)
  const subject = i.kind === "cancelled" ? (it ? "Chiamata annullata" : "Call cancelled") : i.kind === "moved" ? (it ? "Chiamata spostata" : "Call moved") : (it ? "Chiamata confermata con Antonio Durante" : "Your call with Antonio Durante is confirmed")
  const intro = i.kind === "cancelled"
    ? (it ? "La chiamata è stata annullata. Se hai ancora bisogno di parlarci, chiedi un nuovo link a chi te lo ha inviato." : "The call was cancelled. If you still need to talk, ask the person who sent you the link for a new one.")
    : i.kind === "moved"
      ? (it ? "La chiamata è stata spostata. Il link Zoom resta lo stesso." : "Your call was moved. The Zoom link stays the same.")
      : (it ? "La tua chiamata è confermata." : "Your call is confirmed.")
  const when = `${i.whenText} (${i.zoneText})`
  const lines = [it ? `Ciao ${first},` : `Hi ${first},`, "", intro, ""]
  if (i.kind !== "cancelled") lines.push(`${it ? "Quando" : "When"}: ${when}`, `Zoom: ${i.joinUrl ?? ""}`, ...(i.manageUrl ? ["", `${it ? "Per annullare o cambiare orario" : "To cancel or change the time"}: ${i.manageUrl}`] : []), "")
  lines.push(INVITE_FROM_NAME)
  const text = lines.join("\n")
  const button = i.kind === "cancelled" ? "" : `<p style="margin:22px 0;"><a href="${esc(i.joinUrl ?? "")}" style="display:inline-block;padding:12px 22px;background:#b32236;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">${it ? "Entra su Zoom" : "Join on Zoom"}</a></p>`
  const manage = i.kind === "cancelled" || !i.manageUrl ? "" : `<p style="color:#6b7280;font-size:13px;">${it ? "Per annullare o cambiare orario" : "To cancel or change the time"}: <a href="${esc(i.manageUrl)}">${esc(i.manageUrl)}</a></p>`
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
  <div style="border:1px solid #e5e7eb;padding:24px;border-radius:12px;">
    <p>${esc(it ? `Ciao ${first},` : `Hi ${first},`)}</p>
    <p style="color:#374151;">${esc(intro)}</p>
    ${i.kind === "cancelled" ? "" : `<p><strong>${esc(when)}</strong></p>`}
    ${button}${manage}
    <p style="color:#9ca3af;font-size:12px;margin-top:22px;">${esc(INVITE_FROM_NAME)}</p>
  </div>
</div>`
  return { subject, text, html }
}

/** The message for the Gmail API: multipart text + HTML, Subject encoded as RFC 2047 (rule R041), From the company's support address. The recipient is a client-typed address: refused when it holds a line break. */
export function buildJointMime(to: string, mail: JointMail, boundary = `td_${Date.now().toString(36)}`): string {
  if (!/^[^\s<>\r\n]+$/.test(to)) throw new Error("The email address is not valid.")
  const encodedSubject = `=?utf-8?B?${Buffer.from(mail.subject).toString("base64")}?=`
  return [
    `From: ${INVITE_FROM_NAME} <${INVITE_FROM}>`, `To: ${to}`, `Subject: ${encodedSubject}`, "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(mail.text).toString("base64"),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(mail.html).toString("base64"),
    `--${boundary}--`, "",
  ].join("\r\n")
}
