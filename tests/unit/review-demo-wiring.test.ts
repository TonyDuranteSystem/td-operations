import { describe, it, expect } from "vitest"
import fs from "node:fs"

// The practice login for Apple's App Review (TD Social, 6 Nov 2026) is safe only while these wires stay connected: the sign-in gate reads the deadline
// from the login's app_metadata, and the Marketing guard applies the cap/refusal on every request. (The behaviour itself is tested in review-demo.test.ts,
// mfa-gate.test.ts and marketing-permissions-guard.test.ts; these fail if a wire is cut.)
const read = (p: string) => fs.readFileSync(p, "utf8")

describe("review practice login wiring", () => {
  it("the middleware hands the login's review deadline to the gate, from app_metadata only (never from user_metadata, which a person can edit)", () => {
    const m = read("middleware.ts")
    expect(m).toContain("reviewDemoMeta: user.app_metadata,")
    expect(m).not.toMatch(/user_metadata\??\.(\[)?(REVIEW_DEMO|review_demo)/)
    expect(m).not.toMatch(/reviewDemoMeta: user\.user_metadata/)
    const call = m.slice(m.indexOf("resolveMfaGate({"))
    expect(call.indexOf("strict: isMarketingRole(role)")).toBeGreaterThan(-1)
    expect(call.indexOf("reviewDemoMeta")).toBeGreaterThan(call.indexOf("strict: isMarketingRole(role)"))
  })
  it("the Marketing guard reads the state from app_metadata, applies the rule, and every caller must say its state out loud", () => {
    const g = read("lib/marketing/guard.ts")
    expect(g).toContain("reviewDemoFlag(user.app_metadata, Date.now())")
    expect(g).toContain("applyReviewDemo(reviewDemo, verdict.membership, permissions)")
    expect(g).toMatch(/async function memberContext\(userId: string, email: string \| null, role: unknown, reviewDemo: ReviewDemoFlag\)/)
    expect(g).toContain("reviewDemo: true")
    // no caller leaves the state out
    for (const call of g.match(/memberContext\([^)]*\)/g) ?? []) if (!call.startsWith("memberContext(userId")) expect(call, call).toMatch(/NO_REVIEW_DEMO|reviewDemoFlag\(/)
  })
  it("the chat lanes follow the practice flag", () => {
    expect(read("lib/marketing/lead-chat-server.ts")).toContain("reviewDemo: ctx.reviewDemo === true")
  })
  it("the gate's exception is limited to strict subjects without an authenticator", () => {
    expect(read("lib/auth/mfa-gate.ts")).toContain("env.strict && !env.hasVerifiedFactor && reviewDemoState(env.reviewDemoMeta, env.now) === 'live'")
  })
  it("the News reader returns nothing for the practice login (program-wide posts are written for the real teams)", () => {
    const n = read("lib/marketing/news-server.ts")
    const fn = n.slice(n.indexOf("export async function listNewsFor"))
    expect(fn.indexOf("if (ctx.reviewDemo) return []")).toBeGreaterThan(-1)
    expect(fn.indexOf("if (ctx.reviewDemo) return []")).toBeLessThan(fn.indexOf('.from("marketing_news")'))
  })
})
