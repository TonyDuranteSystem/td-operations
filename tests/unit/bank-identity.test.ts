import { describe, it, expect } from "vitest"
import {
  resolveInstitution,
  normalizeAccountNumber,
  accountLast4,
  buildAccountRef,
  INSTITUTION_SEED,
  type InstitutionEntry,
} from "@/lib/tax/bank-identity"

describe("resolveInstitution — alias collapse (the split bug)", () => {
  it("collapses Chase's legal name and variants to one canonical", () => {
    for (const name of ["Chase", "JPMorgan Chase Bank, N.A.", "JPMORGAN CHASE BANK NA", "JP Morgan", "chase"]) {
      const r = resolveInstitution(name)
      expect(r.canonical).toBe("Chase")
      expect(r.mode).toBe("account_number")
      expect(r.matched).toBe(true)
    }
  })

  it("collapses Slash's legal name to Slash", () => {
    expect(resolveInstitution("Slash Financial, Inc.").canonical).toBe("Slash")
    expect(resolveInstitution("Slash").canonical).toBe("Slash")
  })

  it("collapses Kraken's legal name (Payward) to Kraken and marks it crypto", () => {
    const r = resolveInstitution("Kraken (Payward Interactive, Inc.)")
    expect(r.canonical).toBe("Kraken")
    expect(r.mode).toBe("crypto")
    expect(resolveInstitution("Payward Interactive").canonical).toBe("Kraken")
  })
})

describe("resolveInstitution — identity modes (Antonio's three buckets)", () => {
  it("US banks/fintechs are account_number mode", () => {
    for (const n of ["Bank of America", "BofA", "Wells Fargo", "Mercury", "Relay", "Brex", "Slash"]) {
      expect(resolveInstitution(n).mode).toBe("account_number")
    }
  })
  it("multi-currency services are currency mode (no account number)", () => {
    for (const n of ["Wise", "TransferWise", "Airwallex", "Revolut", "Payoneer"]) {
      expect(resolveInstitution(n).mode).toBe("currency")
    }
  })
  it("exchanges are crypto mode", () => {
    expect(resolveInstitution("Coinbase").mode).toBe("crypto")
    expect(resolveInstitution("Kraken").mode).toBe("crypto")
  })
})

describe("resolveInstitution — SAFETY: never merge two different banks", () => {
  it("does not merge unrelated banks that share a substring", () => {
    // 'chase' must NOT match Charles Schwab or Chime
    expect(resolveInstitution("Charles Schwab").matched).toBe(false)
    expect(resolveInstitution("Chime").matched).toBe(false)
    expect(resolveInstitution("Charles Schwab").canonical).toBe("Charles Schwab")
  })

  it("unknown institutions are returned as-is, flagged, defaulted to account_number", () => {
    const r = resolveInstitution("Some Local Credit Union")
    expect(r.matched).toBe(false)
    expect(r.canonical).toBe("Some Local Credit Union")
    expect(r.mode).toBe("account_number") // assume a bank; UI offers the escape
  })

  it("the heuristic 'Bank' and generic 'unknown' names never match a real institution", () => {
    expect(resolveInstitution("Bank").matched).toBe(false)
    expect(resolveInstitution("unknown").matched).toBe(false)
  })

  it("empty / junk input is safe", () => {
    expect(resolveInstitution("").matched).toBe(false)
    expect(resolveInstitution("  ").canonical).toBe("")
  })
})

describe("resolveInstitution — legal-form variants (exact, punctuation-folded)", () => {
  it("folds punctuation/case so legal spellings resolve", () => {
    expect(resolveInstitution("Bank of America, N.A.").canonical).toBe("Bank of America")
    expect(resolveInstitution("BANK OF AMERICA NA").canonical).toBe("Bank of America")
    expect(resolveInstitution("Slash Financial, Inc.").canonical).toBe("Slash")
    expect(resolveInstitution("Wells Fargo Bank, N.A.").canonical).toBe("Wells Fargo")
  })
  it("a longer name with EXTRA words does NOT collapse (no over-merge)", () => {
    // "chase" appears, but this is a different institution — must stay as-is.
    expect(resolveInstitution("Chase County Credit Union").matched).toBe(false)
    expect(resolveInstitution("My Mercury").matched).toBe(false)
    expect(resolveInstitution("Mercury Systems Inc").matched).toBe(false)
  })
})

