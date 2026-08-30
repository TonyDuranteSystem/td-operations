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

  it("refuses a misspelled type instead of fuzzy-matching it", () => {
    // "Credi_card" — a typo. Guessing here risks classifying a checking export
    // as a credit card, which inverts the accounting.
    expect(refused("Credi_card_Chase9279_Activity_20260829.csv").problem).toContain("account type")
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
