import { describe, it, expect, vi, afterEach } from "vitest"
import type { User } from "@supabase/supabase-js"
import { AUDIENCES, parseAudience, strictAudienceOrNull } from "@/lib/open-services/audience-shared"
import { canViewOpenServices } from "@/lib/open-services/access"

/**
 * N1a C3 — who may see the Open services tab. Fails CLOSED: every unexpected stored value means 'off', and the rule
 * never trusts user_metadata (the account holder can write it to their own login).
 */

function user(over: { email?: string; app?: Record<string, unknown>; meta?: Record<string, unknown> }): User {
  return { id: "u", email: over.email ?? "x@example.com", app_metadata: over.app ?? {}, user_metadata: over.meta ?? {} } as unknown as User
}

const client = user({ app: { role: "client" } })
const partner = user({ app: { role: "partner" } })
const team = user({ email: "luca@tonydurante.us", app: { role: "team" } })
const noRole = user({ email: "legacy@tonydurante.us" })
const adminByApp = user({ email: "someone@tonydurante.us", app: { role: "admin" } })
const selfWrittenAdmin = user({ email: "qa@tonydurante.us", app: { role: "staff" }, meta: { role: "admin" } })
const owner = user({ email: "antonio.durante@tonydurante.us", app: { role: "admin" } })

describe("parseAudience / strictAudienceOrNull", () => {
  it("accepts exactly the three values (trim + lowercase)", () => {
    for (const a of AUDIENCES) expect(parseAudience(a)).toBe(a)
    expect(parseAudience(" Owners ")).toBe("owners")
    expect(parseAudience("ALL")).toBe("all")
    expect(strictAudienceOrNull(" OFF ")).toBe("off")
  })

  it("anything else is off", () => {
    for (const v of [true, false, 1, 0, {}, [], null, undefined, "", "on", "admins", "owner", "all staff", "banana", "all,owners"]) {
      expect(parseAudience(v), JSON.stringify(v)).toBe("off")
    }
  })

  it("the strict check REJECTS garbage (for the PUT) instead of mapping it to off", () => {
    for (const v of [true, {}, null, undefined, "", "banana", "admins", 1]) {
      expect(strictAudienceOrNull(v), JSON.stringify(v)).toBeNull()
    }
  })
})

describe("canViewOpenServices", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("nobody at all when the setting is off", () => {
    for (const u of [client, partner, team, noRole, adminByApp, selfWrittenAdmin, owner, null]) {
      expect(canViewOpenServices(u, "off")).toBe(false)
    }
  })

  it("'all' = TD staff only: clients and partners never", () => {
    expect(canViewOpenServices(client, "all")).toBe(false)
    expect(canViewOpenServices(partner, "all")).toBe(false)
    expect(canViewOpenServices(null, "all")).toBe(false)
    expect(canViewOpenServices(team, "all")).toBe(true)
    expect(canViewOpenServices(noRole, "all")).toBe(true)
    expect(canViewOpenServices(adminByApp, "all")).toBe(true)
    expect(canViewOpenServices(owner, "all")).toBe(true)
  })

  it("'owners' = owners only: team, admins by role and self-written admins are refused", () => {
    expect(canViewOpenServices(owner, "owners")).toBe(true)
    expect(canViewOpenServices(team, "owners")).toBe(false)
    expect(canViewOpenServices(noRole, "owners")).toBe(false)
    expect(canViewOpenServices(adminByApp, "owners")).toBe(false)
    expect(canViewOpenServices(selfWrittenAdmin, "owners")).toBe(false)
    expect(canViewOpenServices(client, "owners")).toBe(false)
    expect(canViewOpenServices(partner, "owners")).toBe(false)
  })

  it("an extra owner added by the deployment setting is an owner (and only then)", () => {
    const jodi = user({ email: "jodi@tonydurante.us", app: { role: "admin" } })
    expect(canViewOpenServices(jodi, "owners")).toBe(false)
    vi.stubEnv("NEXT_PUBLIC_EXTRA_OWNER_EMAILS", "jodi@tonydurante.us")
    expect(canViewOpenServices(jodi, "owners")).toBe(true)
  })

  it("an owner who is somehow marked as a client is still refused (staff rule first)", () => {
    const odd = user({ email: "antonio.durante@tonydurante.us", app: { role: "client" } })
    expect(canViewOpenServices(odd, "owners")).toBe(false)
    expect(canViewOpenServices(odd, "all")).toBe(false)
  })
})
