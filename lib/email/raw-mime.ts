/**
 * Pure MIME assembler for outbound Gmail sends.
 *
 * Extracted so the worker's branded sender and the operational sender don't
 * hand-roll two multipart/mixed builders that drift on the next bug. This module
 * does ONE thing: given headers, an HTML body, a plain-text alternative, and
 * optional attachments, produce the base64url `raw` string Gmail's API wants.
 *
 * It owns NO branding, NO tracking, NO threading lookup — the caller builds its
 * own HTML and its own threading headers and passes them in. That's the whole
 * point: the shared part is the byte assembly, not the policy.
 */

export interface RawEmailAttachment {
  filename: string
  /** e.g. "application/pdf". Falls back to octet-stream. */
  contentType?: string
  /** File bytes, already base64-encoded. */
  base64: string
}

export interface BuildRawEmailInput {
  /**
   * Header lines WITHOUT MIME-Version or Content-Type — this builder adds those,
   * because Content-Type depends on whether there are attachments. Include From,
   * To, Subject (already RFC2047-encoded by the caller), and any In-Reply-To /
   * References / Cc / X-Tag lines.
   */
  headerLines: string[]
  htmlBody: string
  /** Plain-text alternative. Improves deliverability; recipients see the HTML. */
  plainText: string
  attachments?: RawEmailAttachment[]
}

/**
 * Encode an attachment filename for a MIME header.
 *
 * A raw `filename="Affidavità.pdf"` corrupts on a non-ASCII name and — worse — a
 * name containing a quote, semicolon, or CR/LF is a header-injection vector. For
 * a clean ASCII name we keep the simple quoted form; otherwise RFC 2231
 * (`filename*=UTF-8''<percent-encoded>`), which every modern mail client honours.
 */
export function encodeMimeFilename(name: string): string {
  const safe = (name || "file").replace(/[\r\n]/g, "") // never let a newline into a header
  const isCleanAscii = /^[\x20-\x7E]*$/.test(safe) && !/["\\;]/.test(safe)
  if (isCleanAscii) {
    return `filename="${safe}"`
  }
  // RFC 2231: percent-encode UTF-8 bytes; keep RFC-2231 attr-char set unescaped.
  const encoded = encodeURIComponent(safe).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  return `filename*=UTF-8''${encoded}`
}

/** Wrap base64 at 76 chars per RFC 2045 — stricter MTAs than Gmail require it. */
function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd()
}

/**
 * Assemble the message and return its base64url encoding for Gmail's
 * `messages.send`. Boundaries are caller-supplied so the function stays pure and
 * testable (no clock); the caller passes unique values.
 */
export function buildRawEmail(input: BuildRawEmailInput, boundaries: { outer: string; alt: string }): string {
  const attachments = input.attachments ?? []
  const hasAttachments = attachments.length > 0
  const { outer, alt } = boundaries

  const lines: string[] = [...input.headerLines, "MIME-Version: 1.0"]
  lines.push(
    hasAttachments
      ? `Content-Type: multipart/mixed; boundary="${outer}"`
      : `Content-Type: multipart/alternative; boundary="${outer}"`,
  )
  lines.push("")

  const altPart = (boundary: string): string[] => [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.plainText, "utf-8").toString("base64")),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.htmlBody, "utf-8").toString("base64")),
    "",
    `--${boundary}--`,
  ]

  if (hasAttachments) {
    // multipart/mixed: [ multipart/alternative (text+html) ][ attachment... ]
    lines.push(`--${outer}`)
    lines.push(`Content-Type: multipart/alternative; boundary="${alt}"`)
    lines.push("")
    lines.push(...altPart(alt))
    for (const att of attachments) {
      const ct = (att.contentType || "application/octet-stream").replace(/[\r\n]/g, "")
      lines.push("")
      lines.push(`--${outer}`)
      lines.push(`Content-Type: ${ct}`)
      lines.push("Content-Transfer-Encoding: base64")
      lines.push(`Content-Disposition: attachment; ${encodeMimeFilename(att.filename)}`)
      lines.push("")
      lines.push(wrap76(att.base64))
    }
    lines.push("")
    lines.push(`--${outer}--`)
  } else {
    lines.push(...altPart(outer))
  }

  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url")
}
