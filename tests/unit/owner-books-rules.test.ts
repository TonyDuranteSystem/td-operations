/**
 * The categorization rules decide what Tony Durante LLC's 2025 P&L says, so the
 * tests here are weighted to the ways a rule set silently lies:
 *   - a general rule swallowing a specific one (order),
 *   - a rule firing on the wrong side of the ledger (direction),
 *   - a rule firing on the wrong KIND of account (a card credit vs a bank deposit),
 *   - a catch-all quietly absorbing merchants nobody has looked at.
 *
 * Every merchant named below is a real one from the 2025 statements.
 */
import { describe, it, expect } from "vitest"
import { classifyOwnerTransaction, OWNER_BOOKS_RULES } from "@/lib/owner-books-rules"

const card = (d: string, a: number) => classifyOwnerTransaction(d, a, "credit_card")
const checking = (d: string, a: number) => classifyOwnerTransaction(d, a, "checking")

/**
 * Turn a rule's pattern back into a description that should match it — the first
 * alternative, with the regex syntax rendered as the literal text it stands for.
 * Used by the reachability test below to prove every rule is still reachable after
 * a new rule is added above it.
 */
function probeFor(re: RegExp): string {
  return re.source
    .split("|")[0]
    .replace(/\(([^)|]*)(\|[^)]*)?\)/g, "$1")  // (CTP|AUTFDR) -> CTP
    .replace(/\\s\*|\\s\+|\\s/g, " ")
    .replace(/(.)\?/g, "$1")                    // T-?MOBILE -> T-MOBILE
    .replace(/\\b/g, "")
    .replace(/\\(.)/g, "$1")                    // \. -> .   \* -> *
    .trim()
}

describe("cost of delivering the service is not overhead", () => {
  it("state filing fees are COGS", () => {
    // 141 of these in one year is client volume, not TD's own annual report.
    expect(card("WYOMING SECRETARY OF STAT", -62.25)).toMatchObject({
      category: "cogs", subcategory: "state_filing_fees",
    })
    expect(card("DELAWARE CORP &AMP; TAX WEB", -300)!.category).toBe("cogs")
    expect(card("NIC*-FL SUNBIZ.ORG", -71.87)!.category).toBe("cogs")
    expect(card("CORPORATE FILINGS LLC", -17.4)!.category).toBe("cogs")
  })
})

describe("the bank's own category is never inherited", () => {
  it("Facebook ad charges are advertising, though Chase files them as Professional Services", () => {
    // Chase's own Category column puts ~60 Meta charges under "Professional
    // Services". Inheriting that would report ad spend as consulting.
    expect(card("FACEBK *APF7JTLK62", -300)).toMatchObject({
      category: "expense", subcategory: "advertising",
    })
  })

  it("Wyoming filings are COGS, though Chase files them as Bills & Utilities", () => {
    expect(card("WYOMING SECRETARY OF STAT", -100)!.subcategory).toBe("state_filing_fees")
  })
})

describe("direction and account type", () => {
  it("paying the card down is a transfer, never income", () => {
    expect(card("PAYMENT THANK YOU-MOBILE", 1500)).toMatchObject({
      category: "transfer", subcategory: "card_payment",
    })
  })

  it("money back on a CARD is a refund", () => {
    // The real case: a $1,076 Root Insurance charge and its reversing credits.
    // Without this the card reports insurance it never paid.
    expect(card("ROOT INSURANCE", 1076)).toMatchObject({
      category: "refund", subcategory: "merchant_refund",
    })
    expect(card("INTUIT *QBooks Online", 65)!.category).toBe("refund")
  })

  it("the same charge going OUT keeps its real category", () => {
    expect(card("ROOT INSURANCE", -1076)!.category).toBe("expense")
    expect(card("INTUIT *QBooks Online", -65)!.subcategory).toBe("software")
  })

  it("CRITICAL: money into a CHECKING account is never a card refund", () => {
    // The refund rule matches any description, so it MUST be fenced to cards.
    // A bank deposit is income or a transfer — booking client money as a refund
    // would erase it from revenue entirely.
    const r = checking("ORIG CO NAME:TONY DURANTE LLC", 25000)
    expect(r?.category).not.toBe("refund")
    expect(checking("Zelle payment from ACTIVE ACRES", 5000)?.category).not.toBe("refund")
  })

  it("an unknown account type does not get the card rule either", () => {
    expect(classifyOwnerTransaction("SOME CREDIT", 500, null)?.category).not.toBe("refund")
  })
})

