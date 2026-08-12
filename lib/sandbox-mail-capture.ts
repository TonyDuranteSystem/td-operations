/**
 * QA-only: record the rendered content of an outbound email the SANDBOX blocked.
 *
 * Sandbox turns every Gmail send into a no-op (SANDBOX_MODE), so a tester cannot
 * see what a client would have received. This decodes the raw MIME that WOULD
 * have been sent and stores recipient / subject / body / links in
 * `sandbox_captured_emails`, readable by staff at /sandbox-mail. It is called
 * ONLY from the sandbox no-op branch of gmailPost — in production that branch
 * never runs, so this never executes there. Best-effort and fully swallowed: a
 * capture failure must never disturb the (already no-op'd) send path.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** Decode an RFC 2047 `=?utf-8?B?...?=` / `=?utf-8?Q?...?=` encoded header word. */
function decodeMimeWord(raw: string): string {
  return raw.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_m, enc: string, data: string) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(data, "base64").toString("utf8")
      // Q-encoding: _ => space, =XX => byte
      const q = data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_s, h) => String.fromCharCode(parseInt(h, 16)))
      return q
    } catch {
      return data
    }
  })
}

/** Pull a header value (first match, case-insensitive) from a header block. */
function header(headerBlock: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im")
  const m = re.exec(headerBlock)
  return m ? m[1].trim() : null
}

/**
 * Decode a base64url MIME message into its readable parts. Deliberately simple:
 * it concatenates every base64-encoded body part it finds (covering the common
 * multipart/alternative text+html shape our senders produce) and falls back to
 * the raw post-header text otherwise. Good enough to READ — this is a QA viewer,
 * not a mail client.
 */
export function decodeSandboxEmail(rawBase64Url: string): {
  recipient: string | null
  subject: string | null
  body: string
  links: string[]
} {
  let mime = ""
  try {
    mime = Buffer.from(rawBase64Url, "base64url").toString("utf8")
  } catch {
    mime = ""
  }
  const splitAt = mime.indexOf("\r\n\r\n") >= 0 ? mime.indexOf("\r\n\r\n") : mime.indexOf("\n\n")
  const headerBlock = splitAt >= 0 ? mime.slice(0, splitAt) : mime

  const recipient = header(headerBlock, "To")
  const subjRaw = header(headerBlock, "Subject")
  const subject = subjRaw ? decodeMimeWord(subjRaw) : null

  // Collect readable body: decode each base64 chunk that follows a
  // Content-Transfer-Encoding: base64 marker; if none, use the raw remainder.
  let body = ""
  const parts = mime.split(/Content-Transfer-Encoding:\s*base64/i)
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      // The base64 payload is the block up to the next boundary / header line.
      const chunk = parts[i].replace(/^\r?\n\r?\n?/, "")
      const b64 = chunk.split(/\r?\n--|\r?\n[A-Za-z-]+:/)[0].replace(/\s+/g, "")
      try {
        const decoded = Buffer.from(b64, "base64").toString("utf8")
        if (decoded && /[\x20-\x7e]/.test(decoded)) body += (body ? "\n\n" : "") + decoded
      } catch {
        /* skip an undecodable part */
      }
    }
  }
  if (!body) body = splitAt >= 0 ? mime.slice(splitAt).trim() : mime

  // HTML bodies encode `&` as `&amp;`, so a raw-extracted signing link reads
  // `...?portal=true&amp;signer=CODE` — which a browser parses as a broken param
  // and the link fails. Decode the common entities so a captured link is clean
  // and clickable.
  const decodeEntities = (s: string): string =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&#x2f;/gi, "/")
  const cleanBody = decodeEntities(body)
  const links = Array.from(new Set((cleanBody.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).map(s => s.replace(/[.,);]+$/, ""))))
  return { recipient, subject, body: cleanBody, links }
}

/** Store one blocked outbound email. Never throws. */
export async function captureSandboxEmail(rawBase64Url: unknown): Promise<void> {
  if (typeof rawBase64Url !== "string" || !rawBase64Url) return
  try {
    const { recipient, subject, body, links } = decodeSandboxEmail(rawBase64Url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from("sandbox_captured_emails")
      .insert({ recipient, subject, body: body.slice(0, 100_000), links })
  } catch (err) {
    console.warn("[sandbox-mail] capture failed (non-fatal):", err instanceof Error ? err.message : String(err))
  }
}
