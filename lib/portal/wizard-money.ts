/**
 * Money fields in the portal wizards (dev job 89195c68, 2026-09-29).
 *
 * One walker, shared by the wizard's step gate / submit check (client) and
 * the wizard-submit backstop (server), so both sides agree on exactly which
 * keys are money amounts, which are visible, and what counts as a problem.
 *
 * A money field is a FieldConfig with `format: 'money'` — top-level, or a
 * repeater sub-field (stored flat as `${repeater}_${i}_${sub}`, rows 0..count-1
 * where count is `${repeater}_count`).
 *
 * Value states in form data: a settled amount is a NUMBER; while the client's
 * text is ambiguous ("80.000") or unreadable, the raw typed STRING is stored,
 * so the "not answered yet" state survives autosave, draft reload, Back and
 * repeater row shifts.
 */

import type { FieldConfig } from '@/components/portal/wizard/wizard-field'
import {
  checkStoredMoney,
  coerceMoneyValue,
  parseMoneyInput,
  type MoneyParseOptions,
  type StoredMoneyProblem,
} from '@/lib/money-input'

interface StepLike {
  id: string
}

// A conditional field is visible only if its condition matches AND its parent
// field is itself visible — the WHOLE ancestor chain must hold. Without this,
// a child kept demanding its upload after the grandparent flipped to No: the
// parent's stale answer stayed in the draft, the child checked only its direct
// parent, and Next blocked on an invisible field (crypto-CSV repro:
// answer 1099=No, then crypto=No). Moved here from wizard-client.tsx so the
// server backstop applies the identical rule.
export function isFieldVisible(
  field: FieldConfig,
  stepFields: FieldConfig[],
  data: Record<string, unknown>,
  depth = 0,
): boolean {
  if (!field.conditional || depth > 10) return true
  if (String(data[field.conditional.field]) !== field.conditional.value) return false
  const parent = stepFields.find(f => f.name === field.conditional!.field)
  return parent ? isFieldVisible(parent, stepFields, data, depth + 1) : true
}

/** Parser options for a money field: a field with `min: 0` (or any min ≥ 0)
 *  refuses negatives; a field with no min (the corp_* amounts) keeps accepting
 *  them, exactly as before. */
export function moneyOptionsFor(field: FieldConfig): MoneyParseOptions {
  return { allowNegative: field.min === undefined || field.min < 0, currency: 'USD', maxDecimals: 2 }
}

export interface MoneyKeyRef {
  key: string
  field: FieldConfig
  stepIndex: number
  visible: boolean
}

