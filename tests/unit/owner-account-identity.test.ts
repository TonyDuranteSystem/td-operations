import { describe, it, expect } from "vitest"
import {
  mapPlaidAccountType,
  accountNumbersMatch,
  resolvePlaidTransactionAccount,
  findRegistryEntryForAccount,
  partitionAgainstManualBooks,
  type PlaidSubAccount,
  type OwnerAccountRegistryEntry,
  type ExistingManualRow,
} from "@/lib/owner-account-identity"

describe("mapPlaidAccountType", () => {
  it("maps depository/checking", () => {
    expect(mapPlaidAccountType("depository", "checking")).toBe("checking")
  })
  it("maps depository/savings", () => {
    expect(mapPlaidAccountType("depository", "savings")).toBe("savings")
  })
  it("maps credit/credit card", () => {
    expect(mapPlaidAccountType("credit", "credit card")).toBe("credit_card")
  })
  it("is case-insensitive", () => {
    expect(mapPlaidAccountType("Depository", "Checking")).toBe("checking")
  })
  it("returns null for a loan-shaped account (Plaid's transactions product has no clean equivalent)", () => {
    expect(mapPlaidAccountType("loan", "mortgage")).toBeNull()
  })
  it("returns null for an unrecognized subtype", () => {
    expect(mapPlaidAccountType("depository", "money market")).toBeNull()
  })
})

describe("accountNumbersMatch", () => {
  it("matches identical numbers", () => {
    expect(accountNumbersMatch("3920", "3920")).toBe(true)
  })
  it("matches when one is a suffix of the other", () => {
    expect(accountNumbersMatch("3920", "0003920")).toBe(true)
    expect(accountNumbersMatch("0003920", "3920")).toBe(true)
  })
  it("does not match different numbers", () => {
    expect(accountNumbersMatch("3920", "5820")).toBe(false)
  })
  it("never matches on blank/missing input, even blank-to-blank", () => {
    expect(accountNumbersMatch("", "")).toBe(false)
    expect(accountNumbersMatch(null, "3920")).toBe(false)
    expect(accountNumbersMatch("3920", undefined)).toBe(false)
  })
})

describe("resolvePlaidTransactionAccount", () => {
  const accounts: PlaidSubAccount[] = [
    { account_id: "plaid-1", mask: "3920", type: "depository", subtype: "checking" },
    { account_id: "plaid-2", mask: "9279", type: "credit", subtype: "credit card" },
    { account_id: "plaid-3", mask: null, type: "depository", subtype: "checking" },
    { account_id: "plaid-4", mask: "7363", type: "loan", subtype: "mortgage" },
    // A real Revolut Business item: two DIFFERENT sub-accounts (different account_id) sharing
    // the IDENTICAL mask, distinguished only by currency.
    { account_id: "plaid-5-usd", mask: "9805", type: "depository", subtype: "checking" },
    { account_id: "plaid-5-eur", mask: "9805", type: "depository", subtype: "checking" },
  ]

  it("resolves a checking account by its Plaid account_id", () => {
    expect(resolvePlaidTransactionAccount("plaid-1", accounts, "USD")).toEqual({ accountNumber: "3920", accountType: "checking", currency: "USD" })
  })
  it("resolves a credit card account", () => {
    expect(resolvePlaidTransactionAccount("plaid-2", accounts, "USD")).toEqual({ accountNumber: "9279", accountType: "credit_card", currency: "USD" })
  })
  it("returns null when the sub-account has no mask", () => {
    expect(resolvePlaidTransactionAccount("plaid-3", accounts, "USD")).toBeNull()
  })
  it("returns null when the type doesn't map cleanly (a loan)", () => {
    expect(resolvePlaidTransactionAccount("plaid-4", accounts, "USD")).toBeNull()
  })
  it("returns null for an account_id not in the list", () => {
    expect(resolvePlaidTransactionAccount("plaid-unknown", accounts, "USD")).toBeNull()
  })
  it("carries the transaction's own currency, uppercased, regardless of the sub-account", () => {
    expect(resolvePlaidTransactionAccount("plaid-1", accounts, "usd")?.currency).toBe("USD")
  })
  it("defaults to USD when Plaid gives no currency code", () => {
    expect(resolvePlaidTransactionAccount("plaid-1", accounts, "")?.currency).toBe("USD")
  })
  it("resolves the USD and EUR pockets of a same-mask multi-currency account to the SAME account number but DIFFERENT currency", () => {
    const usd = resolvePlaidTransactionAccount("plaid-5-usd", accounts, "USD")
    const eur = resolvePlaidTransactionAccount("plaid-5-eur", accounts, "EUR")
    expect(usd).toEqual({ accountNumber: "9805", accountType: "checking", currency: "USD" })
    expect(eur).toEqual({ accountNumber: "9805", accountType: "checking", currency: "EUR" })
  })
})

