import { encodeAddressHeader } from "@/lib/gmail"
import { escapeHtml, splitQuotedText } from "@/lib/inbox/email-quote"

export interface ReplyMimeAttachment {
  /** Already sanitized/RFC 2047-encoded by the staging loader — safe in headers. */
  filename: string
  /** Base64-encoded file bytes. */
  content: string
  contentType?: string
}

/** One prior message in the thread, for `quoteMode: 'thread'`. Ordered oldest-first by the caller. */
export interface ThreadQuoteEntry {
  /** Raw From header of the message (attribution author) */
  from: string
  /** Raw Date header ('' when unknown) */
  date: string
  /** Plain-text body, already stripped of its OWN nested quoted history
   *  (lib/inbox/email-quote.ts's splitQuotedText) — otherwise each message's
   *  raw body already contains every message before it, and stacking N raw
   *  bodies duplicates most of the thread's content. */
  body: string
}

export interface BuildReplyMimeInput {
  /** Sending mailbox address (From) */
  asUser: string
  /**
   * Recipient(s). A single string keeps the exact historical behavior
   * (display name preserved via RFC 2047, one address). An array is the new
   * multi-recipient case (replying to a sent message that went to more than
   * one person) — bare lowercase addresses only, joined like Cc, no
   * per-address name encoding to get wrong.
   */
  replyTo: string | string[]
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
  /**
   * 'message' (default, when omitted) — quote only lastBody, today's
   * behavior. 'thread' — quote every entry in `threadQuotes` instead (whole
   * conversation). 'none' — no quote block at all, regardless of lastBody.
   */
  quoteMode?: "message" | "thread" | "none"
  /** Required when quoteMode is 'thread'; ignored otherwise. Oldest-first. */
  threadQuotes?: ThreadQuoteEntry[]
  /** Boundary override for deterministic tests */
  boundary?: string
  /** Staged file attachments (loaded server-side from the private bucket). */
  attachments?: ReplyMimeAttachment[]
  /**
   * The sender's signature, both halves, already built by
   * lib/email/signature.ts. Sits BETWEEN the reply and the quoted history,
   * which is where every mail client puts one. Omit for no signature.
   *
   * Both halves or neither: passing only the HTML would leave the text/plain
   * part unsigned, and plain-text readers are exactly the ones who cannot
   * fall back to the images.
   */
  signature?: { html: string; text: string }
  /** Display name for the From header. Omitted -> bare address, as before. */
  fromName?: string
  /**
   * Reply-All recipients (besides `replyTo`). Bare lowercase addresses only —
   * no display names, so there's no per-address RFC 2047 encoding to get
   * wrong here (see encodeAddressHeader's single-address assumption). Omit
   * or pass [] for a plain Reply.
   */
  cc?: string[]
}

