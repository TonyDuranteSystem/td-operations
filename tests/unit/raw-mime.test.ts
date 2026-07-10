import { describe, it, expect } from "vitest"
import { buildRawEmail, encodeMimeFilename } from "@/lib/email/raw-mime"

const B = { outer: "OUTER", alt: "ALT" }
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf-8")

describe("encodeMimeFilename", () => {
  it("keeps a clean ASCII name in the simple quoted form", () => {
    expect(encodeMimeFilename("affidavit.pdf")).toBe('filename="affidavit.pdf"')
  })

  it("RFC-2231 encodes an accented name (the Italian-client bug)", () => {
    const out = encodeMimeFilename("Affidavità.pdf")
    expect(out).toMatch(/^filename\*=UTF-8''/)
    expect(out).not.toContain("à")
    expect(decodeURIComponent(out.replace("filename*=UTF-8''", ""))).toBe("Affidavità.pdf")
  })

  it("never lets a CRLF into the header (injection guard)", () => {
    const out = encodeMimeFilename('x.pdf"\r\nBcc: evil@x.com')
    expect(out).not.toMatch(/[\r\n]/)
  })

  it("escapes a quote/semicolon by switching to the encoded form", () => {
    expect(encodeMimeFilename('a"b;c.pdf')).toMatch(/^filename\*=UTF-8''/)
  })
})

describe("buildRawEmail", () => {
  const base = { headerLines: ["From: T <s@t.us>", "To: c@x.com", "Subject: Hi"], htmlBody: "<p>hi</p>", plainText: "hi" }

  it("no attachments → multipart/alternative with text + html", () => {
    const msg = decode(buildRawEmail(base, B))
    expect(msg).toContain('Content-Type: multipart/alternative; boundary="OUTER"')
    expect(msg).toContain("text/plain")
    expect(msg).toContain("text/html")
    expect(msg).not.toContain("multipart/mixed")
    expect(msg).toContain(Buffer.from("hi").toString("base64"))
  })

  it("with attachment → multipart/mixed wrapping the alternative + the file", () => {
    const msg = decode(
      buildRawEmail({ ...base, attachments: [{ filename: "a.pdf", contentType: "application/pdf", base64: "QUJD" }] }, B),
    )
    expect(msg).toContain('Content-Type: multipart/mixed; boundary="OUTER"')
    expect(msg).toContain('Content-Type: multipart/alternative; boundary="ALT"')
    expect(msg).toContain("Content-Type: application/pdf")
    expect(msg).toContain('Content-Disposition: attachment; filename="a.pdf"')
    expect(msg).toContain("QUJD")
  })

  it("uses distinct outer and alternative boundaries (no collision)", () => {
    const msg = decode(buildRawEmail({ ...base, attachments: [{ filename: "a.pdf", base64: "QQ==" }] }, B))
    expect(msg).toContain("--OUTER")
    expect(msg).toContain("--ALT")
    expect(msg).toContain("--OUTER--")
    expect(msg).toContain("--ALT--")
  })

  it("defaults a missing content type to octet-stream", () => {
    const msg = decode(buildRawEmail({ ...base, attachments: [{ filename: "x.bin", base64: "QQ==" }] }, B))
    expect(msg).toContain("Content-Type: application/octet-stream")
  })

  it("preserves caller threading headers verbatim", () => {
    const msg = decode(
      buildRawEmail({ ...base, headerLines: [...base.headerLines, "In-Reply-To: <abc@mail>", "References: <abc@mail>"] }, B),
    )
    expect(msg).toContain("In-Reply-To: <abc@mail>")
    expect(msg).toContain("References: <abc@mail>")
  })

  it("wraps long base64 at 76 chars (RFC 2045)", () => {
    const big = "A".repeat(500)
    const msg = decode(buildRawEmail({ ...base, attachments: [{ filename: "a.bin", base64: big }] }, B))
    const longLine = msg.split("\r\n").find((l) => l.startsWith("AAAA"))
    expect(longLine!.length).toBeLessThanOrEqual(76)
  })

  it("carries an accented attachment name through as encoded", () => {
    const msg = decode(buildRawEmail({ ...base, attachments: [{ filename: "Contratto—2026.pdf", base64: "QQ==" }] }, B))
    expect(msg).toContain("filename*=UTF-8''")
    expect(msg).not.toContain("Contratto—2026.pdf")
  })
})
