/**
 * Bank application intake — the small HTML emails that are NOT the application itself: the "an application arrived" notice
 * to our own people, the "settings changed" alert to the owner, and the "please correct your application" email to the
 * applicant. One sender so every one of them gets the same safe MIME: RFC 2047 subject (R041), base64 body, HTML-escaped
 * text. THROWS on a failed send; every caller decides what a failure means for it (none of them may fail a client's
 * submission or hide a state change).
 */

import { encodeHeader } from "./email"

export async function sendHtmlEmail(opts: { to: string[]; subject: string; html: string }): Promise<void> {
  if (opts.to.length === 0) throw new Error("No recipient.")
  const raw = [
    "From: Tony Durante LLC <support@tonydurante.us>",
    `To: ${opts.to.join(", ")}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(opts.html).toString("base64"),
  ].join("\r\n")
  const { gmailPost } = await import("@/lib/gmail")
  await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
}
