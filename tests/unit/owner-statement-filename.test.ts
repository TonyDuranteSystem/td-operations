/**
 * Statement filename → account identity.
 *
 * The account type decides the ACCOUNTING (a card and a loan are debts, not cash)
 * and the account number decides IDENTITY (three First Citizens accounts pass the
 * same $1,068.30 between them). Getting either wrong mis-states money silently,
 * so this module refuses rather than guesses — and these tests are weighted to the
 * refusals and to the two real bugs found by running it on Antonio's own files.
 */
import { describe, it, expect } from "vitest"
import {
  parseStatementFilename,
  detectAccountType,
  detectAccountNumber,
} from "@/lib/owner-statement-filename"

const ok = (n: string) => {
  const r = parseStatementFilename(n)
  if (!r.ok) throw new Error(`expected accept, got refusal: ${r.error?.problem}`)
  return r.value!
}
const refused = (n: string) => {
  const r = parseStatementFilename(n)
  if (r.ok) throw new Error(`expected refusal, got ${r.value?.label}`)
  return r.error!
}

describe("accepts Antonio's correctly-named files", () => {
  it("underscore-separated type is found (JS \\b does NOT break on '_')", () => {
    // The bug this caught: "_" is a word character, so /\bchecking\b/ failed to
    // match "Firstcitizenbank_checking_acc" and the file was refused for missing
    // a type it plainly stated.
    expect(ok("Firstcitizenbank_checking_acc#5820.csv")).toMatchObject({
      accountType: "checking",
      accountNumber: "5820",
    })
    expect(ok("Firstcitizenbank_Loan_acc#7363.csv").accountType).toBe("loan")
    expect(ok("firstcitizenbank_Checking_Acc#5812.csv").accountNumber).toBe("5812")
  })

  it("keeps looking past a year to find the real card number", () => {
    // The bug this caught: first-match stopped on the "Card 2025" in
    // "Amex_Credit_Card_2025_card#51007" and called the file ambiguous, never
    // reaching "card#51007".
    expect(ok("Amex_Credit_Card_2025_card#51007.csv")).toMatchObject({
      institution: "Amex",
      accountType: "credit_card",
      accountNumber: "51007",
    })
  })

  it("builds a per-ACCOUNT label, not a per-institution one", () => {
    // Cash Position groups balances by this label, so two accounts at one bank
    // must not share it.
    expect(ok("Credit_Card_Chase6094_Activity_20260829.csv").label).toBe("Chase credit card 6094")
    expect(ok("Firstcitizenbank_checking_acc#5820.csv").label).toBe("Firstcitizenbank checking 5820")
  })
})

describe("refuses rather than guessing", () => {
  it("refuses a file with no account type", () => {
    // Without the type it cannot know a card is debt rather than cash.
    expect(refused("Chase3920_Activity_20260108 (1).CSV").problem).toContain("account type")
    expect(refused("Amex acc#9245.csv").problem).toContain("account type")
    expect(refused("Relay 2025-01-01 #6770.csv").problem).toContain("account type")
  })

  // Antonio overruled the original strict behaviour on 2026-08-30: a human reads
  // "Credi_card" as a credit card, so this must too. The earlier version of this
  // test asserted a refusal — kept here inverted so the change of mind is visible.
  it("READS a misspelled type rather than refusing it", () => {
    const r = parseStatementFilename("Credi_card_Chase9279_Activity_20260829.csv")
    expect(r.ok).toBe(true)
    expect(r.value!.accountType).toBe("credit_card")
    expect(r.value!.institution).toBe("Chase")
  })

  it("refuses when the account number has a date fused onto it", () => {
    // "acc#45172025" is account 4517 + the year. Choosing between 4517 and
    // 45172025 is choosing whose money this is.
    const e = refused("MERCURY-acc#45172025-jan-01-to-2025-dec-31.csv")
    expect(e.problem).toContain("45172025")
    expect(e.problem).toMatch(/unclear/i)
  })

  it("refuses a file with neither type nor number", () => {
    expect(refused("2025 Stripe.csv").problem).toContain("account type")
    expect(refused("Airwallex_Balance_Activity_Report_2025-12-31.csv").problem).toContain("number")
  })

  it("always tells the operator how to rename it", () => {
    for (const n of ["2025 Stripe.csv", "Chase3920_Activity.CSV", "Amex acc#9245.csv"]) {
      expect(refused(n).suggestion).toMatch(/rename|separate/i)
    }
  })
})

