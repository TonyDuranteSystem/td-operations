import { describe, it, expect } from "vitest"
import { buildDeliveryHtml, buildMime, buildSubject, encodeHeader, escapeHtml, safeAttachmentName } from "@/lib/bofa-intake/email"

const DATA: Record<string, string> = {
  full_name: "Jordan <b>Smith</b>",
  company_name: "Northwind & Co LLC",
  email: "jordan@example.com",
  itin: "900-00-0000",
  business_description: "Line one\nLine two",
}

describe("bofa intake delivery email", () => {
  it("escapes HTML in every answer", () => {
    const html = buildDeliveryHtml(DATA, [])
    expect(html).toContain("Jordan &lt;b&gt;Smith&lt;/b&gt;")
    expect(html).toContain("Northwind &amp; Co LLC")
    expect(html).not.toContain("<b>Smith</b>")
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;")
  })

  it("never mentions the partner or any TD staff address", () => {
    const html = buildDeliveryHtml({ ...DATA }, [{ label: "Passport photo page", name: "p.pdf", content: Buffer.from("x") }])
    expect(html.toLowerCase()).not.toContain("partner")
    expect(html).not.toContain("tonydurante")
    expect(html).not.toContain("/bofa-intake")
  })

  it("lists attached documents, or download links when they are too big to attach", () => {
    const attached = buildDeliveryHtml(DATA, [{ label: "Passport photo page", name: "p.pdf", content: Buffer.from("x") }])
    expect(attached).toContain("Attached (1)")
    const linked = buildDeliveryHtml(DATA, [{ label: "Lease agreement", name: "lease.pdf", url: "https://example.com/signed?x=1&y=2" }])
    expect(linked).toContain("works for 7 days")
    expect(linked).toContain("https://example.com/signed?x=1&amp;y=2")
  })

  it("puts the ITIN with the applicant and skips empty answers", () => {
    const html = buildDeliveryHtml(DATA, [])
    expect(html.indexOf("ITIN")).toBeLessThan(html.indexOf("Company</h3>"))
    expect(html).not.toContain("Website")
  })

  it("builds a subject from the applicant, base64-encoded in the MIME header (R041)", () => {
    expect(buildSubject(DATA)).toBe("Bank account application: Jordan <b>Smith</b> — Northwind & Co LLC")
    expect(buildSubject({})).toBe("Bank account application: Applicant")
    const mime = buildMime({ to: ["a@x.com", "b@x.com"], subject: "Café — ünï", html: "<p>hi</p>", files: [] })
    expect(mime).toContain(`Subject: ${encodeHeader("Café — ünï")}`)
    expect(mime).not.toContain("Café")
    expect(mime).toContain("To: a@x.com, b@x.com")
  })

  it("builds multipart/mixed with one base64 part per attachment and a closing boundary", () => {
    const mime = buildMime({
      to: ["a@x.com"],
      subject: "s",
      html: "<p>hi</p>",
      files: [
        { label: "Passport", name: "my passport.pdf", content: Buffer.from("PDFDATA"), contentType: "application/pdf" },
        { label: "Lease", name: "lease.pdf", url: "https://example.com/x" },
      ],
    })
    const boundary = /boundary="([^"]+)"/.exec(mime)![1]
    expect(mime.match(new RegExp(`--${boundary}\\r\\n`, "g"))).toHaveLength(2) // body + the one attached file
    expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
    expect(mime).toContain(Buffer.from("PDFDATA").toString("base64"))
    expect(mime).toContain("Content-Disposition: attachment")
    expect(mime).not.toContain("https://example.com/x") // link-only files are not attached
  })

  it("keeps attachment names header-safe", () => {
    expect(safeAttachmentName('a"b\r\nc.pdf')).toBe("a_b_c.pdf")
    expect(safeAttachmentName("")).toBe("file")
  })
})
