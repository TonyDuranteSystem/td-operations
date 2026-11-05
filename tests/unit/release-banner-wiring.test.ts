/**
 * "New release available — refresh" — the wiring that must not drift (dev job dc629a3d).
 * Source pins, because the promise is structural: every deployment stamps itself, the live site can say which release it is without
 * touching a database, and only the CRM (not the client portal) shows the new bar.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = (p: string) => readFileSync(p, "utf8")

describe("the stamp: every deployment carries its own release id", () => {
  const cfg = read("next.config.js")
  it("production builds take the commit from Vercel, but the sandbox's own stamp wins when present", () => {
    expect(cfg).toMatch(/NEXT_PUBLIC_BUILD_SHA: process\.env\.NEXT_PUBLIC_BUILD_SHA \|\| \(process\.env\.VERCEL_GIT_COMMIT_SHA \|\| ''\)\.slice\(0, 7\)/)
  })
  it("the release id reads the two NEXT_PUBLIC names LITERALLY (Next.js only inlines them as written)", () => {
    const own = read("lib/release/own-release.ts")
    expect(own).toContain("process.env.NEXT_PUBLIC_BUILD_SHA")
    expect(own).toContain("process.env.NEXT_PUBLIC_BUILD_TIME")
    expect(own).toContain("releaseIdFrom(")
  })
  it("the sandbox deploy script still injects both parts", () => {
    const script = read("scripts/deploy-sandbox.sh")
    expect(script).toContain("NEXT_PUBLIC_BUILD_SHA=")
    expect(script).toContain("NEXT_PUBLIC_BUILD_TIME=")
  })
})

describe("the live answer: /api/release", () => {
  const route = read("app/api/release/route.ts")
  it("is a baked constant — no database, no Gmail, no session lookup", () => {
    expect(route).toContain("OWN_RELEASE_ID")
    // the CODE only — the explanatory comment above it names these on purpose
    const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").toLowerCase()
    for (const forbidden of ["supabase", "gmail", "createclient", "from(", "fetch(", "auth.getuser"]) {
      expect(code, forbidden).not.toContain(forbidden)
    }
    // …and it imports exactly two things
    expect(route.match(/^import /gm)?.length).toBe(2)
  })
  it("is never cached (a cached answer would hide a new release) and is dynamic", () => {
    expect(route).toContain("no-store")
    expect(route).toContain("force-dynamic")
  })
  it("stays behind the login: it is NOT in the middleware's public list", () => {
    const mw = read("middleware.ts")
    expect(mw).not.toContain("/api/release")
  })
})

describe("the page side: hook and bar", () => {
  const hook = read("lib/hooks/use-release-check.ts")
  it("asks every minute, on coming back to the tab, and re-confirms a first different answer quickly", () => {
    expect(hook).toContain("RELEASE_POLL_MS")
    expect(hook).toContain("RELEASE_CONFIRM_MS")
    expect(hook).toContain("visibilitychange")
    expect(hook).toContain("window.addEventListener('focus'")
  })
  it("asks only while the tab is visible, with no cache, and reads a redirect (ended session) as no answer", () => {
    expect(hook).toContain("document.visibilityState !== 'visible'")
    expect(hook).toContain("cache: 'no-store'")
    expect(hook).toContain("redirect: 'manual'")
    expect(hook).toContain("if (!res.ok) return")
  })
  it("does nothing when disabled or when the build has no release id", () => {
    expect(hook).toContain("if (!enabled || !OWN_RELEASE_ID) return")
  })
  it("all decisions go through the tested pure rule", () => {
    expect(hook).toContain("nextReleaseState(state.current, OWN_RELEASE_ID, data.version)")
  })

  const banner = read("components/shared/update-banner.tsx")
  it("one bar for both signals, with Antonio's wording and a Refresh button", () => {
    expect(banner).toContain("useSwUpdate(swPath, scope)")
    expect(banner).toContain("useReleaseCheck(checkRelease)")
    expect(banner).toContain("New release available — refresh to update")
    expect(banner).toContain("'Refresh'")
    expect(banner).toContain('data-update-banner=""') // the floating-windows tour waits on this marker
  })
  it("a reload happens even without a waiting worker, and a close is remembered only for the release it announced", () => {
    expect(banner).toContain("window.location.reload()")
    expect(banner).toMatch(/closedFor === key/)
  })
  it("the portal's bar is unchanged: it does not opt into the release check, and keeps its Italian/English text", () => {
    expect(read("components/portal/portal-sw-register.tsx")).not.toContain("checkRelease")
    expect(banner).toContain("Una nuova versione è disponibile")
    expect(banner).toContain("Aggiorna ora")
  })
  it("the CRM opts in", () => {
    expect(read("components/dashboard/sw-register.tsx")).toContain('<UpdateBanner swPath="/dashboard-sw.js" checkRelease />')
  })
})
