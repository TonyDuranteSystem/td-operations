/**
 * Bank application intake — "Send back to the client" (Antonio 2026-11-02: "reviewed, with the option to send it back to the
 * client to fix it if something is wrong").
 *
 * What it does, in order:
 *   1. staff write a NOTE (required);
 *   2. the old application is marked sent back (an atomic claim, so a double click makes one link, not two);
 *   3. a NEW one-time link is made for the same partner, carrying the note;
 *   4. the applicant is emailed the link (English, from support@, note HTML-escaped).
 *
 * The client gets a BLANK form with our note on top and uploads the documents again. Their old answers and documents are
 * never shown back to whoever holds a link (that would hand a passport to anyone with the link and a cookie), and the old
 * application stays on record untouched, so nothing is lost. It works at any time — also AFTER the application was submitted
 * to the bank contact, because the bank may ask for a correction later. If the email fails, the new link is still made and
 * returned so staff can send it by hand.
 */

import { randomBytes } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { bofaLinkUrl } from "./url"
import { escapeHtml } from "./email"
import { sendHtmlEmail } from "./notify"
import { canSendBack, reviewState } from "./review-state"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

export const RETURN_NOTE_MAX = 1500
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

/** PURE: the note staff typed → trimmed text, or an error in words. */
export function cleanReturnNote(raw: unknown): { ok: true; note: string } | { ok: false; error: string } {
  const note = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim() : ""
  if (!note) return { ok: false, error: "Write what the client needs to fix. They see this message." }
  if (note.length > RETURN_NOTE_MAX) return { ok: false, error: `The message is too long (${note.length} characters). Keep it under ${RETURN_NOTE_MAX}.` }
  return { ok: true, note }
}

/** PURE: the email the applicant receives. */
export function buildSendBackEmail(p: { name: string | null; note: string; url: string }): { subject: string; html: string } {
  const first = (p.name ?? "").trim().split(/\s+/)[0]
  return {
    subject: "Please update your bank account application",
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <h2 style="color:#1e3a5f;">Your bank account application needs a correction</h2>
  <p>${first ? `Hello ${escapeHtml(first)},` : "Hello,"}</p>
  <p>We reviewed your bank account application and need one thing fixed before we can continue:</p>
  <blockquote style="margin:12px 0;padding:10px 14px;background:#f5f5f5;border-left:4px solid #1e3a5f;white-space:pre-wrap;">${escapeHtml(p.note)}</blockquote>
  <p>Please open the link below and fill in the application again. Have your documents ready: you will upload them again.</p>
  <p><a href="${escapeHtml(p.url)}" style="display:inline-block;padding:10px 18px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px;">Open your application</a></p>
  <p style="color:#555;font-size:13px;">This link works once, on the device and browser you start it from. For your security the form does not show your earlier answers, so please enter everything again.</p>
  <p style="color:#555;font-size:13px;">Questions? Just reply to this email.</p>
  <p>Tony Durante LLC</p>
</div>`,
  }
}

export type SendBackResult =
  | { ok: true; newId: string; url: string; emailed: boolean; emailedTo: string | null; emailError?: string }
  | { ok: false; error: string }

export async function sendBackToClient(id: string, by: string, rawNote: unknown): Promise<SendBackResult> {
  const cleaned = cleanReturnNote(rawNote)
  if ("error" in cleaned) return { ok: false, error: cleaned.error }

  const { data: row, error: readErr } = await table()
    .select("id, label, partner_name, status, email_status, reviewed_at, returned_at, returned_by, return_note, form_data")
    .eq("id", id)
    .maybeSingle()
  if (readErr || !row) return { ok: false, error: "Application not found." }
  if (reviewState(row) === null) return { ok: false, error: "Only a submitted application can be sent back." }

  // A second send-back is allowed only when the first one's new link was cancelled (nothing is waiting on the client any more).
  if (row.returned_at) {
    const { data: replacements, error: repErr } = await table().select("id, status").eq("replaces_id", id)
    if (repErr) return { ok: false, error: "Could not check the earlier send-back. Please try again." }
    if ((replacements ?? []).some((r: { status: string }) => r.status !== "revoked")) {
      return { ok: false, error: "This application was already sent back. The client has a link waiting." }
    }
  } else if (!canSendBack(row)) {
    return { ok: false, error: "This application cannot be sent back right now." }
  }

  const to = String((row.form_data as Record<string, string> | null)?.email ?? "").trim()
  if (!EMAIL_RE.test(to)) return { ok: false, error: "This application has no valid email address for the client, so it cannot be sent back from here." }

  // 1. claim: only one caller wins, and only against the state we just read
  const now = new Date().toISOString()
  let claim = table()
    .update({ returned_at: now, returned_by: by, return_note: cleaned.note, updated_at: now })
    .eq("id", id)
    .eq("status", "completed")
    // not while a Submit email is going out (a plain "not equal" would also skip rows where email_status is empty)
    .or("email_status.is.null,email_status.neq.sending")
  claim = row.returned_at ? claim.eq("returned_at", row.returned_at) : claim.is("returned_at", null)
  const { data: claimed, error: claimErr } = await claim.select("id").maybeSingle()
  if (claimErr) return { ok: false, error: "Could not send it back. Please try again." }
  if (!claimed) return { ok: false, error: "This application changed while you were writing. Reload the page and try again." }

  // 2. the new one-time link
  const token = randomBytes(24).toString("base64url")
  const { data: created, error: insErr } = await table()
    .insert({
      token,
      label: row.label,
      partner_name: row.partner_name ?? null,
      recipients: [],
      created_by: by,
      replaces_id: id,
      staff_note: cleaned.note,
    })
    .select("id, token")
    .single()
  if (insErr || !created) {
    // put the old application back exactly as it was (including an EARLIER send-back's note and author), so staff can try again
    await table()
      .update({ returned_at: row.returned_at ?? null, returned_by: row.returned_by ?? null, return_note: row.return_note ?? null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("returned_at", now)
    return { ok: false, error: "Could not make the new link. Nothing was changed." }
  }
  const url = bofaLinkUrl(created.token as string)

  // 3. email it to the applicant
  const mail = buildSendBackEmail({ name: (row.form_data as Record<string, string> | null)?.full_name ?? null, note: cleaned.note, url })
  try {
    await sendHtmlEmail({ to: [to], subject: mail.subject, html: mail.html })
    return { ok: true, newId: created.id as string, url, emailed: true, emailedTo: to }
  } catch (e) {
    console.error("[bofa-intake] send-back email failed:", e)
    return { ok: true, newId: created.id as string, url, emailed: false, emailedTo: null, emailError: e instanceof Error ? e.message : "The email could not be sent." }
  }
}