function repeaterCount(data: Record<string, unknown>, repeater: string): number {
  const n = Number(data[`${repeater}_count`])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Every money key for this wizard config, in step order, with its visibility
 * for the current data. Repeater rows beyond `${repeater}_count` are not
 * returned (deleted rows).
 */
export function listMoneyKeys(
  steps: StepLike[],
  fields: Record<string, FieldConfig[]>,
  data: Record<string, unknown>,
): MoneyKeyRef[] {
  const out: MoneyKeyRef[] = []
  steps.forEach((step, stepIndex) => {
    const stepFields = fields[step.id] || []
    for (const field of stepFields) {
      const visible = isFieldVisible(field, stepFields, data)
      if (field.type === 'repeater') {
        const moneySubs = (field.repeaterFields ?? []).filter(rf => rf.format === 'money')
        if (moneySubs.length === 0) continue
        const count = repeaterCount(data, field.name)
        for (let i = 0; i < count; i++) {
          for (const rf of moneySubs) {
            out.push({ key: `${field.name}_${i}_${rf.name}`, field: rf, stepIndex, visible })
          }
        }
        continue
      }
      if (field.format === 'money') out.push({ key: field.name, field, stepIndex, visible })
    }
  })
  return out
}

export interface MoneyProblem {
  key: string
  stepIndex: number
  problem: StoredMoneyProblem
  /** 'ambiguous' when the stored string is an unanswered "80.000"-style
   *  question, 'unreadable' when it simply can't be read. */
  detail?: 'ambiguous' | 'unreadable'
}

/** Problems on VISIBLE money keys only (a hidden field can never block). */
export function findMoneyProblems(
  steps: StepLike[],
  fields: Record<string, FieldConfig[]>,
  data: Record<string, unknown>,
): MoneyProblem[] {
  const problems: MoneyProblem[] = []
  for (const ref of listMoneyKeys(steps, fields, data)) {
    if (!ref.visible) continue
    const value = data[ref.key]
    const opts = moneyOptionsFor(ref.field)
    const problem = checkStoredMoney(value, opts)
    if (!problem) continue
    let detail: MoneyProblem['detail']
    if (problem === 'unanswered' && typeof value === 'string') {
      detail = parseMoneyInput(value, opts).kind === 'ambiguous' ? 'ambiguous' : 'unreadable'
    }
    problems.push({ key: ref.key, stepIndex: ref.stepIndex, problem, detail })
  }
  return problems
}

/**
 * Normalise money values before they are stored/sent:
 *  - a string that parses cleanly becomes a number (legacy "5000", "80,000")
 *  - an unsettled string on a HIDDEN field is cleared to '' so a pending
 *    question the client can no longer see never reaches the saved data / PDF
 * Returns a NEW object; the input is not mutated.
 */
export function normalizeMoneyData<T extends Record<string, unknown>>(
  steps: StepLike[],
  fields: Record<string, FieldConfig[]>,
  data: T,
  { clearHiddenPending }: { clearHiddenPending: boolean },
): T {
  const next: Record<string, unknown> = { ...data }
  for (const ref of listMoneyKeys(steps, fields, data)) {
    if (!(ref.key in next)) continue
    const opts = moneyOptionsFor(ref.field)
    const coerced = coerceMoneyValue(next[ref.key], opts)
    if (clearHiddenPending && !ref.visible && typeof coerced === 'string' && coerced !== '') {
      next[ref.key] = ''
    } else {
      next[ref.key] = coerced
    }
  }
  return next as T
}

/** Which step a (possibly flattened repeater) key lives on, or -1. */
export function stepIndexForKey(
  steps: StepLike[],
  fields: Record<string, FieldConfig[]>,
  key: string,
): number {
  for (let i = 0; i < steps.length; i++) {
    for (const f of fields[steps[i].id] || []) {
      if (f.name === key) return i
      if (f.type === 'repeater' && key.startsWith(`${f.name}_`)) {
        const rest = key.slice(f.name.length + 1)
        const m = /^\d+_(.+)$/.exec(rest)
        if (m && (f.repeaterFields ?? []).some(rf => rf.name === m[1])) return i
      }
    }
  }
  return -1
}

/** Bilingual message for a money problem (same wording client + server). */
export function moneyProblemMessage(p: Pick<MoneyProblem, 'problem' | 'detail'>, value?: unknown): { en: string; it: string } {
  switch (p.problem) {
    case 'negative':
      return { en: 'This amount cannot be negative.', it: 'Questo importo non può essere negativo.' }
    case 'too_many_decimals': {
      const v = value === undefined || value === null ? '' : String(value)
      return {
        en: `This amount has more than 2 decimals (${v}). Please check it and retype.`,
        it: `Questo importo ha più di 2 decimali (${v}). Controllalo e riscrivilo.`,
      }
    }
    case 'unanswered':
      if (p.detail === 'ambiguous') {
        return {
          en: 'Which amount did you mean? Choose one of the options under the box.',
          it: 'Quale importo intendevi? Scegli una delle opzioni sotto la casella.',
        }
      }
      return {
        en: "We couldn't read this amount. Type only the digits, e.g. 80000.",
        it: 'Non riusciamo a leggere questo importo. Scrivi solo le cifre, ad es. 80000.',
      }
    default:
      return {
        en: "We couldn't read this amount. Type only the digits, e.g. 80000.",
        it: 'Non riusciamo a leggere questo importo. Scrivi solo le cifre, ad es. 80000.',
      }
  }
}
