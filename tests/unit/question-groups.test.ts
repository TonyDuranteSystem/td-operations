import { describe, it, expect } from "vitest"
import { merchantRoot, groupUncategorized, categoryForAnswer, groupKeyRoot, rowDirection, GROUP_KEY_SEP, type UncategorizedRow } from "@/lib/tax/question-groups"

function row(id: string, description: string, amount: number, date = "2025-06-01"): UncategorizedRow {
  return { id, description, counterparty: null, amount, transaction_date: date, bank_name: "Mercury" }
}

describe("merchantRoot", () => {
  it("strips card suffixes, embedded dates, long digit runs, extra spaces", () => {
    expect(merchantRoot("Glovo ••1266")).toBe("Glovo")
    expect(merchantRoot("Glovo  ••7229")).toBe("Glovo")
    expect(merchantRoot("Foreign Exch Rt ADJ Fee 10/13 Talabat Dubai")).toBe("Foreign Exch Rt ADJ Fee Talabat Dubai")
    expect(merchantRoot("Card Purchase 12/25 Talabat Dubai Card 579")).toBe("Card Purchase Talabat Dubai Card 579")
  })
})

describe("groupUncategorized", () => {
  it("groups card variants under one merchant, sorts by count, sums totals", () => {
    const groups = groupUncategorized([
      row("a", "Glovo ••1266", -10),
      row("b", "Glovo ••7229", -20),
      row("c", "Glovo  ••1266", -5),
      row("d", "Netflix ••7229", -12),
    ])
    expect(groups[0].label).toBe("Glovo")
    expect(groups[0].count).toBe(3)
    expect(groups[0].total).toBe(-35)
    expect(groups[0].direction).toBe("out")
    expect(groups[0].transaction_ids.sort()).toEqual(["a", "b", "c"])
    expect(groups[1].label).toBe("Netflix")
  })

  it("splits a mixed merchant into one card per direction (PayPal incident class)", () => {
    const groups = groupUncategorized([row("a", "PayPal", -10), row("b", "PayPal", 100), row("c", "PayPal", 50)])
    expect(groups).toHaveLength(2)
    const inG = groups.find(g => g.direction === "in")!
    const outG = groups.find(g => g.direction === "out")!
    expect(inG.count).toBe(2)
    expect(inG.total).toBe(150)
    expect(inG.transaction_ids.sort()).toEqual(["b", "c"])
    expect(outG.count).toBe(1)
    expect(outG.total).toBe(-10)
    expect(inG.label).toBe("PayPal")
    expect(outG.label).toBe("PayPal")
    expect(inG.group_key).not.toBe(outG.group_key)
    expect(groupKeyRoot(inG.group_key)).toBe(groupKeyRoot(outG.group_key))
  })

  it("splits by currency so a card never sums EUR+USD into one total", () => {
    const groups = groupUncategorized([
      { ...row("a", "Stripe", -10), currency: "USD" },
      { ...row("b", "Stripe", -20), currency: "USD" },
      { ...row("c", "Stripe", -30), currency: "EUR" },
    ])
    expect(groups).toHaveLength(2)
    const usd = groups.find(g => g.currency === "USD")!
    const eur = groups.find(g => g.currency === "EUR")!
    expect(usd.total).toBe(-30)
    expect(eur.total).toBe(-30)
    expect(groupKeyRoot(usd.group_key)).toBe(groupKeyRoot(eur.group_key))
  })

  it("zero-amount rows count as money in (explicit rule), and '#' in a description never truncates the root", () => {
    expect(rowDirection(0)).toBe("in")
    expect(rowDirection(-0.01)).toBe("out")
    const groups = groupUncategorized([row("a", "Online Transfer transaction#: ref A", -10)])
    expect(groupKeyRoot(groups[0].group_key)).not.toContain(GROUP_KEY_SEP)
    expect(groupKeyRoot(groups[0].group_key).length).toBeGreaterThan("Online Transfer".length - 1)
  })

  it("empty description falls back to counterparty, then a placeholder", () => {
    const groups = groupUncategorized([
      { id: "a", description: "", counterparty: "ACME", amount: -1, transaction_date: "2025-01-01", bank_name: "X" },
      { id: "b", description: "", counterparty: null, amount: -1, transaction_date: "2025-01-01", bank_name: "X" },
    ])
    expect(groups.map(g => g.label).sort()).toEqual(["(no description)", "ACME"])
  })
})