describe("normalizeAccountNumber / accountLast4", () => {
  it("normalizes separators and case so equivalent numbers match", () => {
    expect(normalizeAccountNumber("  1234-5678 ")).toBe("12345678")
    expect(normalizeAccountNumber("1234 5678")).toBe("12345678")
    expect(normalizeAccountNumber("ab-cd.ef")).toBe("ABCDEF")
  })
  it("blank stays blank", () => {
    expect(normalizeAccountNumber("")).toBe("")
    expect(normalizeAccountNumber(null)).toBe("")
    expect(normalizeAccountNumber(undefined)).toBe("")
  })
  it("last4 takes the trailing 4 alphanumerics", () => {
    expect(accountLast4("12345678")).toBe("5678")
    expect(accountLast4("12")).toBe("12")
    expect(accountLast4("****1234")).toBe("1234")
  })
})

describe("buildAccountRef — the engine grouping key", () => {
  it("US bank with account number → canonical#last4, needs number", () => {
    const r = buildAccountRef({ rawBankName: "JPMorgan Chase Bank, N.A.", accountNumber: "000123455678" })
    expect(r.account_ref).toBe("Chase#5678")
    expect(r.canonical).toBe("Chase")
    expect(r.needsAccountNumber).toBe(true)
  })

  it("two account numbers at the same bank produce distinct refs", () => {
    const a = buildAccountRef({ rawBankName: "Chase", accountNumber: "1111" })
    const b = buildAccountRef({ rawBankName: "Chase", accountNumber: "2222" })
    expect(a.account_ref).not.toBe(b.account_ref)
  })

  it("the same account under two different bank NAMES collapses to one ref (the bug)", () => {
    const viaShort = buildAccountRef({ rawBankName: "Chase", accountNumber: "5678" })
    const viaLegal = buildAccountRef({ rawBankName: "JPMorgan Chase Bank, N.A.", accountNumber: "5678" })
    expect(viaShort.account_ref).toBe(viaLegal.account_ref)
  })

  it("US bank WITHOUT a number yet (history) → canonical name alone, still heals the name split", () => {
    const short = buildAccountRef({ rawBankName: "Chase" })
    const legal = buildAccountRef({ rawBankName: "JPMorgan Chase Bank, N.A." })
    expect(short.account_ref).toBe("Chase")
    expect(legal.account_ref).toBe("Chase")
  })

  it("multi-currency service → canonical alone, no number needed (currency sub-divides)", () => {
    const r = buildAccountRef({ rawBankName: "Wise", accountNumber: "irrelevant" })
    expect(r.account_ref).toBe("Wise")
    expect(r.needsAccountNumber).toBe(false)
  })

  it("crypto → canonical alone, no number needed", () => {
    const r = buildAccountRef({ rawBankName: "Kraken (Payward Interactive, Inc.)" })
    expect(r.account_ref).toBe("Kraken")
    expect(r.needsAccountNumber).toBe(false)
  })

  it("unknown institution → flagged, defaults to needing a number", () => {
    const r = buildAccountRef({ rawBankName: "Tiny Local Bank", accountNumber: "9999" })
    expect(r.unknownInstitution).toBe(true)
    expect(r.needsAccountNumber).toBe(true)
    expect(r.account_ref).toBe("Tiny Local Bank#9999")
  })
})

describe("registry is data-driven (injectable)", () => {
  it("honors an injected registry over the seed", () => {
    const reg: InstitutionEntry[] = [{ canonical: "N26", mode: "account_number", matchTerms: ["n26", "n26 bank"] }]
    expect(resolveInstitution("N26", reg).canonical).toBe("N26")
    expect(resolveInstitution("N26 Bank", reg).canonical).toBe("N26")
    // seed institutions are absent from the injected registry
    expect(resolveInstitution("Chase", reg).matched).toBe(false)
  })
  it("the seed is non-empty and every entry has a canonical + terms", () => {
    expect(INSTITUTION_SEED.length).toBeGreaterThan(5)
    for (const e of INSTITUTION_SEED) {
      expect(e.canonical.length).toBeGreaterThan(0)
      expect(e.matchTerms.length).toBeGreaterThan(0)
    }
  })
})
