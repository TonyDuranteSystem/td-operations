import { describe, it, expect } from "vitest"
import {
  DEFAULT_BUCKET,
  clampLimit,
  cleanText,
  parseParams,
  toQueryString,
  withBucket,
  withMore,
  withService,
  withStep,
} from "@/lib/new-calendar/params"
import { firstNameOf, greetingWord, workTodayText } from "@/lib/new-calendar/greeting"
import { MAX_LIMIT, MAX_TEXT_LENGTH, PAGE_SIZE } from "@/lib/new-calendar/types"

/** New Calendar — the web address is the page's only state, and it is typed by strangers: parse it defensively. */

describe("parseParams", () => {
  it("defaults to the To work on list, no service, no step, no search, one page", () => {
    expect(parseParams({})).toEqual({ b: "work", s: "", st: "", q: "", n: PAGE_SIZE })
  })

  it("accepts the four list names (any case) and falls back to the default for anything else", () => {
    expect(parseParams({ b: "closed" }).b).toBe("closed")
    expect(parseParams({ b: " PENDING " }).b).toBe("pending")
    expect(parseParams({ b: "other" }).b).toBe("other")
    for (const bad of ["", "everything", "work,pending", "__proto__", "constructor", "1"]) {
      expect(parseParams({ b: bad }).b).toBe(DEFAULT_BUCKET)
    }
  })

  it("takes the first value of a repeated parameter and ignores arrays of nothing", () => {
    expect(parseParams({ s: ["Alpha", "Beta"] }).s).toBe("Alpha")
    expect(parseParams({ s: [] }).s).toBe("")
    expect(parseParams({ q: undefined }).q).toBe("")
  })

  it("caps and cleans text, folds curly apostrophes, collapses spaces", () => {
    expect(parseParams({ q: "x".repeat(500) }).q).toHaveLength(MAX_TEXT_LENGTH)
    expect(cleanText("  O’Brien    &  Sons ")).toBe("O'Brien & Sons")
  })

  it("a step needs its service", () => {
    expect(parseParams({ st: "One" }).st).toBe("")
    expect(parseParams({ s: "Alpha", st: "One" })).toMatchObject({ s: "Alpha", st: "One" })
  })

  it("clamps the row limit between one page and the ceiling and survives non-numbers", () => {
    expect(parseParams({ n: "5" }).n).toBe(PAGE_SIZE)
    expect(parseParams({ n: "-20" }).n).toBe(PAGE_SIZE)
    expect(parseParams({ n: "abc" }).n).toBe(PAGE_SIZE)
    expect(parseParams({ n: "1e9" }).n).toBe(PAGE_SIZE)
    expect(parseParams({ n: "999999" }).n).toBe(MAX_LIMIT)
    expect(clampLimit(Number.NaN)).toBe(PAGE_SIZE)
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(PAGE_SIZE)
  })
})

describe("toQueryString and the helpers", () => {
  it("is empty for the defaults and round-trips everything else", () => {
    expect(toQueryString(parseParams({}))).toBe("")
    const p = { b: "pending" as const, s: "Alpha", st: "One", q: "Acme & Sons", n: 100 }
    expect(parseParams(Object.fromEntries(new URLSearchParams(toQueryString(p)).entries()))).toEqual(p)
  })

  it("never writes a step without its service", () => {
    expect(toQueryString({ b: "work", s: "", st: "One", q: "", n: PAGE_SIZE })).toBe("")
  })

  it("choosing a list clears service, step and paging but keeps the search", () => {
    expect(withBucket({ b: "work", s: "Alpha", st: "One", q: "acme", n: 150 }, "closed")).toEqual({ b: "closed", s: "", st: "", q: "acme", n: PAGE_SIZE })
  })

  it("choosing a service clears the step and the paging; choosing the same step again clears it", () => {
    expect(withService({ b: "work", s: "Alpha", st: "One", q: "", n: 150 }, "Beta")).toEqual({ b: "work", s: "Beta", st: "", q: "", n: PAGE_SIZE })
    expect(withStep({ b: "work", s: "Alpha", st: "One", q: "", n: 100 }, "One").st).toBe("")
    expect(withStep({ b: "work", s: "Alpha", st: "", q: "", n: 100 }, "One")).toMatchObject({ st: "One", n: PAGE_SIZE })
  })

  it("'show more' adds a page and stops at the ceiling", () => {
    expect(withMore(parseParams({}) ).n).toBe(PAGE_SIZE * 2)
    expect(withMore({ ...parseParams({}), n: MAX_LIMIT }).n).toBe(MAX_LIMIT)
  })
})

describe("greeting", () => {
  it("uses the login's full name, then its name, then the part of the email before the first dot or dash", () => {
    expect(firstNameOf({ email: "x@y.us", user_metadata: { full_name: "Luca Bianchi" } })).toBe("Luca")
    expect(firstNameOf({ email: "x@y.us", user_metadata: { name: "  antonio  " } })).toBe("antonio")
    expect(firstNameOf({ email: "antonio.durante@tonydurante.us", user_metadata: {} })).toBe("Antonio")
    expect(firstNameOf({ email: "LUCA-b@x.us" })).toBe("Luca")
  })

  it("gives no name rather than a wrong one", () => {
    expect(firstNameOf(null)).toBe("")
    expect(firstNameOf({ email: "" })).toBe("")
    expect(firstNameOf({ email: "1234@x.us" })).toBe("")
    expect(firstNameOf({ email: "support@tonydurante.us", user_metadata: { full_name: 42 } })).toBe("Support")
  })

  it("says morning, afternoon or evening by the New York clock", () => {
    expect(greetingWord(new Date("2026-10-16T12:00:00Z"))).toBe("Good morning") // 8am ET
    expect(greetingWord(new Date("2026-10-16T17:00:00Z"))).toBe("Good afternoon") // 1pm ET
    expect(greetingWord(new Date("2026-10-16T23:30:00Z"))).toBe("Good evening") // 7:30pm ET
    expect(greetingWord(new Date("2026-10-16T04:30:00Z"))).toBe("Good morning") // 12:30am ET
  })

  it("counts the day's work in plain words", () => {
    expect(workTodayText(0)).toBe("Nothing to work on today")
    expect(workTodayText(1)).toBe("1 job to work on today")
    expect(workTodayText(12)).toBe("12 jobs to work on today")
  })
})