describe("year-vs-account-number", () => {
  it("never takes a bare year as an account number", () => {
    expect(detectAccountNumber("Statement_2025.csv")).toBeNull()
    expect(detectAccountNumber("2025 Stripe.csv")).toBeNull()
  })

  it("still accepts a 4-digit number that is not a year", () => {
    expect(detectAccountNumber("Chase_checking_3920.csv")).toEqual({ value: "3920" })
  })
})

describe("type keywords", () => {
  it("does not treat a bare 'card' as a credit card", () => {
    // "card#51007" is a number marker. If bare "card" meant credit_card, a
    // checking export using that marker would be misclassified as debt.
    expect(detectAccountType("Amex_checking_card#9245.csv")).toBe("checking")
  })

  it("recognises the separator variants banks actually use", () => {
    for (const n of ["X_Credit_Card_1234.csv", "X credit card 1234.csv", "X-credit-card-1234.csv", "X_creditcard_1234.csv"]) {
      expect(detectAccountType(n)).toBe("credit_card")
    }
  })

  it("recognises savings and processor", () => {
    expect(detectAccountType("Ally_savings_4411.csv")).toBe("savings")
    expect(detectAccountType("Stripe_processor_0001.csv")).toBe("processor")
  })
})

describe("multi-currency wallets identified by currency", () => {
  it("accepts a currency code when the provider gives no account number", () => {
    // Airwallex's own export has 20 columns and none is an account id — the wallet
    // IS the currency. Refusing it would mean refusing a real account for lacking
    // something it does not have.
    const r = parseStatementFilename("Airwallex_checking_USD.csv")
    expect(r.ok).toBe(true)
    expect(r.value!.accountNumber).toBe("USD")
    expect(r.value!.label).toBe("Airwallex checking USD")
  })

  it("keeps the two wallets as separate accounts", () => {
    expect(parseStatementFilename("Airwallex_checking_USD.csv").value!.label)
      .not.toBe(parseStatementFilename("Airwallex_checking_EUR.csv").value!.label)
  })

  it("a real account number still wins over a currency in the name", () => {
    expect(parseStatementFilename("Chase_checking_3920_USD.csv").value!.accountNumber).toBe("3920")
  })

  it("only RECOGNISED currency codes count, not any three-letter word", () => {
    // Otherwise "Ally_checking_new.csv" would silently pass with account "NEW".
    expect(parseStatementFilename("Ally_checking_new.csv").ok).toBe(false)
  })
})

describe("tolerates the typos that actually happen", () => {
  it("reads 'Credi_card' as a credit card", () => {
    // Antonio, 2026-08-30: "if in credit a 't' is missing, it's obvious that is
    // credit card, don't be hardcoded but flexible."
    const r = parseStatementFilename("Credi_card_Chase_#9279.csv")
    expect(r.ok).toBe(true)
    expect(r.value!.accountType).toBe("credit_card")
    expect(r.value!.accountNumber).toBe("9279")
  })

  it("handles other realistic near-misses", () => {
    expect(detectAccountType("Chase_chekcing_1234.csv")).toBe("checking")   // transposed
    expect(detectAccountType("Chase_creditt_card_1234.csv")).toBe("credit_card") // doubled
    expect(detectAccountType("Ally_savngs_4411.csv")).toBe("savings")       // dropped
  })

  it("a bare # is enough to mark an account number", () => {
    // "#6094" without an "acc" prefix is obviously the account.
    expect(parseStatementFilename("Credit_Card_Chase_#6094.csv").value!.accountNumber).toBe("6094")
  })

  it("SHORT keywords stay exact — 'load' must never become a loan", () => {
    // At four characters one edit reaches ordinary words, and a wrong type changes
    // the accounting (a loan is debt, not cash).
    expect(detectAccountType("Chase_load_1234.csv")).toBeNull()
    expect(detectAccountType("Chase_lean_1234.csv")).toBeNull()
    expect(detectAccountType("Chase_loan_1234.csv")).toBe("loan")
  })

  it("does not invent a type from an unrelated word", () => {
    expect(detectAccountType("Chase_current_1234.csv")).toBeNull()
    expect(detectAccountType("Chase_2025_summary_1234.csv")).toBeNull()
  })
})
