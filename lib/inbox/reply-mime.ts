import { encodeAddressHeader } from "@/lib/gmail"
import { escapeHtml } from "@/lib/inbox/email-quote"

export interface BuildReplyMimeInput {
  /** Sending mailbox address (From) */
  asUser: string
  /** Raw To value (decoded, as returned by the Gmail API) */
  replyTo: string
  /** Final subject (already Re:-prefixed) */
  subject: string
  /** Message-ID of the message being replied to */
  inReplyTo: string
  /** Existing References header value ('' when none) */
  references: string
  /** The reply text the staff member typed (plain text) */
  message: string
  /** Plain-text body of the last message (already capped), '' to skip quoting */
  lastBody: string
  /** Raw Date header of the last message ('' when unknown) */
  lastDate: string
  /** Raw From header of the last message (for the attribution line) */
  lastFrom: string
  /** Boundary override for deterministic tests */
  boundary?: string
}

/**
 * Build the raw RFC 2822 reply exactly the way Gmail composes one:
 * multipart/alternative (text/plain with "> "-quoted history + text/html
 * with a gmail_quote blockquote), RFC 2047-encoded Subject AND To
 * display-name (the Gmail API returns headers decoded — copying From→To raw
 * ships non-ASCII header bytes: "Tamás" → "TamÃƒÂ¡s" mojibake, 2026-07-08).
 * Returns the raw string ready for base64url + messages/send.
 */
export function buildReplyMime(input: BuildReplyMimeInput): string {
  const {
    asUser,
    replyTo,
    subject,
    inReplyTo,
    references,
    message,
    lastBody,
    lastDate,
    lastFrom,
  } = input

  let quotedPlain = ""
  let quotedHtml = ""
  if (lastBody) {
    const quoteDate = lastDate
      ? new Date(lastDate).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : ""
    const attribution = `On ${quoteDate}, ${lastFrom} wrote:`
    quotedPlain =
      `\r\n\r\n${attribution}\r\n` +
      lastBody
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\r\n")
    quotedHtml =
      `<div class="gmail_quote" style="margin-top:16px">` +
      `<div style="color:#5f6368">${escapeHtml(attribution)}</div>` +
      `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368">` +
      escapeHtml(lastBody).replace(/\r?\n/g, "<br />") +
      `</blockquote></div>`
  }

  const messageHtml = escapeHtml(message).replace(/\r?\n/g, "<br />")
  const htmlBody =
    `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">` +
    messageHtml +
    `</div>` +
    quotedHtml

  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  // '_' is not in the base64 alphabet, so '--td_...' can never collide with
  // an encoded body line.
  const boundary = input.boundary ?? `td_${Date.now().toString(36)}`
  const headers = [
    `From: ${asUser}`,
    `To: ${encodeAddressHeader(replyTo)}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references ? references + " " : ""}${inReplyTo}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]

  const plainBase64 = Buffer.from(message + quotedPlain, "utf-8").toString("base64")
  const htmlBase64 = Buffer.from(htmlBody, "utf-8").toString("base64")
  return (
    headers.join("\r\n") +
    "\r\n\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    plainBase64 +
    "\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: text/html; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    htmlBase64 +
    "\r\n" +
    `--${boundary}--`
  )
}
