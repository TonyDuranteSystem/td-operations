/**
 * TD Social — the phone list (dev job 2072bc3e, Step 2 pull request A): what the phone may send, and how it is written.
 * The rules these tests pin (Council review, 5 Nov 2026): a token is hexadecimal; the bundle id must be the ONE this server accepts;
 * the Apple system is a two-value choice and an ADDRESS IS NEVER ACCEPTED; registering is one statement; removing is scoped to the
 * person AND the token AND the bundle id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: unknown[] }>,
  count: { count: 0 as number | null, error: null as null | { code?: string } },
  upsert: { error: null as null | { code?: string } },
  del: { data: [{ id: "d1" }] as unknown[] | null, error: null as null | { code?: string } },
}))

function chain(finalResult: () => unknown) {
  const c: Record<string, unknown> = {}
  const rec = (op: string) => (...args: unknown[]) => { h.calls.push({ op, args }); return c }
  for (const op of ["select", "eq", "is", "gte", "neq", "delete"]) c[op] = rec(op)
  c.then = (resolve: (v: unknown) => unknown) => resolve(finalResult())
  return c
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      h.calls.push({ op: "from", args: [table] })
      return {
        select: (...args: unknown[]) => { h.calls.push({ op: "select", args }); return chain(() => h.count) },
        upsert: (...args: unknown[]) => { h.calls.push({ op: "upsert", args }); return Promise.resolve(h.upsert) },
        delete: () => { h.calls.push({ op: "delete", args: [] }); return chain(() => h.del) },
      }
    },
  },
}))

import {
  parseRegistration, parseRemoval, registerDevice, removeDevice,
  MAX_ACTIVE_DEVICES_PER_USER, DEVICE_STALE_DAYS, APNS_ENVS,
} from "@/lib/app/devices"

const RLO = String.fromCharCode(0x202e) // right-to-left override, built from its code so no invisible character sits in this file
const ZWSP = String.fromCharCode(0x200b)
const BUNDLE = "com.tonydurante.tdsocial.sandbox"
const TOKEN = "ab".repeat(32) // 64 hex characters, the usual iPhone alert token length
const good = { token: TOKEN, bundleId: BUNDLE, apnsEnv: "production", deviceName: "Antonio's iPhone", appVersion: "1.0.0", appBuild: 12 }

beforeEach(() => {
  h.calls = []
  h.count = { count: 0, error: null }
  h.upsert = { error: null }
  h.del = { data: [{ id: "d1" }], error: null }
})

describe("parseRegistration: what the phone may send", () => {
  it("accepts a good registration and normalises it", () => {
    const r = parseRegistration({ ...good, token: TOKEN.toUpperCase() }, BUNDLE)
    expect(r).toEqual({ ok: true, value: { token: TOKEN, bundleId: BUNDLE, apnsEnv: "production", deviceName: "Antonio's iPhone", appVersion: "1.0.0", appBuild: 12 } })
  })

  it("accepts the two Apple systems and nothing else", () => {
    expect([...APNS_ENVS]).toEqual(["development", "production"])
    for (const apnsEnv of APNS_ENVS) expect(parseRegistration({ ...good, apnsEnv }, BUNDLE).ok).toBe(true)
  })

  it("REFUSES an address in the Apple-system field (it would be a place the server connects to)", () => {
    for (const apnsEnv of ["attacker.example", "https://api.push.apple.com", "api.sandbox.push.apple.com", "api.push.apple.com", "PRODUCTION", "", 1, null, undefined, {}]) {
      const r = parseRegistration({ ...good, apnsEnv }, BUNDLE)
      expect(r.ok).toBe(false)
      if (r.ok === false) expect(r.code).toBe("BAD_ENV")
    }
  })

  it("the stored value can only be one of the two constants, whatever the phone sent", () => {
    const r = parseRegistration({ ...good, apnsEnv: "development", host: "attacker.example", apns_host: "attacker.example" }, BUNDLE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(["apnsEnv", "appBuild", "appVersion", "bundleId", "deviceName", "token"])
  })

  it("refuses tokens that are not hexadecimal of a sane length (a token goes into a web path later)", () => {
    for (const token of [
      "", "abc", "zz".repeat(32), "ab".repeat(31), "ab".repeat(101),
      `${TOKEN}/../../x`, `${TOKEN}?x=1`, `${TOKEN} `.repeat(2), "../".repeat(30), 5, null, undefined, {}, [],
    ]) {
      const r = parseRegistration({ ...good, token }, BUNDLE)
      expect(r.ok, String(token)).toBe(false)
    }
  })

  it("refuses the other server's app, a look-alike, a missing id, and everything when this server cannot tell what it is", () => {
    for (const bundleId of ["com.tonydurante.tdsocial", "com.tonydurante.tdsocial.sandbox.evil", "COM.TONYDURANTE.TDSOCIAL.SANDBOX", "", null, undefined, 7]) {
      const r = parseRegistration({ ...good, bundleId }, BUNDLE)
      expect(r.ok).toBe(false)
      if (r.ok === false) expect(r.code).toBe("BUNDLE_NOT_ALLOWED")
    }
    const none = parseRegistration(good, null)
    expect(none.ok).toBe(false)
  })

  it("cleans the device name and falls back to a plain one", () => {
    const hostile = parseRegistration({ ...good, deviceName: ("iPhone\n" + RLO + "<script>x</script>").padEnd(200, "x") }, BUNDLE)
    expect(hostile.ok).toBe(true)
    if (hostile.ok) {
      expect(hostile.value.deviceName).not.toContain("\n")
      expect(hostile.value.deviceName).not.toContain(RLO)
      expect(Array.from(hostile.value.deviceName).length).toBeLessThanOrEqual(60)
    }
    const empty = parseRegistration({ ...good, deviceName: ZWSP + "\n" }, BUNDLE)
    expect(empty.ok && empty.value.deviceName).toBe("iPhone")
    const missing = parseRegistration({ ...good, deviceName: undefined }, BUNDLE)
    expect(missing.ok && missing.value.deviceName).toBe("iPhone")
  })

  it("version and build are optional but must be sane when given", () => {
    const min = parseRegistration({ token: TOKEN, bundleId: BUNDLE, apnsEnv: "production" }, BUNDLE)
    expect(min.ok && min.value.appVersion).toBeNull()
    expect(min.ok && min.value.appBuild).toBeNull()
    for (const appVersion of ["1.0 beta", "x".repeat(33), "../1", 3, {}]) expect(parseRegistration({ ...good, appVersion }, BUNDLE).ok).toBe(false)
    for (const appBuild of [-1, 1.5, 10_000_001, "12", NaN]) expect(parseRegistration({ ...good, appBuild }, BUNDLE).ok).toBe(false)
  })

  it("refuses a body that is not a JSON object", () => {
    for (const body of [null, undefined, "x", 5, [], [good]]) expect(parseRegistration(body, BUNDLE).ok).toBe(false)
  })
})

describe("parseRemoval", () => {
  it("needs a valid token and this server's bundle id", () => {
    expect(parseRemoval({ token: TOKEN.toUpperCase(), bundleId: BUNDLE }, BUNDLE)).toEqual({ ok: true, value: { token: TOKEN, bundleId: BUNDLE } })
    expect(parseRemoval({ token: "nope", bundleId: BUNDLE }, BUNDLE).ok).toBe(false)
    expect(parseRemoval({ token: TOKEN, bundleId: "com.other" }, BUNDLE).ok).toBe(false)
    expect(parseRemoval({ token: TOKEN, bundleId: BUNDLE }, null).ok).toBe(false)
    expect(parseRemoval(null, BUNDLE).ok).toBe(false)
  })
})

describe("registerDevice", () => {
  const reg = { token: TOKEN, bundleId: BUNDLE, apnsEnv: "production" as const, deviceName: "iPhone", appVersion: "1.0.0", appBuild: 1 }
  const now = new Date("2026-11-05T12:00:00Z")

  it("registers in ONE statement keyed on bundle id + token, for the signed-in person, clearing any revoked mark", async () => {
    const r = await registerDevice("user-1", reg, now)
    expect(r).toEqual({ ok: true })
    const ups = h.calls.filter(c => c.op === "upsert")
    expect(ups).toHaveLength(1)
    const [row, opts] = ups[0].args as [Record<string, unknown>, Record<string, unknown>]
    expect(opts).toEqual({ onConflict: "bundle_id,token" })
    expect(row).toMatchObject({ user_id: "user-1", token: TOKEN, bundle_id: BUNDLE, apns_env: "production", revoked_at: null, revoked_reason: null, last_seen_at: now.toISOString() })
    expect(h.calls.some(c => c.op === "delete")).toBe(false) // never delete-then-insert
  })

  it("counts only this person's other, active, recently seen phones against the cap", async () => {
    await registerDevice("user-1", reg, now)
    const ops = h.calls.map(c => c.op)
    expect(ops).toContain("is")
    expect(ops).toContain("neq")
    const since = h.calls.find(c => c.op === "gte")?.args
    expect(since?.[0]).toBe("last_seen_at")
    expect(Date.parse(since?.[1] as string)).toBe(now.getTime() - DEVICE_STALE_DAYS * 86_400_000)
    expect(h.calls.find(c => c.op === "eq")?.args).toEqual(["user_id", "user-1"])
  })

  it("refuses an eleventh phone but still lets an existing token refresh (the count excludes it)", async () => {
    h.count = { count: MAX_ACTIVE_DEVICES_PER_USER, error: null }
    expect(await registerDevice("user-1", reg, now)).toEqual({ ok: false, code: "TOO_MANY_DEVICES" })
    expect(h.calls.some(c => c.op === "upsert")).toBe(false)
    h.count = { count: MAX_ACTIVE_DEVICES_PER_USER - 1, error: null }
    expect(await registerDevice("user-1", reg, now)).toEqual({ ok: true })
  })

  it("a database error is a plain DB_ERROR (nothing from the database is passed on)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.upsert = { error: { code: "42P01" } }
    expect(await registerDevice("user-1", reg, now)).toEqual({ ok: false, code: "DB_ERROR" })
    h.count = { count: null, error: { code: "42P01" } }
    expect(await registerDevice("user-1", reg, now)).toEqual({ ok: false, code: "DB_ERROR" })
    // only the error CODE is logged, never the token
    for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain(TOKEN)
    spy.mockRestore()
  })
})

describe("removeDevice", () => {
  it("deletes only this person's row for this token and bundle id", async () => {
    const r = await removeDevice("user-1", TOKEN, BUNDLE)
    expect(r).toEqual({ ok: true, removed: 1 })
    const eqs = h.calls.filter(c => c.op === "eq").map(c => c.args)
    expect(eqs).toEqual([["user_id", "user-1"], ["token", TOKEN], ["bundle_id", BUNDLE]])
  })

  it("removing a phone that is not there removes 0 and is not an error", async () => {
    h.del = { data: [], error: null }
    expect(await removeDevice("user-1", TOKEN, BUNDLE)).toEqual({ ok: true, removed: 0 })
  })

  it("a database error is a plain DB_ERROR", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.del = { data: null, error: { code: "XX000" } }
    expect(await removeDevice("user-1", TOKEN, BUNDLE)).toEqual({ ok: false, code: "DB_ERROR" })
    spy.mockRestore()
  })
})
