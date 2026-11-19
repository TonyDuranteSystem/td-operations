/**
 * The installment amounts of an ANNUAL RENEWAL are not saved on the contract row: they live on the annual agreement
 * (`annual_agreements.cost_summary`, text such as "$1,000"). Pure.
 *
 * Two layouts exist in production (checked 2026-11-13): TWO groups ("First Installment (January)" then
 * "Second Installment (June)", each with one item and a total) and ONE group ("<year> Payment Schedule" with an item
 * per installment and the sum as total). Anything else is shown as saved lines and is not editable here.
 */
import { formatNumber, parseAmountInput } from './amount-input'

interface CostItem { name?: string; price?: string }
interface CostGroup { label?: string; total?: string; items?: CostItem[] }

export type RenewalLayout = 'two-groups' | 'one-group' | 'other'

export interface RenewalAmounts {
  layout: RenewalLayout
  /** the saved text for January / June, exactly as stored ("$1,000") */
  january: string | null
  june: string | null
  /** every saved line, for a layout this screen cannot edit */
  lines: string[]
  editable: boolean
}

const isJan = (s: unknown) => typeof s === 'string' && /jan|genn/i.test(s)
const isJun = (s: unknown) => typeof s === 'string' && /jun|giugn/i.test(s)

function groupsOf(costSummary: unknown): CostGroup[] {
  return Array.isArray(costSummary) ? (costSummary as CostGroup[]).filter((g) => g && typeof g === 'object') : []
}

export function readRenewalAmounts(costSummary: unknown): RenewalAmounts {
  const groups = groupsOf(costSummary)
  const lines = groups.flatMap((g) => [
    ...(g.items ?? []).map((i) => `${i.name ?? ''} ${i.price ?? ''}`.trim()),
    ...(g.total ? [`${g.label ?? 'Total'} ${g.total}`] : []),
  ])
  if (groups.length === 2 && isJan(groups[0].label) && isJun(groups[1].label)) {
    const a = groups[0].total ?? groups[0].items?.[0]?.price ?? null
    const b = groups[1].total ?? groups[1].items?.[0]?.price ?? null
    return { layout: 'two-groups', january: a, june: b, lines, editable: a != null && b != null }
  }
  if (groups.length === 1) {
    const items = groups[0].items ?? []
    if (items.length === 2 && isJan(items[0].name) && isJun(items[1].name)) {
      return { layout: 'one-group', january: items[0].price ?? null, june: items[1].price ?? null, lines, editable: items[0].price != null && items[1].price != null }
    }
  }
  return { layout: 'other', january: null, june: null, lines, editable: false }
}

/** "$1,000" -> 1000 for the form's starting value; null when the saved text cannot be read as one amount. */
export function amountFromSavedText(text: string | null): number | null {
  if (text == null) return null
  const p = parseAmountInput(text)
  return p.kind === 'ok' ? p.value : null
}

function symbolOf(text: string | null | undefined): string {
  const first = (text ?? '').trim().charAt(0)
  return first === '€' || first === '$' ? first : '$'
}

/**
 * A copy of the saved layout with January and June rewritten, written the way the agreement was ("$1,250").
 * Returns null when the layout is not one this screen can edit — nothing is guessed.
 */
export function applyRenewalAmounts(costSummary: unknown, january: number, june: number): unknown[] | null {
  const read = readRenewalAmounts(costSummary)
  if (!read.editable) return null
  const copy = JSON.parse(JSON.stringify(costSummary)) as CostGroup[]
  const symbol = symbolOf(read.january)
  const fmt = (n: number) => `${symbol}${formatNumber(n)}`
  if (read.layout === 'two-groups') {
    const values = [january, june]
    copy.forEach((g, i) => {
      if (g.total != null) g.total = fmt(values[i])
      if (g.items && g.items[0]) g.items[0].price = fmt(values[i])
    })
    return copy
  }
  // one group: an item per installment, the sum as the group total
  const g = copy[0]
  g.items![0].price = fmt(january)
  g.items![1].price = fmt(june)
  if (g.total != null) g.total = fmt(january + june)
  return copy
}
