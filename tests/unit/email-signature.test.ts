import { describe, it, expect } from "vitest"
import {
  buildSignature,
  hasSignature,
  buildSignatureHtml,
  buildSignatureText,
  parseSignatureVariant,
  parseSignatureSender,
  signaturePhotoUrl,
  signatureLogoUrl,
  SIGNATURE_VARIANTS,
  DEFAULT_SIGNATURE_VARIANT,
  DEFAULT_REPLY_SIGNATURE_VARIANT,
} from "@/lib/email/signature"

const BASE = "https://app.example.test"

describe("parseSignatureVariant", () => {
  it("accepts every real variant", () => {
    for (const v of SIGNATURE_VARIANTS) {
      expect(parseSignatureVariant(v)).toBe(v)
    }
  })

  // A bad value must never be why a staff member's email fails to send.
  it.each([undefined, null, "", "GALA", "photo", 7, {}, []])(
    "falls back rather than throwing on %p",
    (bad) => {
      expect(parseSignatureVariant(bad)).toBe(DEFAULT_SIGNATURE_VARIANT)
    }
  )

  it("honours a caller-supplied fallback, which is how replies stay text-only", () => {
    expect(parseSignatureVariant(undefined, "text")).toBe("text")
    expect(parseSignatureVariant(undefined, DEFAULT_REPLY_SIGNATURE_VARIANT)).toBe("text")
  })

  it("does not let a supplied fallback override a valid value", () => {
    expect(parseSignatureVariant("hat", "text")).toBe("hat")
  })
})

describe("parseSignatureSender", () => {
  it("resolves the personal mailbox only on an exact match", () => {
    expect(parseSignatureSender("antonio")).toBe("antonio")
  })

  // Fails to the SHARED mailbox: a wrong guess must not put Antonio's name
  // and direct line on mail he did not send.
  it.each(["Antonio", "ANTONIO", "antonio.durante@tonydurante.us", undefined, null, "", "support", 1])(
    "falls back to support on %p",
    (bad) => {
      expect(parseSignatureSender(bad)).toBe("support")
    }
  )
})

describe("asset URLs", () => {
  it("builds absolute URLs, since a relative src is dead once the mail leaves", () => {
    expect(signaturePhotoUrl("gala", BASE)).toBe(`${BASE}/images/signature-antonio-gala.jpg`)
    expect(signaturePhotoUrl("hat", BASE)).toBe(`${BASE}/images/signature-antonio-hat.jpg`)
    expect(signatureLogoUrl(BASE)).toBe(`${BASE}/images/tony-logos.png`)
  })

  it("has no photo for the text variant", () => {
    expect(signaturePhotoUrl("text", BASE)).toBeNull()
  })

  it("does not double the slash when the base URL has a trailing one", () => {
    expect(signatureLogoUrl("https://x.test/")).toBe("https://x.test/images/tony-logos.png")
    expect(signaturePhotoUrl("gala", "https://x.test///")).toBe(
      "https://x.test/images/signature-antonio-gala.jpg"
    )
  })
})

describe("buildSignatureText", () => {
  it("carries Antonio's identity in full", () => {
    const text = buildSignatureText({ sender: "antonio", variant: "gala", baseUrl: BASE })
    expect(text).toContain("Antonio Noel Durante")
    expect(text).toContain("Executive Director, Tony Durante LLC")
    expect(text).toContain("10225 Ulmerton Rd, Suite 3D, Largo, FL 33771")
    expect(text).toContain("+1 727 423 4285")
    expect(text).toContain("antonio.durante@tonydurante.us")
  })

  it("carries the company identity for support, with the company line not his", () => {
    const text = buildSignatureText({ sender: "support", variant: "gala", baseUrl: BASE })
    expect(text).toContain("Tony Durante LLC")
    expect(text).toContain("+1 (727) 452-1093")
    expect(text).toContain("support@tonydurante.us")
    expect(text).not.toContain("Antonio")
    expect(text).not.toContain("+1 727 423 4285")
    expect(text).not.toContain("antonio.durante@tonydurante.us")
  })

  it("is identical across variants - the picture never changes the facts", () => {
    const base = { sender: "antonio" as const, baseUrl: BASE }
    const gala = buildSignatureText({ ...base, variant: "gala" })
    expect(buildSignatureText({ ...base, variant: "hat" })).toBe(gala)
    expect(buildSignatureText({ ...base, variant: "text" })).toBe(gala)
  })

  it("omits the sign-off when the author writes their own", () => {
    const withIt = buildSignatureText({ sender: "antonio", variant: "text", baseUrl: BASE })
    const without = buildSignatureText({
      sender: "antonio",
      variant: "text",
      includeSignoff: false,
      baseUrl: BASE,
    })
    expect(withIt.startsWith("Best regards,")).toBe(true)
    expect(without.startsWith("Antonio Noel Durante")).toBe(true)
    expect(without).not.toContain("Best regards")
  })

  it("contains no HTML - it is the text/plain half", () => {
    for (const variant of SIGNATURE_VARIANTS) {
      const text = buildSignatureText({ sender: "antonio", variant, baseUrl: BASE })
      expect(text).not.toMatch(/<[a-z/]/i)
    }
  })
})

