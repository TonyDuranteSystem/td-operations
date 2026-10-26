/**
 * TD Marketing — writing an email from the Inbox (pure; dev job 9aec66fa). Turns what the person typed into the finished message Gmail sends: recipients checked one by one (no line break can enter a
 * header), the formatted body cleaned by the same allow-list the CRM reply uses, a plain-text twin made FROM that cleaned body, the sender's signature, the quoted original for a reply or forward,
 * attachments with safe names, and a Subject encoded as RFC 2047 (rule R041). No database and no Gmail here.
 */
import { escapeHtml } from "@/lib/inbox/email-quote"
import { resolveReplyBody } from "@/lib/inbox/rich-text-sanitize"
import { DEFAULT_RICH_STYLE, richBodyOpenTag } from "@/lib/inbox/rich-text"
import { normalizeEmail } from "@/lib/marketing/invite-rules"
import type { OutgoingFile } from "@/lib/marketing/inbox/mail-types"

export const MAX_RECIPIENTS = 20
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024
export const MAX_SUBJECT = 300

export type ComposeMode = "new" | "reply" | "replyAll" | "forward"

export interface ComposeInput {
  from: string
  fromName?: string
  to: unknown
  cc?: unknown
  bcc?: unknown
  subject: unknown
  /** what the editor produced (HTML) and/or the plain text */
  messageHtml?: unknown
  message?: unknown
  style?: unknown
  signature?: string
  /** a reply / forward: the headers of the message answered and its quoted text */
  inReplyTo?: string
  references?: string
  quote?: { from: string; date: string; text: string } | null
  attachments?: OutgoingFile[]
  /** a draft may be saved without a recipient or a body */
  draft?: boolean
  boundary?: string
}

export type Composed = { ok: true; raw: string; text: string } | { ok: false; error: string }

/** Split on commas/semicolons that are outside quotes and <angle brackets>, so "Doe, John" <j@x.com> stays one piece. */
function splitAddresses(v: string): string[] {
  const out: string[] = []
  let cur = "", q = false, ang = false
  for (const ch of v) {
    if (ch === '"') q = !q
    else if (!q && ch === "<") ang = true
    else if (!q && ch === ">") ang = false
    if ((ch === "," || ch === ";") && !q && !ang) { out.push(cur); cur = "" } else cur += ch
  }
  out.push(cur)
  return out
}

/** "a@x.com, B <b@x.com>; c@x.com" -> the clean addresses, or an error naming the first bad one. */
export function parseRecipients(value: unknown): { ok: true; list: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, list: [] }
  const parts = Array.isArray(value) ? value.map(String) : splitAddresses(String(value))
  const list: string[] = []
  for (const p of parts) {
    const raw = p.trim()
    if (!raw) continue
    const angle = raw.match(/<([^<>]+)>\s*$/)
    const addr = normalizeEmail(angle ? angle[1] : raw)
    if (!addr) return { ok: false, error: `"${raw.slice(0, 60)}" does not look like an email address.` }
    if (!list.includes(addr)) list.push(addr)
  }
  return { ok: true, list }
}

/** The text a Message-ID / References header may carry: only <...> tokens, nothing that could end the header line. */
export function cleanMessageIds(value: string | undefined): string {
  return (value ?? "").match(/<[^<>\s\r\n]{1,200}>/g)?.slice(-20).join(" ") ?? ""
}