describe("categoryForAnswer", () => {
  it("maps every plain-language answer to the right category", () => {
    expect(categoryForAnswer("business_expense")).toEqual({ category: "expense", subcategory: "client_confirmed" })
    expect(categoryForAnswer("personal_spending")).toEqual({ category: "distribution", subcategory: "personal_draw" })
    expect(categoryForAnswer("business_income")).toEqual({ category: "income", subcategory: "revenue" })
    expect(categoryForAnswer("owner_money_in")).toEqual({ category: "contribution", subcategory: "capital_contribution" })
    expect(categoryForAnswer("own_transfer")).toEqual({ category: "conversion", subcategory: "internal_transfer" })
    expect(categoryForAnswer("bank_fee")).toEqual({ category: "fee", subcategory: "bank_fee" })
    expect(categoryForAnswer("refund")).toEqual({ category: "refund", subcategory: "client_confirmed" })
    expect(categoryForAnswer("nonsense")).toBeNull()
  })
})

/**
 * THE SUSPECTED-OWNER MARK ON A CARD (2026-08-04).
 *
 * The mark says "the payee carries one of this company's members' surnames but
 * not their full name". It is what earns the card a place in "Needs your
 * decision" — the category is deliberately left alone. Two ways to get this
 * wrong, both of which tell a client something false about their own company:
 * speaking for rows that do not match, and stamping a name across a catch-all
 * bucket of unrelated payees.
 */
describe("groupUncategorized — the suspected-owner mark", () => {
  const marked = (id: string, description: string, amount: number, name: string | null): UncategorizedRow => ({
    id, description, counterparty: null, amount, transaction_date: "2025-06-01", bank_name: "Wise",
    category: "expense",
    notes: name ? `ask: possible payment to member ${name}` : "",
  })

  it("carries the suspected owner and the number of rows that match", () => {
    const [g] = groupUncategorized([
      marked("a", "Sent money to M. Finelli", -1000, "Gabriele Finelli"),
      marked("b", "Sent money to M. Finelli", -2000, "Gabriele Finelli"),
    ])
    expect(g.suspected_members).toEqual(["Gabriele Finelli"])
    expect(g.suspected_count).toBe(2)
  })

  /**
   * `mode` skips empty values, so a single marked row among nine unmarked ones
   * would have WON outright and the card would have claimed all ten payments
   * went to that owner. A distinct list plus a count is the honest shape — the
   * card can then say "1 of these 10".
   */
  it("does not let one marked row speak for the whole group", () => {
    const rows = [marked("a", "ACME LTD", -100, "Gabriele Finelli")]
    for (let i = 0; i < 9; i++) rows.push(marked(`x${i}`, "ACME LTD", -100, null))
    const [g] = groupUncategorized(rows)
    expect(g.count).toBe(10)
    expect(g.suspected_count).toBe(1)
    expect(g.suspected_members).toEqual(["Gabriele Finelli"])
  })

  it("lists every distinct owner when a group could match more than one", () => {
    const [g] = groupUncategorized([
      marked("a", "Sent money to Finelli", -100, "Gabriele Finelli"),
      marked("b", "Sent money to Finelli", -100, "Matthew Finelli"),
    ])
    expect(g.suspected_members).toEqual(["Gabriele Finelli", "Matthew Finelli"])
  })

  /**
   * A catch-all bucket ("(no description)", bare card/spend) holds rows with
   * nothing in common. An earlier cut HID the owner question there so an
   * owner's name could not be stamped across unrelated payees — but that meant
   * the question was raised in the data and asked of NOBODY, and 1,271
   * outgoing payments on production have a description that weak.
   *
   * It is shown now, because the two things that made hiding necessary are
   * gone: the card states how many of the group's payments actually match, and
   * the answer targets only those ids.
   */
  it("still asks the question inside a catch-all bucket, honestly scoped", () => {
    const [g] = groupUncategorized([
      marked("a", "", -100, "Gabriele Finelli"),
      marked("b", "", -200, null),
    ])
    expect(g.count).toBe(2)
    expect(g.suspected_count).toBe(1)
    expect(g.suspected_members).toEqual(["Gabriele Finelli"])
  })

  it("leaves ordinary groups with no mark at all", () => {
    const [g] = groupUncategorized([marked("a", "Aurora Global Holdings Limited", -4000, null)])
    expect(g.suspected_members).toBeUndefined()
  })
})