describe("buildSignatureHtml", () => {
  it("shows Antonio's photo when the mail leaves from his own address", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE })
    expect(html).toContain(`${BASE}/images/signature-antonio-gala.jpg`)
    expect(html).toContain(`${BASE}/images/tony-logos.png`)
  })

  it("swaps the portrait when the sender picks the hat", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "hat", baseUrl: BASE })
    expect(html).toContain("signature-antonio-hat.jpg")
    expect(html).not.toContain("signature-antonio-gala.jpg")
  })

  // Support is the shared mailbox. A face on it would misattribute the mail.
  it("never puts a portrait on support, whichever variant is asked for", () => {
    for (const variant of SIGNATURE_VARIANTS) {
      const html = buildSignatureHtml({ sender: "support", variant, baseUrl: BASE })
      expect(html).not.toContain("signature-antonio")
    }
  })

  // The 2026-08-07 redesign (Luca's review, Antonio's approval): company mail
  // shows the TD logo ONCE — the lockup beside the block — and the strip below
  // carries only the three certification badges. The old layout repeated the
  // logo in the banner.
  it("brands support with the lockup and badges, and never the old banner", () => {
    const html = buildSignatureHtml({ sender: "support", variant: "gala", baseUrl: BASE })
    expect(html).toContain(`${BASE}/images/signature-td-lockup.png`)
    expect(html).toContain(`${BASE}/images/signature-badges.png`)
    expect(html).not.toContain("tony-logos.png")
  })

  it("keeps the original banner on Antonio's mail — his only TD logo", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE })
    expect(html).toContain("tony-logos.png")
    expect(html).not.toContain("signature-badges.png")
    expect(html).not.toContain("signature-td-lockup.png")
  })

  // Compact ("text") carries the small TD mark and NOTHING else - no
  // portrait, no banner. The mark is on every signed email by Antonio's
  // decision (2026-08-05); heavy images still must not stack down a thread.
  it("compact keeps exactly one image: the small TD mark", () => {
    for (const sender of ["antonio", "support"] as const) {
      const html = buildSignatureHtml({ sender, variant: "text", baseUrl: BASE })
      expect(html.match(/<img/g)).toHaveLength(1)
      expect(html).toContain('signature-td-mark.png" width="40" height="40"')
      expect(html).not.toContain(".jpg") // no portrait
      expect(html).not.toContain("tony-logos") // no banner
    }
  })

  it("keeps every fact in the text so a blocked image loses nothing", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE })
    const stripped = html.replace(/<[^>]+>/g, " ")
    expect(stripped).toContain("Antonio Noel Durante")
    expect(stripped).toContain("Executive Director")
    expect(stripped).toContain("10225 Ulmerton Rd, Suite 3D, Largo, FL 33771")
    expect(stripped).toContain("+1 727 423 4285")
    expect(stripped).toContain("antonio.durante@tonydurante.us")
  })

  it("names the person in alt text, which is what Outlook shows while blocked", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE })
    expect(html).toContain('alt="Antonio Noel Durante"')
  })

  it("sizes every image explicitly so the layout cannot jump on load", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE })
    for (const img of html.match(/<img[^>]+>/g) ?? []) {
      expect(img).toMatch(/\swidth="\d+"/)
    }
  })

  // Outlook renders mail through Word: no flexbox, no grid.
  it("lays out with tables, not flex or grid", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE })
    expect(html).toContain("<table")
    expect(html).not.toMatch(/display:\s*(flex|grid)/)
  })

  // sanitizeToAscii() rewrites these on the compose path only, so a
  // typographic signature would differ between paths.
  it("stays ASCII, because one send path rewrites smart punctuation", () => {
    for (const sender of ["antonio", "support"] as const) {
      for (const variant of SIGNATURE_VARIANTS) {
        const { html, text } = buildSignature({ sender, variant, baseUrl: BASE })
        // eslint-disable-next-line no-control-regex
        expect(html).not.toMatch(/[^\x00-\x7F]/)
        // eslint-disable-next-line no-control-regex
        expect(text).not.toMatch(/[^\x00-\x7F]/)
      }
    }
  })

  it("strips punctuation out of the tel: link so it dials", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "text", baseUrl: BASE })
    expect(html).toContain('href="tel:+17274234285"')
    const support = buildSignatureHtml({ sender: "support", variant: "text", baseUrl: BASE })
    expect(support).toContain('href="tel:+17274521093"')
  })

  it("omits the sign-off when the author writes their own", () => {
    const html = buildSignatureHtml({
      sender: "antonio",
      variant: "gala",
      includeSignoff: false,
      baseUrl: BASE,
    })
    expect(html).not.toContain("Best regards")
  })
})

