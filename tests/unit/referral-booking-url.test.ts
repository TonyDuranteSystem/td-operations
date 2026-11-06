/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CALENDLY_BOOKING_URL } from "@/lib/config"
import { buildReferralBookingUrl } from "@/lib/referral-utils"

// 2026-11-06: the referral landing page's "Book a free call" button pointed at a Calendly address that
// had been renamed (antoniodurante → antonionoeldurante) and 404'd, so every referred friend dead-ended.

vi.mock("next/image", () => ({
  default: (props: { alt: string }) => React.createElement("img", { alt: props.alt }),
}))
vi.mock("@/components/referral/ref-cookie", () => ({ RefCookie: () => null }))

const maybeSingle = vi.fn()
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ ilike: () => ({ maybeSingle }) }) }),
  },
}))

const OLD_HANDLE = "calendly.com/antoniodurante"

describe("CALENDLY_BOOKING_URL", () => {
  it("is on the live Calendly account name, not the retired one", () => {
    const url = new URL(CALENDLY_BOOKING_URL)
    expect(url.hostname).toBe("calendly.com")
    expect(url.pathname).toBe("/antonionoeldurante/free-meet-greet-call")
  })
})

describe("buildReferralBookingUrl", () => {
  it("points at the booking page and carries the referral code in utm_campaign and a1", () => {
    const url = new URL(buildReferralBookingUrl("marco-rossi"))
    expect(`${url.origin}${url.pathname}`).toBe(CALENDLY_BOOKING_URL)
    expect(url.searchParams.get("utm_source")).toBe("referral")
    expect(url.searchParams.get("utm_medium")).toBe("link")
    expect(url.searchParams.get("utm_campaign")).toBe("marco-rossi")
    expect(url.searchParams.get("a1")).toBe("marco-rossi")
  })

  it("keeps the older LASTNAME-YYYY codes intact", () => {
    const url = new URL(buildReferralBookingUrl("GREPPI-2026"))
    expect(url.searchParams.get("utm_campaign")).toBe("GREPPI-2026")
  })

  it("encodes a code with unusual characters so it cannot add or break query parameters", () => {
    const url = new URL(buildReferralBookingUrl("a&utm_source=evil b"))
    expect(url.searchParams.get("utm_source")).toBe("referral")
    expect(url.searchParams.get("utm_campaign")).toBe("a&utm_source=evil b")
  })
})

describe("referral landing page button", () => {
  it("links to the live booking page with the visitor's referral code", async () => {
    maybeSingle.mockResolvedValue({ data: { full_name: "Marco Rossi", referral_code: "marco-rossi" } })
    const { default: ReferralLandingPage } = await import("@/app/invitation/[code]/page")
    const element = await ReferralLandingPage({
      params: Promise.resolve({ code: "marco-rossi" }),
      searchParams: Promise.resolve({}),
    })
    const html = renderToStaticMarkup(element)
    expect(html).toContain("Marco recommended Tony Durante LLC")
    expect(html).toContain("calendly.com/antonionoeldurante/free-meet-greet-call?")
    expect(html).toContain("utm_campaign=marco-rossi")
    expect(html).not.toContain(OLD_HANDLE)
  })
})

describe("the retired Calendly address", () => {
  it("appears nowhere in app/, lib/ or components/", () => {
    const root = join(__dirname, "..", "..")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next") continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(full, "utf8").includes(OLD_HANDLE)) {
          offenders.push(full.slice(root.length + 1))
        }
      }
    }
    for (const dir of ["app", "lib", "components"]) walk(join(root, dir))
    expect(offenders).toEqual([])
  })
})
