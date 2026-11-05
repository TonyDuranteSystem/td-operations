/**
 * Offer builder Part 3, item C (dev job d2971d11) — the lead page's old "Activate Lead" button is GONE.
 *
 * It was a second way to send a draft offer: it made the client's login with a temporary password, emailed the credentials and
 * wrote the offer/lead status itself, with a smaller list of checks than Send. Production's action log showed it was never used
 * once; the normal "Send Offer" button covers a draft. These tests make sure the pieces do not come back by accident — and that
 * the SEPARATE "activate now" feature (the account's offer panel, a different route) was not touched.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name === ".next") continue
    const rel = `${dir}/${name}`
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}

describe("Activate Lead is removed", () => {
  it("the button's pop-up and its server route no longer exist", () => {
    expect(existsSync(join(root, "app/(dashboard)/leads/[id]/components/activate-lead-dialog.tsx"))).toBe(false)
    expect(existsSync(join(root, "app/api/crm/admin-actions/activate-lead/route.ts"))).toBe(false)
  })

  it("the lead page has no Activate Lead button and its no-email hint talks about sending", () => {
    const src = read("app/(dashboard)/leads/[id]/components/lead-actions.tsx")
    expect(src).not.toMatch(/Activate Lead|ActivateLead|activate-lead|canActivateLead/)
    expect(src).toContain("Lead needs an email to send the offer")
    // the normal Send Offer button for a draft is still there
    expect(src).toMatch(/isOfferDraft && hasEmail/)
  })

  it("nothing in the app calls the removed route, and the permission name is gone", () => {
    const offenders = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) => /admin-actions\/activate-lead|'activate_lead'|"activate_lead"/.test(read(f)))
    expect(offenders).toEqual([])
    expect(read("lib/permissions.ts")).not.toContain("activate_lead")
  })

  it("the shared Send check has ONE way in — the real Send and the box beside it — and no 'door' choice left", () => {
    const check = read("lib/offers/send-check.ts")
    expect(check).not.toMatch(/SendDoor|activate_lead|door\b.*===/)
    expect(check).toContain("export async function offerSendCheck(p: { offer: OfferForSendCheck; mode: SendCheckMode })")
    expect(read("lib/offers/publish.ts")).toContain(`offerSendCheck({ offer, mode: "send" })`)
    expect(read("app/api/crm/admin-actions/offer-send-check/route.ts")).toContain(`offerSendCheck({ offer, mode: "preview" })`)
  })

  it("the helper that only the removed route used is gone too", () => {
    expect(read("lib/offers/service-readiness.ts")).not.toMatch(/offerReadinessForToken|offerReadinessProblemForToken/)
  })
})

describe("the separate 'activate now' feature is untouched", () => {
  it("its route and the account offer panel that calls it are still there", () => {
    expect(existsSync(join(root, "app/api/crm/admin-actions/activate-now/route.ts"))).toBe(true)
    expect(read("components/offers/account-offer-panel.tsx")).toContain("/api/crm/admin-actions/activate-now")
  })
})