describe("buildSignature", () => {
  it("returns both halves, which is what every MIME builder needs", () => {
    const sig = buildSignature({ sender: "antonio", variant: "gala", baseUrl: BASE })
    expect(sig.html).toBe(buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE }))
    expect(sig.text).toBe(buildSignatureText({ sender: "antonio", variant: "gala", baseUrl: BASE }))
  })
})

describe("defaults", () => {
  // These two encode Antonio's decision of 2026-08-05 and are the reason a
  // long thread does not fill with his face. Changing them is a product
  // decision, so make it fail loudly here first.
  it("leads with the award portrait on new mail and stays text-only on replies", () => {
    expect(DEFAULT_SIGNATURE_VARIANT).toBe("gala")
    expect(DEFAULT_REPLY_SIGNATURE_VARIANT).toBe("text")
  })
})

describe('the "none" variant — no signature at all', () => {
  it("produces nothing on either half, for either sender", () => {
    for (const sender of ["antonio", "support"] as const) {
      expect(buildSignatureHtml({ sender, variant: "none", baseUrl: BASE })).toBe("")
      expect(buildSignatureText({ sender, variant: "none", baseUrl: BASE })).toBe("")
    }
  })

  it("drops the sign-off too — 'no signature' means no 'Best regards' either", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "none", baseUrl: BASE })
    const text = buildSignatureText({ sender: "antonio", variant: "none", baseUrl: BASE })
    expect(html).not.toContain("Best regards")
    expect(text).not.toContain("Best regards")
  })

  it("has no photo URL", () => {
    expect(signaturePhotoUrl("none", BASE)).toBeNull()
  })

  it("is a real variant that survives parsing", () => {
    expect(parseSignatureVariant("none")).toBe("none")
  })

  // This is the guard the call sites depend on: they must branch on it rather
  // than concatenate "", or the separator around the empty string survives and
  // the email trails blank lines.
  it("is the only variant hasSignature() rejects", () => {
    expect(hasSignature("none")).toBe(false)
    for (const v of SIGNATURE_VARIANTS.filter((x) => x !== "none")) {
      expect(hasSignature(v)).toBe(true)
    }
  })

  it("leaves every OTHER variant still producing a block", () => {
    for (const v of SIGNATURE_VARIANTS.filter((x) => x !== "none")) {
      expect(buildSignatureText({ sender: "antonio", variant: v, baseUrl: BASE })).toContain(
        "Antonio Noel Durante"
      )
    }
  })
})

