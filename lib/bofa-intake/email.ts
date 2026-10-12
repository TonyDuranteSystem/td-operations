/**
 * Bank application intake — the email that carries a SUBMITTED application to the addresses staff
 * chose when the link was made. Pure builders (no network): the HTML body, the subject, and the MIME.
 *
 * Deliberately NOT in the email: the partner's name, the staff link/CRM address, or anything that
 * says who sent the client to us — the recipient gets the application and nothing about our side.
 */

import { BOFA_TEXT_FIELDS } from "./schema"

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

/** Total raw size we are willing to attach; above it the email carries 7-day download links instead. */
export const BOFA_MAX_ATTACH_BYTES = 18 * 1024 * 1024

export interface DeliveryFile {
  label: string
  name: string
  /** Set when the file is attached. */
  content?: Buffer
  contentType?: string
  /** Set when the file is sent as a link (too big to attach). */
  url?: string
}

export function buildSubject(data: Record<string, string>): string {
  const who = data.full_name || "Applicant"
  const company = data.company_name ? ` — ${data.company_name}` : ""
  return `Bank account application: ${who}${company}`
}

function rows(keys: string[], data: Record<string, string>): string {
  return keys
    .map((k) => {
      const f = BOFA_TEXT_FIELDS.find((x) => x.key === k)
      if (!f) return ""
      const v = data[k]
      if (!v) return ""
      return `<tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold;vertical-align:top;width:230px;">${escapeHtml(f.label)}</td><td style="padding:6px 12px;white-space:pre-wrap;">${escapeHtml(v)}</td></tr>`
    })
    .join("")
}

export function buildDeliveryHtml(data: Record<string, string>, files: DeliveryFile[]): string {
  const person = ["full_name", "email", "phone", "citizenship", "itin", "home_street", "home_city", "home_region", "home_zip", "home_country"]
  const company = ["company_name", "ein", "state_of_formation", "company_street", "company_city", "company_region", "company_zip", "company_country", "website"]
  const business = ["business_description", "customers", "revenue_model", "monthly_deposits", "first_deposit_source"]
  const table = (keys: string[]) => `<table style="border-collapse:collapse;width:100%;margin:8px 0 18px;">${rows(keys, data)}</table>`
  const attached = files.filter((f) => f.content)
  const linked = files.filter((f) => f.url)
  const docs = [
    attached.length ? `<p>Attached (${attached.length}): ${attached.map((f) => escapeHtml(`${f.label} — ${f.name}`)).join("; ")}.</p>` : "",
    linked.length
      ? `<p>The files are too large to attach, so each one is a download link that works for 7 days:</p><ul>${linked
          .map((f) => `<li>${escapeHtml(f.label)}: <a href="${escapeHtml(f.url as string)}">${escapeHtml(f.name)}</a></li>`)
          .join("")}</ul>`
      : "",
  ].join("")
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#111;">
  <h2 style="color:#1e3a5f;">Bank account application</h2>
  <p>A completed application. The applicant's details, a description of the business, and the documents are below.</p>
  <h3 style="color:#1e3a5f;margin-bottom:0;">Applicant</h3>${table(person)}
  <h3 style="color:#1e3a5f;margin-bottom:0;">Company</h3>${table(company)}
  <h3 style="color:#1e3a5f;margin-bottom:0;">The business</h3>${table(business)}
  <h3 style="color:#1e3a5f;margin-bottom:0;">Documents</h3>${docs}
</div>`
}

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n")
}

/** RFC 2047 base64 for any header that may carry non-ASCII (R041). */
export function encodeHeader(value: string): string {
  return `=?utf-8?B?${Buffer.from(value).toString("base64")}?=`
}

export function safeAttachmentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 120) || "file"
}

export function buildMime(opts: { to: string[]; subject: string; html: string; files: DeliveryFile[] }): string {
  const boundary = `bofa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const head = [
    "From: Tony Durante LLC <support@tonydurante.us>",
    `To: ${opts.to.join(", ")}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
  ]
  const body = [
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(opts.html).toString("base64")),
  ]
  for (const f of opts.files.filter((x) => x.content)) {
    const name = safeAttachmentName(f.name)
    body.push(
      `--${boundary}`,
      `Content-Type: ${f.contentType || "application/octet-stream"}; name="${encodeHeader(name)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodeHeader(name)}"`,
      "",
      wrap76((f.content as Buffer).toString("base64")),
    )
  }
  body.push(`--${boundary}--`, "")
  return [...head, ...body].join("\r\n")
}
