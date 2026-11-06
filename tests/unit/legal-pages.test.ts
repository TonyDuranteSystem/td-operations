/**
 * TD Social phone app — the two public pages the App Store links to: Privacy Policy (/privacy) and Support (/support) (dev job 2072bc3e, 6 Nov 2026).
 * Pinned here: no draft marker is left in the wording, the wording says what the app really does (alerts, providers, contact), the pages render and
 * link to each other, and the middleware lets both through without a login (Apple's reviewers and the App Store have no account).
 */
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "fs"
import { join } from "path"
import { LegalPage } from "@/components/legal/legal-page"
import {
  LEGAL_CONTACT_EMAIL, LEGAL_UPDATED, PRIVACY_SECTIONS, PRIVACY_TITLE, SUPPORT_SECTIONS, SUPPORT_TITLE, type LegalSection,
} from "@/lib/legal/td-social-pages"

const text = (sections: LegalSection[]) => sections.flatMap(s => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? []), ...(s.after ?? [])]).join("\n")
const root = join(__dirname, "..", "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")

describe("the wording", () => {
  const all = [PRIVACY_TITLE, SUPPORT_TITLE, LEGAL_UPDATED, text(PRIVACY_SECTIONS), text(SUPPORT_SECTIONS)].join("\n")

  it("has no draft marker or placeholder left", () => {
    expect(all).not.toMatch(/\[[^\]]*\]/)
    expect(all).not.toMatch(/TO CONFIRM|TO CREATE|DATE OF|LINK TO|lorem|TBD|XXX/i)
  })

  it("names the company, the contact address and today's date format", () => {
    expect(all).toContain("Tony Durante LLC")
    expect(LEGAL_CONTACT_EMAIL).toBe("support@tonydurante.us")
    expect(text(PRIVACY_SECTIONS)).toContain(LEGAL_CONTACT_EMAIL)
    expect(text(SUPPORT_SECTIONS)).toContain(LEGAL_CONTACT_EMAIL)
    expect(LEGAL_UPDATED).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/)
  })

  it("lists every provider the app's data really goes through", () => {
    const privacy = text(PRIVACY_SECTIONS)
    for (const p of ["Vercel", "Supabase", "Apple", "Google", "Sentry", "OpenAI"]) expect(privacy, p).toContain(p)
  })

  it("says what is true about alerts: client alerts do not show the text, direct team messages may", () => {
    const alerts = PRIVACY_SECTIONS.find(s => s.heading.includes("Alerts"))
    expect(alerts?.paragraphs?.join(" ")).toContain("show who wrote and not what they wrote")
    expect(alerts?.paragraphs?.join(" ")).toMatch(/direct messages between team members may show the message text/)
  })

  it("says what is not collected, and that nothing is sold or tracked", () => {
    const privacy = text(PRIVACY_SECTIONS)
    expect(privacy).toContain("We do not sell your information")
    expect(privacy).toContain("We do not use advertising or tracking tools")
    expect(privacy).toMatch(/do not collect your location, contacts, health data or payment details/)
  })

  it("covers the headings Apple's reviewers look for", () => {
    const headings = PRIVACY_SECTIONS.map(s => s.heading).join("|")
    for (const h of ["What we collect", "How we use it", "Who we share it with", "How long we keep it", "Your choices and rights", "Children", "Contact"]) expect(headings, h).toContain(h)
  })
})

describe("the pages", () => {
  it("render the title, the date and every heading as plain server markup", () => {
    const out = renderToStaticMarkup(createElement(LegalPage, { title: PRIVACY_TITLE, updated: LEGAL_UPDATED, sections: PRIVACY_SECTIONS }))
    expect(out).toContain(`<h1`)
    expect(out).toContain(PRIVACY_TITLE)
    expect(out).toContain(`Last updated: ${LEGAL_UPDATED}`)
    for (const s of PRIVACY_SECTIONS) expect(out).toContain(s.heading)
    expect(out).toContain("Tony Durante LLC")
  })

  it("the support page has no date line and a link to the privacy page; the privacy page links to support", () => {
    const sup = renderToStaticMarkup(createElement(LegalPage, { title: SUPPORT_TITLE, sections: SUPPORT_SECTIONS, footerLink: { href: "/privacy", label: "Privacy" } }))
    expect(sup).not.toContain("Last updated")
    expect(sup).toContain('href="/privacy"')
    expect(src("app/privacy/page.tsx")).toContain("href: '/support'")
    expect(src("app/support/page.tsx")).toContain("href: '/privacy'")
  })

  it("both pages are plain server components with the right titles and no hardcoded address", () => {
    for (const p of ["app/privacy/page.tsx", "app/support/page.tsx"]) {
      const code = src(p)
      expect(code).not.toContain("'use client'")
      expect(code).toContain("export const metadata")
      expect(code).not.toMatch(/https?:\/\//)
    }
    expect(src("app/privacy/page.tsx")).toContain("Privacy Policy — TD Social")
    expect(src("app/support/page.tsx")).toContain("Support — TD Social")
  })
})

describe("no login needed", () => {
  const mw = src("middleware.ts")
  it("middleware lets /privacy and /support through as public prefixes", () => {
    const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES"), mw.indexOf("function isPublicPath"))
    expect(list).toContain("'/privacy',")
    expect(list).toContain("'/support',")
  })
  it("and nothing else in the public list starts with those words (a prefix match would open it too)", () => {
    const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES"), mw.indexOf("function isPublicPath"))
    const entries = [...list.matchAll(/^\s+'(\/[^']*)',/gm)].map(m => m[1])
    expect(entries.filter(e => e.startsWith("/privacy") || e.startsWith("/support"))).toEqual(["/privacy", "/support"])
  })
})
