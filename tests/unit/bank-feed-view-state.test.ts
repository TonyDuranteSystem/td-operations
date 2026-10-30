/**
 * The Bank Feed list keeps its place in the address. Delete the default-omission and the clean-address test
 * fails; let a junk filter through and the fallback test fails; drop the other parameters and the
 * "keeps tab and feed" test fails.
 */
import { describe, it, expect } from "vitest"
import { parseFeedView, writeFeedView, DEFAULT_FEED_VIEW, type FeedViewState } from "@/lib/finance/bank-feed-view-state"

const parse = (q: string) => parseFeedView(new URLSearchParams(q))

describe("parseFeedView", () => {
  it("is the default for a plain address", () => {
    expect(parse("tab=bank")).toEqual(DEFAULT_FEED_VIEW)
  })

  it("reads the filter, a human page number (1 = first), the search and the sources", () => {
    expect(parse("bf=needs_review&bp=3&bq=MM%20Digital&bs=stripe,mercury_api")).toEqual({
      filter: "needs_review", page: 2, search: "MM Digital", sources: ["stripe", "mercury_api"],
    })
  })

  it("falls back to the default for anything it does not recognise", () => {
    expect(parse("bf=hacked").filter).toBe("all")
    expect(parse("bp=0").page).toBe(0)
    expect(parse("bp=-4").page).toBe(0)
    expect(parse("bp=abc").page).toBe(0)
    expect(parse("bs=<script>,,x y").sources).toBeNull()
  })

  it("caps the page and the search length", () => {
    expect(parse("bp=999999999").page).toBe(9999)
    expect(parse(`bq=${"a".repeat(500)}`).search).toHaveLength(100)
  })

  it("keeps only valid source names out of a mixed list", () => {
    expect(parse("bs=stripe,BAD NAME,relay").sources).toEqual(["stripe", "relay"])
  })
})

describe("writeFeedView", () => {
  const view = (over: Partial<FeedViewState>): FeedViewState => ({ ...DEFAULT_FEED_VIEW, ...over })

  it("writes nothing for the default view, so an untouched list keeps a clean address", () => {
    expect(writeFeedView("tab=bank", DEFAULT_FEED_VIEW)).toBe("tab=bank")
    expect(writeFeedView("", DEFAULT_FEED_VIEW)).toBe("")
  })

  it("keeps the tab and a deep-link feed id that are already in the address", () => {
    const q = writeFeedView("tab=bank&feed=abc", view({ filter: "needs_review", page: 4 }))
    const p = new URLSearchParams(q)
    expect(p.get("tab")).toBe("bank")
    expect(p.get("feed")).toBe("abc")
    expect(p.get("bf")).toBe("needs_review")
    expect(p.get("bp")).toBe("5")
  })

  it("removes a part when it goes back to the default", () => {
    const q = writeFeedView("tab=bank&bf=matched&bp=2&bq=x&bs=stripe", DEFAULT_FEED_VIEW)
    expect(q).toBe("tab=bank")
  })

  it("round-trips: what is written is read back the same", () => {
    const v = view({ filter: "unmatched", page: 7, search: "Simone Fattor & co", sources: ["airwallex_api"] })
    expect(parse(writeFeedView("tab=bank", v))).toEqual(v)
  })

  it("trims a blank search and never writes an empty source list", () => {
    expect(writeFeedView("", view({ search: "   ", sources: [] }))).toBe("")
  })
})