/** A single "On <date>, <author> wrote:" + blockquote block, plain + HTML. */
function buildQuoteBlock(from: string, date: string, body: string): { plain: string; html: string } {
  const quoteDate = date
    ? new Date(date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : ""
  const attribution = `On ${quoteDate}, ${from} wrote:`
  const plain =
    `\r\n\r\n${attribution}\r\n` +
    body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\r\n")
  const html =
    `<div class="gmail_quote" style="margin-top:16px">` +
    `<div style="color:#5f6368">${escapeHtml(attribution)}</div>` +
    `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368">` +
    escapeHtml(body).replace(/\r?\n/g, "<br />") +
    `</blockquote></div>`
  return { plain, html }
}

/** Total characters across every quoted body in 'thread' mode — a long
 *  back-and-forth must not build an unbounded MIME payload. Per-message cap
 *  (10,000 chars) is enforced by the caller, same as 'message' mode today. */
const THREAD_QUOTE_TOTAL_CHAR_CAP = 40_000

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

  const quoteMode = input.quoteMode ?? "message"
  let quotedPlain = ""
  let quotedHtml = ""
  if (quoteMode === "message" && lastBody) {
    const block = buildQuoteBlock(lastFrom, lastDate, lastBody)
    quotedPlain = block.plain
    quotedHtml = block.html
  } else if (quoteMode === "thread" && input.threadQuotes?.length) {
    let remaining = THREAD_QUOTE_TOTAL_CHAR_CAP
    for (const entry of input.threadQuotes) {
      if (remaining <= 0) break
      // Strip each entry's OWN nested quoted history — enforced HERE,
      // internally, rather than trusting every caller to pre-strip: an
      // ordinary mail client's reply body already embeds everything before
      // it, so a caller that forgets this (as the reply route originally
      // did for the target message's own entry — dev job 208f39ad,
      // bug-hunter pass) would otherwise duplicate most of the thread.
      // Idempotent on an already-stripped entry — splitQuotedText just
      // finds nothing further to split off.
      const stripped = splitQuotedText(entry.body).main.trimEnd()
      const body = stripped.length > remaining ? stripped.slice(0, remaining) : stripped
      remaining -= body.length
      const block = buildQuoteBlock(entry.from, entry.date, body)
      quotedPlain += block.plain
      quotedHtml += block.html
    }
  }
  // quoteMode === "none" -> both stay empty regardless of lastBody.

  // The signature is pre-built HTML from lib/email/signature.ts, NOT user
  // input, so it is concatenated rather than escaped — unlike `message`,
  // which is what the staff member typed and is always escaped.
  const signatureHtml = input.signature?.html ?? ""
  const signatureText = input.signature ? `\r\n\r\n${input.signature.text}` : ""

  const messageHtml = escapeHtml(message).replace(/\r?\n/g, "<br />")
  const htmlBody =
    `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">` +
    messageHtml +
    signatureHtml +
    `</div>` +
    quotedHtml

  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  // '_' is not in the base64 alphabet, so '--td_...' can never collide with
  // an encoded body line.
  const boundary = input.boundary ?? `td_${Date.now().toString(36)}`
  const attachments = input.attachments ?? []

  // With attachments the structure Gmail expects is multipart/mixed wrapping
  // the multipart/alternative body plus one part per file. Without them the
  // historical alternative-only shape is kept byte-for-byte.
  const mixedBoundary = `${boundary}_mixed`
  const topContentType = attachments.length
    ? `multipart/mixed; boundary="${mixedBoundary}"`
    : `multipart/alternative; boundary="${boundary}"`

  const headers = [
    `From: ${input.fromName ? `${input.fromName} <${asUser}>` : asUser}`,
    `To: ${Array.isArray(replyTo) ? replyTo.join(", ") : encodeAddressHeader(replyTo)}`,
    ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references ? references + " " : ""}${inReplyTo}`,
    "MIME-Version: 1.0",
    `Content-Type: ${topContentType}`,
  ]

  const plainBase64 = Buffer.from(message + signatureText + quotedPlain, "utf-8").toString(
    "base64"
  )
  const htmlBase64 = Buffer.from(htmlBody, "utf-8").toString("base64")

  const alternativePart =
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

  if (!attachments.length) {
    return headers.join("\r\n") + "\r\n\r\n" + alternativePart
  }

  const attachmentParts = attachments
    .map((att) => {
      const ct = att.contentType || "application/octet-stream"
      return (
        `--${mixedBoundary}\r\n` +
        `Content-Type: ${ct}; name="${att.filename}"\r\n` +
        "Content-Transfer-Encoding: base64\r\n" +
        `Content-Disposition: attachment; filename="${att.filename}"\r\n\r\n` +
        att.content +
        "\r\n"
      )
    })
    .join("")

  return (
    headers.join("\r\n") +
    "\r\n\r\n" +
    `--${mixedBoundary}\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
    alternativePart +
    "\r\n" +
    attachmentParts +
    `--${mixedBoundary}--`
  )
}