const safeFilename = (name: string): string => {
  const base = name.replace(/[\r\n"\\/<>:|?*\u0000-\u001f]/g, "_").trim().slice(0, 120) || "attachment"
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(base) ? base : `=?utf-8?B?${Buffer.from(base, "utf-8").toString("base64")}?=`
}

const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n")
const textToHtml = (t: string) => escapeHtml(t).replace(/\r?\n/g, "<br />")

function quoteBlocks(q: NonNullable<ComposeInput["quote"]>): { plain: string; html: string } {
  const when = q.date ? new Date(q.date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : ""
  const attribution = `On ${when}, ${q.from} wrote:`
  const body = q.text.slice(0, 10_000)
  return {
    plain: `\r\n\r\n${attribution}\r\n${body.split("\n").map(l => `> ${l}`).join("\r\n")}`,
    html: `<div class="gmail_quote" style="margin-top:16px"><div style="color:#5f6368">${escapeHtml(attribution)}</div><blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368">${textToHtml(body)}</blockquote></div>`,
  }
}

export function composeMessage(input: ComposeInput): Composed {
  const to = parseRecipients(input.to); if (to.ok === false) return to
  const cc = parseRecipients(input.cc); if (cc.ok === false) return cc
  const bcc = parseRecipients(input.bcc); if (bcc.ok === false) return bcc
  if (!input.draft && to.list.length === 0) return { ok: false, error: "Add at least one recipient." }
  if (to.list.length + cc.list.length + bcc.list.length > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients in one email.` }

  const subject = (typeof input.subject === "string" ? input.subject : "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUBJECT)
  if (!input.draft && !subject) return { ok: false, error: "Write a subject." }

  const body = resolveReplyBody({ message: input.message, messageHtml: input.messageHtml, style: input.style })
  if (body.ok === false) return { ok: false, error: body.error }
  const text = body.text
  if (!input.draft && !text.trim()) return { ok: false, error: "The message is empty." }

  const files = input.attachments ?? []
  const total = files.reduce((n, f) => n + Math.floor(f.content.length * 0.75), 0)
  if (total > MAX_ATTACHMENT_BYTES) return { ok: false, error: "The attachments are too big. Keep them under 18 MB together." }

  const signature = (input.signature ?? "").trim()
  const sigText = signature ? `\r\n\r\n-- \r\n${signature}` : ""
  const sigHtml = signature ? `<div style="margin-top:14px;color:#5f6368">-- <br />${textToHtml(signature)}</div>` : ""
  const quote = input.quote ? quoteBlocks(input.quote) : { plain: "", html: "" }

  const messageHtml = body.rich ? `${richBodyOpenTag(body.rich.style ?? DEFAULT_RICH_STYLE)}${body.rich.html}</div>` : textToHtml(text)
  const html = `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${messageHtml}${sigHtml}</div>${quote.html}`

  const boundary = input.boundary ?? `td_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const mixed = `${boundary}_mixed`
  const fromHeader = input.fromName && /^[\w .'-]{1,60}$/.test(input.fromName) ? `${input.fromName} <${input.from}>` : input.from
  const inReplyTo = cleanMessageIds(input.inReplyTo).split(" ").pop() ?? ""
  const references = cleanMessageIds(`${input.references ?? ""} ${inReplyTo}`)

  const headers = [
    `From: ${fromHeader}`,
    ...(to.list.length ? [`To: ${to.list.join(", ")}`] : []),
    ...(cc.list.length ? [`Cc: ${cc.list.join(", ")}`] : []),
    ...(bcc.list.length ? [`Bcc: ${bcc.list.join(", ")}`] : []),
    `Subject: =?utf-8?B?${Buffer.from(subject).toString("base64")}?=`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, ...(references ? [`References: ${references}`] : [])] : []),
    "MIME-Version: 1.0",
    `Content-Type: ${files.length ? `multipart/mixed; boundary="${mixed}"` : `multipart/alternative; boundary="${boundary}"`}`,
  ]
  const alternative =
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(text + sigText + quote.plain, "utf-8").toString("base64"))}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(html, "utf-8").toString("base64"))}\r\n` +
    `--${boundary}--`

  let mime: string
  if (!files.length) mime = `${headers.join("\r\n")}\r\n\r\n${alternative}`
  else {
    const parts = files.map(f => {
      const ct = /^[\w.+-]+\/[\w.+-]+$/.test(f.contentType) ? f.contentType : "application/octet-stream"
      const name = safeFilename(f.filename)
      return `--${mixed}\r\nContent-Type: ${ct}; name="${name}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${name}"\r\n\r\n${wrap76(f.content.replace(/[^A-Za-z0-9+/=]/g, ""))}\r\n`
    }).join("")
    mime = `${headers.join("\r\n")}\r\n\r\n--${mixed}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${alternative}\r\n${parts}--${mixed}--`
  }
  return { ok: true, raw: Buffer.from(mime, "utf-8").toString("base64url"), text }
}

/** "Re: x" / "Fwd: x" once (never "Re: Re: x"). */
export function subjectFor(mode: ComposeMode, original: string): string {
  const base = original.replace(/^\s*((re|fwd?|r|i)\s*:\s*)+/i, "").trim()
  if (mode === "new") return original
  return mode === "forward" ? `Fwd: ${base}` : `Re: ${base}`
}

/**
 * Who a reply goes to. Reply: the other side of the message answered (its sender, or - when we wrote it - its recipients). Reply all: also everybody else on To and Cc, minus us.
 */
export function replyRecipients(msg: { from: string; fromEmail: string; to: string; cc: string; outbound: boolean }, mailbox: string, all: boolean): { to: string[]; cc: string[] } {
  const addrs = (h: string) => (parseRecipients(h).ok ? (parseRecipients(h) as { list: string[] }).list : [])
  const toList = addrs(msg.to)
  const ccList = addrs(msg.cc)
  const primary = msg.outbound ? toList : [msg.fromEmail]
  const to = primary.filter(a => a !== mailbox)
  if (!all) return { to: to.length ? to : [msg.fromEmail].filter(a => a !== mailbox), cc: [] }
  const rest = [...toList, ...ccList].filter(a => a !== mailbox && !to.includes(a))
  return { to, cc: Array.from(new Set(rest)) }
}
