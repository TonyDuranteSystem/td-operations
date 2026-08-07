/**
 * WS-A: who holds the credit (dev job c0a61e44).
 *
 * The whole point of this module is that the surface which RECORDS the credit
 * and the surface which SHOWS it resolve the same person. These tests pin the
 * two policies apart deliberately — recording must always land somewhere,
 * displaying must be certain or silent.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { resolveCreditSubject, subjectForRecording, subjectForDisplay } from "@/lib/operations/credit-subject"

const scenario: { rows: Array<{ id: string; full_name: string | null; created_at: string | null }>; error: { message: string } | null; filters: Record<string, unknown> } =
  { rows: [], error: null, filters: {} }

function client() {
  return {
    from() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      const chain: any = {
        select: () => chain,
        ilike: (col: string, val: unknown) => { scenario.filters[`${col} ilike`] = val; return chain },
        order: (col: string, opts: unknown) => { scenario.filters.order = `${col}:${JSON.stringify(opts)}`; return chain },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: scenario.error ? null : scenario.rows, error: scenario.error }).then(res),
      }
      return chain
    },
  } as never
}

beforeEach(() => { scenario.rows = []; scenario.error = null; scenario.filters = {} })

describe("resolveCreditSubject", () => {
  it("one person on the address resolves cleanly", async () => {
    scenario.rows = [{ id: "c1", full_name: "Alessandro", created_at: "2026-01-01" }]
    const s = await resolveCreditSubject("a@example.com", client())
    expect(s.kind).toBe("resolved")
    expect(subjectForDisplay(s)).toBe("c1")
    expect(subjectForRecording(s)).toEqual({ contactId: "c1", ambiguous: false })
  })

  it("normalizes case and surrounding whitespace — the same key the booking used", async () => {
    scenario.rows = [{ id: "c1", full_name: "A", created_at: "2026-01-01" }]
    await resolveCreditSubject("  Alessandro@Example.COM  ", client())
    expect(scenario.filters["email ilike"]).toBe("alessandro@example.com")
  })

  it("reads oldest-first so any tie-break is deterministic, not a coin toss", async () => {
    scenario.rows = [{ id: "c1", full_name: "A", created_at: "2026-01-01" }]
    await resolveCreditSubject("a@example.com", client())
    expect(String(scenario.filters.order)).toContain("created_at")
    expect(String(scenario.filters.order)).toContain("true")
  })

  it("nobody on the address is 'unknown' — not an error, not a person", async () => {
    const s = await resolveCreditSubject("nobody@example.com", client())
    expect(s.kind).toBe("unknown")
    expect(subjectForDisplay(s)).toBeNull()
    expect(subjectForRecording(s).contactId).toBeNull()
  })

  it("no address at all resolves to nothing", async () => {
    for (const v of [null, undefined, "", "   "]) {
      const s = await resolveCreditSubject(v, client())
      expect(s.kind).toBe("no_email")
    }
  })
})

describe("two people share one address — the policies deliberately diverge", () => {
  beforeEach(() => {
    scenario.rows = [
      { id: "older", full_name: "Twin One", created_at: "2026-01-01" },
      { id: "newer", full_name: "Twin Two", created_at: "2026-06-01" },
    ]
  })

  it("DISPLAY refuses: showing one person another's balance is the worst outcome", async () => {
    const s = await resolveCreditSubject("shared@example.com", client())
    expect(s.kind).toBe("ambiguous")
    expect(subjectForDisplay(s)).toBeNull()
  })

  it("RECORDING still lands, on the oldest, and reports that it had to choose", async () => {
    const s = await resolveCreditSubject("shared@example.com", client())
    expect(subjectForRecording(s)).toEqual({ contactId: "older", ambiguous: true })
  })
})

describe("a failed lookup is never mistaken for 'they have no credit'", () => {
  it("reports ambiguous rather than unknown, so no surface concludes 'nothing here'", async () => {
    scenario.error = { message: "connection reset" }
    const s = await resolveCreditSubject("a@example.com", client())
    expect(s.kind).toBe("ambiguous")
    expect(subjectForDisplay(s)).toBeNull()      // never displays on a failed read
    expect(subjectForRecording(s).contactId).toBeNull()
  })
})