describe("findRegistryEntryForAccount", () => {
  const registry: OwnerAccountRegistryEntry[] = [
    { bank_name: "Chase checking 3920", account_number: "3920", account_type: "checking", sign_convention: "normal", currency: "USD" },
    { bank_name: "Firstcitizenbank checking 5820", account_number: "5820", account_type: "checking", sign_convention: "normal", currency: "USD" },
    { bank_name: "Amex credit card 51007", account_number: "51007", account_type: "credit_card", sign_convention: "inverted", currency: "USD" },
    { bank_name: "Revolut checking 9805", account_number: "9805", account_type: "checking", sign_convention: "normal", currency: "USD" },
  ]

  it("finds the exact registry row by number and type", () => {
    expect(findRegistryEntryForAccount({ accountNumber: "3920", accountType: "checking", currency: "USD" }, registry)?.bank_name)
      .toBe("Chase checking 3920")
  })

  it("returns null for a genuinely new account not yet in the registry", () => {
    expect(findRegistryEntryForAccount({ accountNumber: "1234", accountType: "checking", currency: "USD" }, registry)).toBeNull()
  })

  it("does not cross-match the same number under a different account type", () => {
    // Guards against a coincidental number collision between e.g. a checking and a card.
    expect(findRegistryEntryForAccount({ accountNumber: "3920", accountType: "credit_card", currency: "USD" }, registry)).toBeNull()
  })

  it("surfaces the inverted sign convention for the account that needs it", () => {
    expect(findRegistryEntryForAccount({ accountNumber: "51007", accountType: "credit_card", currency: "USD" }, registry)?.sign_convention)
      .toBe("inverted")
  })

  it("REGRESSION (2026-09-11 council finding): a EUR transaction on a mask registered as USD does NOT silently match the USD row", () => {
    // Revolut's real shape: the USD "9805" pocket is registered, the EUR "9805" pocket (same
    // mask, different Plaid account_id) is not. Before currency joined the match key, this
    // would have returned the USD row — filing EUR money into the USD books account.
    expect(findRegistryEntryForAccount({ accountNumber: "9805", accountType: "checking", currency: "EUR" }, registry)).toBeNull()
  })

  it("matches the registered currency pocket correctly even when another currency shares its number", () => {
    expect(findRegistryEntryForAccount({ accountNumber: "9805", accountType: "checking", currency: "USD" }, registry)?.bank_name)
      .toBe("Revolut checking 9805")
  })
})

describe("partitionAgainstManualBooks", () => {
  let nextId = 0
  // A fresh, unique id per call — real manual rows are always distinct database rows, and the
  // function now tracks WHICH specific row a duplicate consumed, so two calls must never
  // collide on id the way two calls with identical content otherwise would.
  const existing = (o: Partial<ExistingManualRow>): ExistingManualRow => ({
    id: `manual-${nextId++}`,
    transaction_date: "2026-09-01", amount: 100, currency: "USD", bank_name: "Chase checking 3920", ...o,
  })

  it("skips a Plaid transaction that exactly matches a hand-entered one", () => {
    const manualRow = existing({})
    const { toSync, skippedAsDuplicate } = partitionAgainstManualBooks(
      [existing({})],
      [manualRow],
    )
    expect(toSync).toHaveLength(0)
    expect(skippedAsDuplicate).toHaveLength(1)
    expect(skippedAsDuplicate[0].consumedManualRowId).toBe(manualRow.id)
  })

  it("keeps a transaction on a DIFFERENT account even with the same date/amount/currency", () => {
    const { toSync } = partitionAgainstManualBooks(
      [existing({ bank_name: "Firstcitizenbank checking 5820" })],
      [existing({ bank_name: "Chase checking 3920" })],
    )
    expect(toSync).toHaveLength(1)
  })

  it("MULTISET: two genuinely separate same-day same-amount transactions both survive when only one is already booked", () => {
    const { toSync, skippedAsDuplicate } = partitionAgainstManualBooks(
      [existing({}), existing({})],
      [existing({})],
    )
    expect(toSync).toHaveLength(1)
    expect(skippedAsDuplicate).toHaveLength(1)
  })

  it("keeps everything when nothing has been hand-entered yet", () => {
    const { toSync } = partitionAgainstManualBooks([existing({}), existing({ amount: 250 })], [])
    expect(toSync).toHaveLength(2)
  })

  it("a one-cent difference in amount is NOT treated as a match", () => {
    const { toSync } = partitionAgainstManualBooks(
      [existing({ amount: 100.01 })],
      [existing({ amount: 100 })],
    )
    expect(toSync).toHaveLength(1)
  })

  it("two identical-content candidates against two identical-content manual rows: both consume a distinct row, neither collides", () => {
    const manualA = existing({})
    const manualB = existing({})
    const { toSync, skippedAsDuplicate } = partitionAgainstManualBooks(
      [existing({}), existing({})],
      [manualA, manualB],
    )
    expect(toSync).toHaveLength(0)
    expect(skippedAsDuplicate).toHaveLength(2)
    expect(new Set(skippedAsDuplicate.map(m => m.consumedManualRowId))).toEqual(new Set([manualA.id, manualB.id]))
  })
})