describe("the TD branding on the company block", () => {
  // The 2026-08-07 lockup (TD mark + "TONY DURANTE", no tagline) is the ONE
  // TD logo on company full-variant mail — the strip below is badges only,
  // so the logo never repeats (Luca's review).
  it("puts the lockup beside the support block on image variants", () => {
    for (const variant of ["gala", "hat"] as const) {
      const html = buildSignatureHtml({ sender: "support", variant, baseUrl: BASE })
      expect(html).toContain(`${BASE}/images/signature-td-lockup.png`)
      expect(html).toContain('alt="Tony Durante LLC"')
      expect(html).not.toContain("signature-td-mark.png")
    }
  })

  it("yields to Antonio's portrait on his photo variants", () => {
    for (const v of ["gala", "hat"] as const) {
      const html = buildSignatureHtml({ sender: "antonio", variant: v, baseUrl: BASE })
      expect(html).not.toContain("signature-td-mark")
      expect(html).not.toContain("signature-td-lockup")
    }
  })

  it("keeps the small mark on compact for BOTH senders - the logo is on every signed email", () => {
    for (const sender of ["antonio", "support"] as const) {
      expect(
        buildSignatureHtml({ sender, variant: "text", baseUrl: BASE })
      ).toContain('signature-td-mark.png" width="40" height="40"')
    }
  })

  it("stays off 'none' - the only way to send with no logo at all", () => {
    for (const sender of ["antonio", "support"] as const) {
      const html = buildSignatureHtml({ sender, variant: "none", baseUrl: BASE })
      expect(html).not.toContain("signature-td-mark")
      expect(html).not.toContain("signature-td-lockup")
    }
  })

  it("sizes the lockup explicitly like every other image", () => {
    const html = buildSignatureHtml({ sender: "support", variant: "gala", baseUrl: BASE })
    expect(html).toMatch(/signature-td-lockup\.png" width="120" height="84"/)
  })
})

describe("the strip under the block", () => {
  // Fixed px widths, NOT max-width:100%: inside an auto-layout table a
  // shrinkable image loses the width negotiation to the narrowest row
  // (browser-measured 2026-08-05). Fixed width is the guard on both strips.
  it("pins Antonio's banner at 300px with no shrink-to-fit escape hatch", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: BASE })
    const banner = html.match(/<img[^>]*tony-logos[^>]*>/)?.[0] ?? ""
    expect(banner).toContain('width="300"')
    expect(banner).not.toContain("max-width")
  })

  it("pins the support badges at 260x80, centered", () => {
    const html = buildSignatureHtml({ sender: "support", variant: "gala", baseUrl: BASE })
    const badges = html.match(/<img[^>]*signature-badges[^>]*>/)?.[0] ?? ""
    expect(badges).toContain('width="260"')
    expect(badges).toContain('height="80"')
    expect(badges).not.toContain("max-width")
    expect(html).toContain('align="center"')
  })

  // A blocked-images reader must still learn what the badges say.
  it("names the three certifications in the badges alt text", () => {
    const html = buildSignatureHtml({ sender: "support", variant: "gala", baseUrl: BASE })
    expect(html).toContain(
      'alt="IRS Certified Acceptance Agents - Public Notary - Professional Tax Preparer"'
    )
  })

  it("support full carries exactly two images: lockup and badges", () => {
    const html = buildSignatureHtml({ sender: "support", variant: "gala", baseUrl: BASE })
    expect(html.match(/<img/g)).toHaveLength(2)
  })
})

describe("relative base URL (in-app preview)", () => {
  // The compose/reply preview renders with baseUrl "" so images load from
  // whichever deployment serves the CRM — the client bundle cannot see the
  // server's base-URL override, and production may not carry the assets yet.
  it("an empty base yields root-relative image paths", () => {
    const html = buildSignatureHtml({ sender: "antonio", variant: "gala", baseUrl: "" })
    expect(html).toContain('src="/images/signature-antonio-gala.jpg"')
    expect(html).toContain('src="/images/tony-logos.png"')
    expect(html).not.toContain('src="https://')
    const support = buildSignatureHtml({ sender: "support", variant: "gala", baseUrl: "" })
    expect(support).toContain('src="/images/signature-td-lockup.png"')
    expect(support).toContain('src="/images/signature-badges.png"')
  })
})