describe("order — a general rule must not swallow a specific one", () => {
  it("interest is a fee, not a generic card charge", () => {
    expect(card("PURCHASE INTEREST CHARGE", -22.41)).toMatchObject({
      category: "fee", subcategory: "interest",
    })
    expect(card("FOREIGN TRANSACTION FEE", -1.15)!.subcategory).toBe("bank_fee")
  })

  it("every rule's own examples still reach it", () => {
    // Guards the file's core promise: adding a broad rule above a narrow one is
    // the mistake that corrupted an earlier pass of this work. If a rule can no
    // longer be reached by its own words, this fails.
    const seen = new Set<string>()
    for (const rule of OWNER_BOOKS_RULES) {
      if (rule.match.source === ".*") continue // the deliberate card-refund catch-all
      const word = probeFor(rule.match)
      // A rule can legitimately exclude its own first alternative (the Zelle income
      // rule excludes Antonio's own name); skip those rather than fail them.
      if (rule.exclude?.test(word)) continue
      // Probe against a bank account unless the rule is card-only: the card
      // catch-all refund rule would otherwise answer for every inbound rule.
      const on = rule.accountTypes?.includes("credit_card") ? "credit_card" : "checking"
      const hit = classifyOwnerTransaction(word, rule.direction === "in" ? 100 : -100, on)
      expect(hit, `"${word}" should reach its own rule`).toBeTruthy()
      expect(`${hit!.category}/${hit!.subcategory}`).toBe(`${rule.category}/${rule.subcategory}`)
      seen.add(word)
    }
    expect(seen.size).toBeGreaterThan(8)
  })
})

describe("personal spending on a company card", () => {
  it("defaults to a distribution rather than a deduction", () => {
    // Deducting an unsubstantiated personal charge is the direction that costs
    // money if it is wrong, so the conservative side is the default.
    expect(card("SAGAZ MEN FASHION", -264.39)).toMatchObject({
      category: "distribution", subcategory: "owner_personal",
    })
    expect(card("TAGLIATELLA PRECIADOS", -93.53)!.category).toBe("distribution")
    expect(card("TAXI LIC 6029", -10.2)!.category).toBe("distribution")
  })
})

describe("what is deliberately NOT classified", () => {
  it("an unrecognised merchant stays uncategorized instead of landing in a bucket", () => {
    // No catch-all on the spending side: a merchant nobody has looked at must stay
    // visible, because a wrong classification hidden in a big bucket is never found.
    expect(card("SOME MERCHANT NOBODY HAS SEEN", -50)).toBeNull()
  })

  it("Wise moves money and is not booked as software", () => {
    // It sat in the software rule at first and would have been reported as an
    // expense. Left unmatched on purpose so it gets looked at.
    expect(card("Wise", -31)).toBeNull()
  })
})

describe("a spending rule can never fire on money coming IN", () => {
  it("client money settled by the payment processor is not a software expense", () => {
    // THE REAL ONE. Chase checking receives client money described as
    // "...FROM: Zoho Corporation ... ZOHO PAYMENTS ...", and the ZOHO
    // subscription pattern matched it. $25,321 of 2025 revenue would have been
    // recorded as a negative software expense — wrong twice over.
    const deposit = "REAL TIME PAYMENT CREDIT RECD FROM ABA/CONTR BNK-043000096 FROM: Zoho Corporation/STP FBO Zoho Corporati INFO: TEXT-RmtInf-ZOHO PAYMENTS | CREDIT | MISC_CREDIT"
    expect(checking(deposit, 1200.5)?.subcategory).not.toBe("software")
    expect(checking("ORIG CO NAME:ZOHO PAYMENTS ORIG ID:4270465600", 850)?.category).not.toBe("expense")
  })

  it("the same merchant going OUT is still the expense it always was", () => {
    expect(checking("ORIG CO NAME:ZOHO", -45)).toMatchObject({
      category: "expense", subcategory: "software",
    })
  })

  it("holds for every outflow category, not just software", () => {
    for (const [desc, amount] of [
      ["WYOMING SECRETARY OF STAT", 62.25],   // a refunded filing fee
      ["FACEBK *APF7JTLK62", 300],            // an ad credit
      ["PUBLIX 123", 40],                     // a grocery return
      ["FOREIGN TRANSACTION FEE", 1.15],      // a reversed fee
    ] as Array<[string, number]>) {
      const r = checking(desc, amount)
      expect(r === null || !["expense", "cogs", "fee", "distribution"].includes(r.category)).toBe(true)
    }
  })
})
