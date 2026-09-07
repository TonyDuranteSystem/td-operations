/**
 * Owner-Drive access gate.
 *
 * These guard a PRIVACY boundary, not a feature: callerIsOwner() decides whether
 * a request may reach Antonio's personal accounting folder. A regression here
 * leaks his financial documents to the shared support@ identity, so the "denies"
 * cases matter more than the "allows" one.
 */
import { describe, it, expect, afterEach } from "vitest"
import { runWithMcpAuthContext, callerIsOwner, resolvePrimaryStaticKeyEmail } from "@/lib/mcp/auth-context"

const OWNER = "antonio.durante@tonydurante.us"

afterEach(() => {
  delete process.env.MCP_TEAM_CHAT_ACTOR_EMAIL
})

describe("callerIsOwner", () => {
  it("denies when there is no auth context at all (fails closed)", () => {
    // Absent context must never fall through to a permissive default — this is
    // the case that separates it from actingEmailForTeamChat().
    expect(callerIsOwner()).toBe(false)
  })

  it("allows the static key — the Claude Code surface Antonio works in", () => {
    // As of the multi-key change, a bare { method: "static" } with no email no
    // longer means anything — the route always resolves a real email BEFORE
    // building this context (see resolvePrimaryStaticKeyEmail), which is what
    // this test now simulates rather than shortcutting past it.
    expect(
      runWithMcpAuthContext({ method: "static", email: resolvePrimaryStaticKeyEmail() }, callerIsOwner)
    ).toBe(true)
  })

  it("denies the static key once the operator is rotated to someone else", () => {
    process.env.MCP_TEAM_CHAT_ACTOR_EMAIL = "luca@tonydurante.us"
    expect(
      runWithMcpAuthContext({ method: "static", email: resolvePrimaryStaticKeyEmail() }, callerIsOwner)
    ).toBe(false)
  })

  it("allows an oauth session belonging to the owner", () => {
    expect(
      runWithMcpAuthContext({ method: "oauth", email: OWNER }, callerIsOwner)
    ).toBe(true)
  })

  it("DENIES the shared support@ oauth identity", () => {
    // support@ is a real registered oauth user. It is the operational identity
    // and must never reach the owner's private folder.
    expect(
      runWithMcpAuthContext(
        { method: "oauth", email: "support@tonydurante.us" },
        callerIsOwner
      )
    ).toBe(false)
  })

  it("denies an oauth session whose email could not be resolved", () => {
    expect(runWithMcpAuthContext({ method: "oauth", email: null }, callerIsOwner)).toBe(false)
    expect(runWithMcpAuthContext({ method: "oauth" }, callerIsOwner)).toBe(false)
  })

  it("matches the owner case-insensitively and ignores surrounding whitespace", () => {
    // Google addresses are case-insensitive; a capitalised token email must not
    // silently lose the owner his own access.
    expect(
      runWithMcpAuthContext({ method: "oauth", email: "  Antonio.Durante@TonyDurante.us " }, callerIsOwner)
    ).toBe(true)
  })

  it("denies a lookalike address that merely contains the owner's", () => {
    expect(
      runWithMcpAuthContext(
        { method: "oauth", email: "antonio.durante@tonydurante.us.attacker.com" },
        callerIsOwner
      )
    ).toBe(false)
  })
})
