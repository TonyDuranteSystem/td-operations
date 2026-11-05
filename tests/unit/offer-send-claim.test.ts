/**
 * Offer builder Part 3, item B (dev job d2971d11) — two Sends of the same offer can no longer both email the client.
 *
 * The database is faked, but the fake follows the one rule that matters: an UPDATE with filters is decided in one step, so when
 * two Sends race, exactly one of them gets a row back (that is how the real database behaves; the same race was also run for real
 * on the sandbox — see docs/systems/offers.md). Nothing real is sent or written.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  row: {} as Row,
  /** Make the next matching write fail: "claim" = the claim write, "flip" = the status -> sent write, "release" = the release. */
  fail: new Set<string>(),
  calls: [] as Array<{ table: string; op: string; patch?: unknown; eqs?: Array<[string, unknown]>; or?: string | null }>,
  gmail: vi.fn(),
  portal: vi.fn(),
  logged: [] as Array<Record<string, unknown>>,
}))

/** One filtered UPDATE on the fake offers row, decided in one step: every .eq must match and the .or() must hold. */
function runUpdate(patch: Row, eqs: Array<[string, unknown]>, or: string | null) {
  const kind = patch.status === "sent" ? "flip" : patch.send_started_at === null ? "release" : "claim"
  if (h.fail.has(kind)) return { data: null, error: { message: `${kind} write failed` } }
  const matches = eqs.every(([c, v]) => h.row[c] === v)
  const orOk = !or || or.split(",").some((term) => {
    const [col, op, ...rest] = term.split(".")
    const val = rest.join(".")
    const cur = h.row[col] as string | null | undefined
    if (op === "is" && val === "null") return cur == null
    if (op === "lt") return cur != null && cur < val
    return false
  })
  if (!matches || !orOk) return { data: [], error: null }
  Object.assign(h.row, patch)
  return { data: [{ token: h.row.token }], error: null }
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let op = "select"
      let patch: Row = {}
      let or: string | null = null
      const eqs: Array<[string, unknown]> = []
      const exec = () => {
        h.calls.push({ table, op: "update", patch, eqs: [...eqs], or })
        return table === "offers" ? runUpdate(patch, eqs, or) : { data: null, error: null }
      }
      const chain: Record<string, unknown> = {
        select: () => (op === "update" ? Promise.resolve(exec()) : chain),
        update: (p: Row) => { op = "update"; patch = p; return chain },
        insert: (r: unknown) => { h.calls.push({ table, op: "insert", patch: r }); return Promise.resolve({ data: null, error: null }) },
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        or: (expr: string) => { or = expr; return chain },
        limit: () => chain,
        single: () => Promise.resolve({ data: table === "offers" ? { ...h.row } : null, error: null }),
        maybeSingle: () => Promise.resolve({
          data: table === "offers" ? { status: h.row.status, send_started_at: h.row.send_started_at ?? null } : { id: "contact-1" },
          error: null,
        }),
        // an update that is awaited without .select() (the release, the lead move) runs here
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(op === "update" ? exec() : { data: null, error: null }).then(resolve, reject),
      }
      return chain
    },
  },
}))
vi.mock("@/lib/offers/send-check", () => ({ offerSendCheck: vi.fn(async () => ({ blockers: [], risks: [], notChecked: [], willSendTo: "client@example.invalid" })) }))
vi.mock("@/lib/portal/auto-create", () => ({ autoCreatePortalUser: (...a: unknown[]) => h.portal(...a) }))
vi.mock("@/lib/portal/welcome-token", () => ({ createWelcomeToken: vi.fn(), findWelcomeTokenBySource: vi.fn() }))
vi.mock("@/lib/auth-admin-helpers", () => ({ findAuthUserByEmail: vi.fn() }))
vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => h.gmail(...a) }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (e: Record<string, unknown>) => { h.logged.push(e) } }))

import { claimOfferSend, releaseOfferSend, SEND_CLAIM_MINUTES } from "@/lib/offers/send-claim"
import { publishOffer } from "@/lib/offers/publish"

const OFFER: Row = {
  id: "o1", token: "t1", client_name: "Test Client", client_email: "client@example.invalid", language: "en", status: "draft",
  access_code: "x", lead_id: "lead-1", account_id: null, services: [], bundled_pipelines: [], recurring_costs: null,
  installment_currency: null, contract_type: "tax_return", send_started_at: null,
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

beforeEach(() => {
  h.row = { ...OFFER }
  h.fail = new Set()
  h.calls = []
  h.logged = []
  h.gmail.mockReset()
  h.gmail.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); return { id: "gmail-1", threadId: "thread-1" } })
  h.portal.mockReset()
  h.portal.mockResolvedValue({ success: true, alreadyExists: true })
})