/**
 * THE OWNER QUESTION ANSWERS ONLY THE FLAGGED PAYMENTS.
 *
 * A card can mix flagged and unflagged payments — the payee often lives in the
 * counterparty while the group's name comes from the description. Booking the
 * whole group on a "yes" turns real supplier payments into withdrawals on a
 * partner's K-1, so the flagged ids travel separately.
 */
describe("groupUncategorized — the flagged ids travel with the group", () => {
  const mk = (id: string, description: string, counterparty: string | null, name: string | null): UncategorizedRow => ({
    id, description, counterparty, amount: -1000, transaction_date: "2025-06-01", bank_name: "Relay",
    category: "expense", notes: name ? `ask: possible payment to member ${name}` : "",
  })

  it("carries only the flagged ids, not the whole group", () => {
    const [g] = groupUncategorized([
      mk("flagged", "WIRE OUT", "G FINELLI", "Gabriele Finelli"),
      mk("supplier-a", "WIRE OUT", "ACME LTD", null),
      mk("supplier-b", "WIRE OUT", "BOSCH GMBH", null),
    ])
    expect(g.count).toBe(3)
    expect(g.suspected_count).toBe(1)
    expect(g.suspected_ids).toEqual(["flagged"])
    // The merchant answer still covers the whole group — that is its job.
    expect(g.transaction_ids).toHaveLength(3)
  })

  it("has no flagged ids when nothing is flagged", () => {
    const [g] = groupUncategorized([mk("a", "ACME LTD", null, null)])
    expect(g.suspected_ids).toBeUndefined()
  })

  it("targets only the flagged payment inside a catch-all bucket", () => {
    const [g] = groupUncategorized([
      mk("flagged", "", null, "Gabriele Finelli"),
      mk("other", "", null, null),
    ])
    expect(g.suspected_ids).toEqual(["flagged"])
    expect(g.transaction_ids).toHaveLength(2)
  })
})

/**
 * "YES — <OWNER>" MUST ANSWER ONLY THAT OWNER'S PAYMENTS.
 *
 * The card shows one Yes button per suspected owner. A single flat id list
 * would post every marked row in the group, crediting one partner with
 * another's withdrawals on their capital account and K-1 — and this card
 * appears precisely when two owners share a surname, so that is the normal
 * case, not a corner.
 */
describe("groupUncategorized — flagged ids are grouped BY owner", () => {
  const ASK = 'ask: possible payment to member '
  const row = (id: string, amount: number, names: string[]) => ({
    id, description: 'Sent money to Finelli', counterparty: null, amount,
    transaction_date: '2025-06-01', bank_name: 'Wise', category: 'expense',
    notes: names.length ? ASK + names.join('; ') : '',
  })

  it("splits the ids per owner", () => {
    const [g] = groupUncategorized([
      row('gab', -18000, ['Gabriele Finelli']),
      row('mat', -4000, ['Matthew Finelli']),
    ])
    expect(g.suspected_count).toBe(2)
    expect(g.suspected_by_member).toEqual({
      'Gabriele Finelli': ['gab'],
      'Matthew Finelli': ['mat'],
    })
    // The whole-card list still exists, for "No — a supplier".
    expect(g.suspected_ids).toEqual(['gab', 'mat'])
  })

  it("a payment flagged for BOTH appears under both — the client decides", () => {
    const [g] = groupUncategorized([row('either', -5000, ['Gabriele Finelli', 'Matthew Finelli'])])
    expect(g.suspected_by_member).toEqual({
      'Gabriele Finelli': ['either'],
      'Matthew Finelli': ['either'],
    })
  })

  it("unflagged payments in the group belong to no owner", () => {
    const [g] = groupUncategorized([
      row('flagged', -1000, ['Gabriele Finelli']),
      row('supplier', -2000, []),
    ])
    expect(Object.values(g.suspected_by_member ?? {}).flat()).toEqual(['flagged'])
    expect(g.count).toBe(2)
  })
})

