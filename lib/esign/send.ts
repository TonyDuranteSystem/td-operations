/**
 * E-Sign signer-invite email. TD-first sends through the existing Gmail
 * (support@tonydurante.us); the per-account sender / ESP is a later phase behind
 * this same module. Bilingual EN/IT; subject RFC2047 base64 (R041).
 *
 * `buildSignerInviteEmail` is pure (unit-tested). `sendSignerInvite` wraps it +
 * gmailPost — which is a no-op in sandbox (SANDBOX_MODE blocks outbound email),
 * so the job still completes; real delivery is production-only.
 */

import { gmailPost } from "@/lib/gmail"

export interface SignerInviteParams {
  to: string
  signerName: string
  documentName: string
  signUrl: string
  requesterName: string
  language?: string | null // "it..." → Italian, else English
  /**
   * Open-tracking pixel URL (the same mechanism invoices and offers use). When
   * omitted the email is built exactly as before — tracking is opt-in so the
   * pure builder stays usable without it.
   *
   * WHY: a signer invite is the one client email we could not answer "did it
   * arrive / did they look at it" for. A bounce proves non-delivery; nothing
   * proved the opposite. An open is real evidence; NO open is NOT proof of
   * anything — most mail clients block remote images by default, and Gmail
   * proxies and caches them. Read it as "seen for sure" vs "unknown".
   */
  trackingPixelUrl?: string | null
}

function rfc2047(subject: string): string {
  return `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function buildSignerInviteEmail(p: SignerInviteParams): { to: string; subject: string; raw: string } {
  const it = (p.language || "").toLowerCase().startsWith("it")
  const doc = escapeHtml(p.documentName)
  const who = escapeHtml(p.requesterName)
  const name = escapeHtml(p.signerName)
  const subject = it ? `Richiesta di firma: ${p.documentName}` : `Signature requested: ${p.documentName}`
  const greeting = it ? `Gentile ${name},` : `Hi ${name},`
  const intro = it
    ? `${who} ti ha richiesto di firmare il documento <strong>${doc}</strong>.`
    : `${who} has requested your signature on <strong>${doc}</strong>.`
  const cta = it ? "Visiona e firma" : "Review &amp; Sign"
  const note = it
    ? "Il link è personale: non inoltrarlo."
    : "This link is personal to you — please don't forward it."

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">
  <p>${greeting}</p>
  <p>${intro}</p>
  <p style="margin:26px 0"><a href="${p.signUrl}" style="background:#2563eb;color:#ffffff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600">${cta}</a></p>
  <p style="color:#888;font-size:12px">${note}</p>
  <p style="color:#888;font-size:12px;margin-top:24px">Tony Durante LLC</p>
${p.trackingPixelUrl ? `  <img src="${escapeHtml(p.trackingPixelUrl)}" width="1" height="1" style="display:none" alt="" />` : ""}
</div>`

  const raw = [
    `From: Tony Durante <support@tonydurante.us>`,
    `To: ${p.to}`,
    `Reply-To: support@tonydurante.us`,
    `Subject: ${rfc2047(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    ``,
    html,
  ].join("\r\n")

  return { to: p.to, subject, raw }
}

/** Tracking id for one invite send. Same shape the invoice/offer senders use. */
export function newInviteTrackingId(): string {
  return `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build the pixel URL from the SAME base as the signing link — never
 * `APP_BASE_URL`. A sandbox invite whose pixel points at production would file
 * opens against the wrong deployment (and vice versa), the same class of bug the
 * signing-link base rule exists to prevent.
 */
export function inviteTrackingPixelUrl(baseUrl: string, trackingId: string): string | null {
  const base = (baseUrl || "").replace(/\/+$/, "")
  if (!base || !trackingId) return null
  return `${base}/api/track/open/${trackingId}`
}

export async function sendSignerInvite(
  p: SignerInviteParams,
): Promise<{ subject: string; gmailMessageId: string | null; gmailThreadId: string | null }> {
  const { raw, subject } = buildSignerInviteEmail(p)
  const encoded = Buffer.from(raw).toString("base64url")
  const res = (await gmailPost("/messages/send", { raw: encoded })) as { id?: string; threadId?: string } | undefined
  return { subject, gmailMessageId: res?.id || null, gmailThreadId: res?.threadId || null }
}