describe("claimOfferSend", () => {
  it("the first claim wins and writes its time; a second one while the first is fresh is refused with a plain reason", async () => {
    const first = await claimOfferSend("t1")
    expect(first.ok).toBe(true)
    expect(h.row.send_started_at).toBe(first.claimedAt)
    const second = await claimOfferSend("t1")
    expect(second.ok).toBe(false)
    expect(second.alreadySent).toBe(true)
    expect(second.message).toContain("already in progress")
    expect(second.message).toContain("nothing was sent twice")
  })

  it("the write is ONE filtered update: this offer, still a draft, and no claim younger than the window", async () => {
    await claimOfferSend("t1", new Date("2026-11-05T12:00:00.000Z"))
    const [w] = h.calls.filter((c) => c.op === "update")
    expect(w.patch).toEqual({ send_started_at: "2026-11-05T12:00:00.000Z" })
    expect(w.eqs).toEqual([["token", "t1"], ["status", "draft"]])
    expect(w.or).toBe(`send_started_at.is.null,send_started_at.lt.${new Date("2026-11-05T11:50:00.000Z").toISOString()}`)
    expect(SEND_CLAIM_MINUTES).toBe(10)
  })

  it("an offer that is no longer a draft says so (and nothing is written)", async () => {
    h.row.status = "sent"
    const r = await claimOfferSend("t1")
    expect(r).toMatchObject({ ok: false, alreadySent: true, message: "Offer already published (status: sent)." })
    expect(h.row.send_started_at).toBeNull()
  })

  it("a claim older than the window (a Send that died) no longer blocks; one inside it still does", async () => {
    h.row.send_started_at = minutesAgo(11)
    expect((await claimOfferSend("t1")).ok).toBe(true)
    h.row.send_started_at = minutesAgo(9)
    expect((await claimOfferSend("t1")).ok).toBe(false)
  })

  it("a write that fails is NOT 'someone else is sending': nothing is sent and the reason says try again", async () => {
    h.fail.add("claim")
    const r = await claimOfferSend("t1")
    expect(r).toMatchObject({ ok: false, alreadySent: false })
    expect(r.message).toContain("nothing was sent")
  })
})

describe("releaseOfferSend", () => {
  it("clears our own claim", async () => {
    const c = await claimOfferSend("t1")
    expect(c.ok).toBe(true)
    await releaseOfferSend("t1", c.claimedAt as string)
    expect(h.row.send_started_at).toBeNull()
  })

  it("never clears a claim somebody else took after ours expired", async () => {
    h.row.send_started_at = "2026-11-05T12:30:00.000Z"
    await releaseOfferSend("t1", "2026-11-05T12:00:00.000Z")
    expect(h.row.send_started_at).toBe("2026-11-05T12:30:00.000Z")
  })

  it("never throws, even when the database refuses", async () => {
    h.row.send_started_at = "2026-11-05T12:00:00.000Z"
    h.fail.add("release")
    await expect(releaseOfferSend("t1", "2026-11-05T12:00:00.000Z")).resolves.toBeUndefined()
  })
})