/**
 * AN ANSWER MUST STAY CHANGEABLE. The mark is consumed the moment the client
 * answers, so without carrying what they confirmed the buttons vanish — and a
 * mis-tap could then only be undone by tapping a merchant chip, which re-books
 * every payment on the card and writes a permanent merchant rule. Correcting
 * one attribution corrupted twenty other payments.
 */
describe("groupUncategorized — what the client already confirmed", () => {
  const confirmed = (id: string, who: string) => ({
    id, description: 'Sent money to Finelli', counterparty: null, amount: -9000,
    transaction_date: '2025-06-01', bank_name: 'Wise', category: 'distribution',
    subcategory: 'member_distribution', notes: `manual: client answer (owner_draw) | Member: ${who}`,
  })

  it("carries who was confirmed, and on which payments", () => {
    const [g] = groupUncategorized([
      confirmed('a', 'Gabriele Finelli'),
      confirmed('b', 'Gabriele Finelli'),
      confirmed('c', 'Matthew Finelli'),
    ])
    expect(g.confirmed_by_member).toEqual({
      'Gabriele Finelli': ['a', 'b'],
      'Matthew Finelli': ['c'],
    })
  })

  it("is absent when nothing has been confirmed", () => {
    const [g] = groupUncategorized([{
      id: 'x', description: 'ACME LTD', counterparty: null, amount: -100,
      transaction_date: '2025-06-01', bank_name: 'Wise', category: 'expense', notes: '',
    }])
    expect(g.confirmed_by_member).toBeUndefined()
  })

  it("a staff answer is carried the same way", () => {
    const [g] = groupUncategorized([{
      id: 's', description: 'Sent money to Finelli', counterparty: null, amount: -100,
      transaction_date: '2025-06-01', bank_name: 'Wise', category: 'distribution',
      notes: 'manual: staff answer (owner_draw) | Member: Gabriele Finelli',
    }])
    expect(g.confirmed_by_member).toEqual({ 'Gabriele Finelli': ['s'] })
  })

  it("an ordinary answer with no owner is not treated as confirmed", () => {
    const [g] = groupUncategorized([{
      id: 'p', description: 'Glovo', counterparty: null, amount: -30,
      transaction_date: '2025-06-01', bank_name: 'Wise', category: 'expense',
      notes: 'manual: client answer (business_expense)',
    }])
    expect(g.confirmed_by_member).toBeUndefined()
  })
})

/**
 * THE CHANGE BUTTONS MUST STILL OFFER THE OTHER OWNER. Answering "Yes —
 * Gabriele" consumes the mark on rows flagged for both brothers, so the open
 * suspects list empties — the recorded candidates are what keep "No — it was
 * Matthew" available.
 */
describe("groupUncategorized — confirmed answers keep their candidates", () => {
  it("carries the recorded alternatives", () => {
    const [g] = groupUncategorized([{
      id: 'a', description: 'Sent money to M. Finelli', counterparty: null, amount: -18000,
      transaction_date: '2025-06-01', bank_name: 'Wise', category: 'distribution',
      notes: 'manual: client answer (owner_draw) | Member: Gabriele Finelli | Of: Gabriele Finelli; Matthew Finelli',
    }])
    expect(g.confirmed_by_member).toEqual({ 'Gabriele Finelli': ['a'] })
    expect(g.confirmed_alternatives).toEqual(['Gabriele Finelli', 'Matthew Finelli'])
  })

  it("has no alternatives when none were recorded (single-candidate answer)", () => {
    const [g] = groupUncategorized([{
      id: 'a', description: 'Sent money to Berini', counterparty: null, amount: -500,
      transaction_date: '2025-06-01', bank_name: 'Wise', category: 'distribution',
      notes: 'manual: client answer (owner_draw) | Member: Donato Renato Berini',
    }])
    expect(g.confirmed_by_member).toEqual({ 'Donato Renato Berini': ['a'] })
    expect(g.confirmed_alternatives).toBeUndefined()
  })
})
