/**
 * The "what finishing this closure will do" brief shown in the ask-first question (Company Closure Part C, dev job a6bbea09).
 *
 * Before: the question said "Finishing this job CLOSES THE COMPANY in the CRM…" without saying WHICH company, how many services,
 * invoices or deadlines go with it, or that the client had written a DIFFERENT company in the wizard. Now the question names the
 * company and lists what really happens, so staff can answer "no" and collect an unpaid invoice first, or fix the link.
 *
 * Pure — no database. The facts are read by lib/operations/close-company.ts; this turns them into plain-English lines.
 */

export interface ClosingBrief {
  companyName: string
  /** the company is already Closed (finishing again changes nothing) */
  alreadyClosed: boolean
  /** the company's other open services (active / on hold / blocked), excluding this job */
  openServices: Array<{ type: string; status: string }>
  pendingDeadlines: number
  /** unpaid invoices (Pending / Overdue, nothing received) that will be cancelled, grouped by currency — what is still OWED, not the full amount */
  unpaid: { count: number; totals: Record<string, number> }
  /** invoices with money already received: NOT cancelled by closing — staff settle or refund them by hand (lib/closure/closing-payments.ts) */
  partPaid?: Array<{ invoice: string; paid: number; owed: number; currency: string }>
  /** unused credit notes (a client credit, a negative amount): not invoices, NOT cancelled, grouped by currency */
  credits?: { count: number; totals: Record<string, number> }
  /** open to-dos of the company other than this job's own */
  openTasks: number
  /** people still linked to the company: they lose their portal access to it */
  members: number
  hasLease: boolean
  /** the staff line the closure wizard left when the client wrote a different company than the one this job is linked to (the text after "CHECK:") */
  checkNote: string | null
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€" }

function money(currency: string, amount: number): string {
  const sym = SYMBOL[currency.toUpperCase()]
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2)
  return sym ? `${sym}${n}` : `${n} ${currency.toUpperCase()}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** One line: the company this closes. */
export function closingHeadline(b: ClosingBrief): string {
  return b.alreadyClosed
    ? `${b.companyName} is already Closed — finishing this job only tidies up what is still open for it.`
    : `Finishing this job closes ${b.companyName}.`
}

/** The bullet lines under the headline, only the ones that apply. */
export function closingBriefLines(b: ClosingBrief): string[] {
  const lines: string[] = []
  if (b.openServices.length > 0) {
    lines.push(`${plural(b.openServices.length, "other service", "other services")} will be cancelled: ${b.openServices.map((s) => `${s.type}${s.status === "active" ? "" : ` (${s.status.replace(/_/g, " ")})`}`).join(", ")}.`)
  }
  if (b.unpaid.count > 0) {
    const sums = Object.entries(b.unpaid.totals).map(([cur, amt]) => money(cur, amt)).join(" + ")
    lines.push(`${plural(b.unpaid.count, "unpaid invoice", "unpaid invoices")}${sums ? ` (${sums})` : ""} will be cancelled — collect first if it is still owed.`)
  }
  for (const p of b.partPaid ?? []) {
    lines.push(`Invoice ${p.invoice} is part-paid (${money(p.currency, p.paid)} of ${money(p.currency, Math.round((p.paid + p.owed) * 100) / 100)} received, ${money(p.currency, p.owed)} still owed) — it will NOT be cancelled: settle or refund it by hand.`)
  }
  if (b.credits && b.credits.count > 0) {
    const sums = Object.entries(b.credits.totals).map(([cur, amt]) => money(cur, amt)).join(" + ")
    lines.push(`${plural(b.credits.count, "unused credit note", "unused credit notes")}${sums ? ` (${sums})` : ""} ${b.credits.count === 1 ? "stays" : "stay"} on the account — a credit is not an invoice, so closing does not cancel it.`)
  }
  if (b.pendingDeadlines > 0) lines.push(`${plural(b.pendingDeadlines, "upcoming deadline", "upcoming deadlines")} will be cancelled.`)
  if (b.openTasks > 0) lines.push(`${plural(b.openTasks, "open to-do", "open to-dos")} of the company will be cancelled.`)
  if (!b.alreadyClosed && b.members > 0) lines.push(`${plural(b.members, "person", "people")} linked to the company will lose portal access to it.`)
  if (!b.alreadyClosed && b.hasLease) lines.push("The company has a mailing-address lease — a to-do is created to cancel it.")
  return lines
}

/** The warning shown in red when the wizard named another company: the text staff already saw on the job. */
export function closingWarning(b: ClosingBrief): string | null {
  const t = (b.checkNote ?? "").trim()
  return t ? t : null
}