describe("Send, end to end with the claim (publishOffer)", () => {
  it("TWO SENDS AT THE SAME MOMENT: exactly one email goes out, the other is stopped before it does anything", async () => {
    const [a, b] = await Promise.all([publishOffer("t1", "crm"), publishOffer("t1", "claude")])
    expect(h.gmail).toHaveBeenCalledTimes(1)
    expect(h.portal).toHaveBeenCalledTimes(1)
    const winners = [a, b].filter((r) => r.success)
    const losers = [a, b].filter((r) => !r.success)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0].alreadySent).toBe(true)
    expect(losers[0].error).toContain("already in progress")
    expect(h.row.status).toBe("sent")
    expect(h.row.send_started_at).toBeNull()
  })

  it("FIVE at once: still exactly one email", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => publishOffer("t1", `caller-${n}`)))
    expect(h.gmail).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.success)).toHaveLength(1)
  })

  it("a Send that fails at the email gives the offer back, so the next try works at once", async () => {
    h.gmail.mockRejectedValueOnce(new Error("gmail down"))
    await expect(publishOffer("t1", "test")).rejects.toThrow("gmail down")
    expect(h.row.send_started_at).toBeNull()
    expect(h.row.status).toBe("draft")
    const retry = await publishOffer("t1", "test")
    expect(retry.success).toBe(true)
    expect(h.gmail).toHaveBeenCalledTimes(2)
  })

  it("a Send that fails making the client's login gives the offer back too", async () => {
    h.portal.mockResolvedValueOnce({ success: false, error: "no login for you" })
    const r = await publishOffer("t1", "test")
    expect(r.success).toBe(false)
    expect(r.error).toContain("Portal user creation failed")
    expect(h.gmail).not.toHaveBeenCalled()
    expect(h.row.send_started_at).toBeNull()
  })

  it("the email went out but the status write failed: the claim STAYS, so pressing Send again cannot email a second time", async () => {
    h.fail.add("flip")
    const first = await publishOffer("t1", "test")
    expect(first.success).toBe(true) // the email did go out; the warning says the status write did not finish
    expect(first.warnings.join(" ")).toContain("update_offer_status")
    expect(h.row.status).toBe("draft")
    expect(h.row.send_started_at).not.toBeNull()
    const again = await publishOffer("t1", "test")
    expect(again.success).toBe(false)
    expect(again.alreadySent).toBe(true)
    expect(h.gmail).toHaveBeenCalledTimes(1)
  })

  it("a fresh claim held by someone else stops Send before anything happens; an old one is ignored", async () => {
    h.row.send_started_at = minutesAgo(2)
    const blocked = await publishOffer("t1", "test")
    expect(blocked.success).toBe(false)
    expect(h.portal).not.toHaveBeenCalled()
    expect(h.gmail).not.toHaveBeenCalled()
    expect(h.row.send_started_at).not.toBeNull() // the holder's claim is not ours to clear
    h.row.send_started_at = minutesAgo(15)
    const ok = await publishOffer("t1", "test")
    expect(ok.success).toBe(true)
    expect(h.gmail).toHaveBeenCalledTimes(1)
  })

  it("the stopped Send leaves the other Send's claim alone", async () => {
    h.row.send_started_at = minutesAgo(1)
    const before = h.row.send_started_at
    await publishOffer("t1", "test")
    expect(h.row.send_started_at).toBe(before)
  })
})

describe("wiring (source order)", () => {
  const src = readFileSync(join(process.cwd(), "lib/offers/publish.ts"), "utf8")

  it("the claim is taken after the checks and before the client's login or any email", () => {
    const check = src.search(/offerSendCheck\(\{ offer, [^}]*mode: "send" \}\)/) // (written so it holds with or without the Activate Lead door)
    const claim = src.indexOf("claimOfferSend(token)")
    const portal = src.indexOf("autoCreatePortalUser({")
    const mail = src.indexOf(`gmailPost("/messages/send"`)
    expect(check).toBeGreaterThan(0)
    expect(claim).toBeGreaterThan(check)
    expect(portal).toBeGreaterThan(claim)
    expect(mail).toBeGreaterThan(portal)
  })

  it("the claim is given back only when the email never went out, and 'email out' is recorded right after Gmail accepts it", () => {
    expect(src).toMatch(/finally \{[\s\S]*progress\.claimedAt && !progress\.emailSent[\s\S]*releaseOfferSend\(token, progress\.claimedAt\)/)
    const sent = src.indexOf("progress.emailSent = true")
    expect(sent).toBeGreaterThan(src.indexOf(`gmailPost("/messages/send"`))
    expect(sent).toBeLessThan(src.indexOf("postSendSteps:"))
  })

  it("the status write clears the claim in the same statement", () => {
    expect(readFileSync(join(process.cwd(), "lib/offers/mark-sent.ts"), "utf8")).toContain("send_started_at: null")
  })

  it("the migration adds one nullable column and has an UNDO", () => {
    const dir = join(process.cwd(), "scripts/migrations")
    const up = readFileSync(join(dir, "20261105-1500-offer-send-started-at.sql"), "utf8")
    const undo = readFileSync(join(dir, "20261105-1500-offer-send-started-at.UNDO.sql"), "utf8")
    expect(up).toMatch(/ALTER TABLE public\.offers ADD COLUMN IF NOT EXISTS send_started_at timestamptz NULL;/)
    expect(up).not.toMatch(/DEFAULT|NOT NULL|UPDATE public\.offers/)
    expect(undo).toMatch(/ALTER TABLE public\.offers DROP COLUMN IF EXISTS send_started_at;/)
  })
})
