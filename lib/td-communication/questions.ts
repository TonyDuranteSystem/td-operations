/**
 * TD Communication — brand-audit question validation + helpers (pure, client-safe).
 *
 * Questions are operator-editable (td_comm_questions). No server imports here;
 * the reads/writes live in ./questions-queries. Types in ./types.
 */

import type { TdCommQuestion, TdCommOption, QuestionFieldType, QuestionAudience } from './types'

export const QUESTION_TYPES: readonly QuestionFieldType[] = ['text', 'textarea', 'select', 'number', 'file']
export const QUESTION_AUDIENCES: readonly QuestionAudience[] = ['new_brand', 'rebrand', 'both']

/** lowercase snake/kebab key for form_data (e.g. "business_name"). */
const KEY_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/

/** Accepts either the object option shape or a legacy bare string. */
export type RawOption = TdCommOption | string

/**
 * Normalize one raw option into a `TdCommOption`. A bare string "X" becomes
 * `{ value: "X", label_en: "X" }` (legacy tolerance); an object is trimmed and
 * null-defaulted. Returns null when the option carries no usable value/label
 * (dropped by the caller) so a stray blank row never reaches the wizard.
 */
export function coerceOption(raw: unknown): TdCommOption | null {
  if (typeof raw === 'string') {
    const v = raw.trim()
    return v ? { value: v, label_en: v } : null
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const value = typeof o.value === 'string' ? o.value.trim() : ''
    const labelEnRaw = typeof o.label_en === 'string' ? o.label_en.trim() : ''
    // Fall back to value as the label, and to label as the value, so a
    // half-filled option still round-trips instead of vanishing.
    const value2 = value || labelEnRaw
    const labelEn = labelEnRaw || value
    if (!value2 && !labelEn) return null
    const str = (k: string): string | null => {
      const s = o[k]
      return typeof s === 'string' && s.trim() ? s.trim() : null
    }
    return {
      value: value2,
      label_en: labelEn || value2,
      label_it: str('label_it'),
      description_en: str('description_en'),
      description_it: str('description_it'),
    }
  }
  return null
}

/** Coerce a raw options array (mixed object/string) into clean `TdCommOption[]`. */
export function coerceOptions(raw: unknown): TdCommOption[] {
  if (!Array.isArray(raw)) return []
  return raw.map(coerceOption).filter((o): o is TdCommOption => o !== null)
}

export interface QuestionWriteInput {
  key?: string
  label_en?: string
  label_it?: string | null
  type?: QuestionFieldType
  required?: boolean
  step?: number
  audience?: QuestionAudience
  /** Object options; legacy bare strings still accepted and coerced on read. */
  options?: RawOption[]
  active?: boolean
  sort_order?: number
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate a question create/edit payload. On create, key is required and must
 * be a valid form_data key. options must be non-empty when type='select'.
 */
export function validateQuestionInput(
  input: QuestionWriteInput,
  opts: { isCreate: boolean },
): ValidationResult {
  const errors: string[] = []

  if (opts.isCreate || input.key !== undefined) {
    if (!input.key || !input.key.trim()) {
      errors.push('Key is required.')
    } else if (!KEY_RE.test(input.key)) {
      errors.push('Key must be lowercase letters, numbers, and single _ or - separators (e.g. "business_name").')
    }
  }

  if (opts.isCreate || input.label_en !== undefined) {
    if (!input.label_en || !input.label_en.trim()) errors.push('English label is required.')
  }

  if (input.type !== undefined && !QUESTION_TYPES.includes(input.type)) {
    errors.push('Type must be one of: text, textarea, select, number, file.')
  }
  if (input.audience !== undefined && !QUESTION_AUDIENCES.includes(input.audience)) {
    errors.push('Audience must be one of: new_brand, rebrand, both.')
  }
  if (input.step !== undefined && (!Number.isInteger(input.step) || input.step < 1)) {
    errors.push('Step must be a whole number ≥ 1.')
  }
  if (input.sort_order !== undefined && !Number.isInteger(input.sort_order)) {
    errors.push('Sort order must be a whole number.')
  }
  if (input.options !== undefined) {
    if (!Array.isArray(input.options)) {
      errors.push('Options must be a list.')
    } else {
      // Each option must be a non-empty string OR an object with a usable
      // value/label (coerceOption returns null for anything unusable).
      const bad = input.options.some((o) => coerceOption(o) === null)
      if (bad) errors.push('Each option needs a value and an English label.')
    }
  }
  // A select with no (usable) options is unusable.
  if (input.type === 'select') {
    const opts2 = coerceOptions(input.options ?? [])
    if (opts2.length === 0) errors.push('A "select" question needs at least one option.')
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Active questions for a given enrollment audience, sorted by step then sort_order.
 * 'both' questions always apply. This is what a future client wizard renders.
 */
export function questionsForAudience(
  questions: TdCommQuestion[],
  audience: QuestionAudience,
): TdCommQuestion[] {
  return questions
    .filter((q) => q.active && (q.audience === 'both' || q.audience === audience))
    .sort((a, b) => (a.step - b.step) || (a.sort_order - b.sort_order))
}

/** Shape a raw DB row into a typed question (defensive defaults). */
export function shapeQuestion(row: Record<string, unknown>): TdCommQuestion {
  return {
    id: String(row.id),
    key: String(row.key),
    label_en: String(row.label_en ?? ''),
    label_it: (row.label_it as string | null) ?? null,
    type: (row.type as QuestionFieldType) ?? 'text',
    required: Boolean(row.required),
    step: Number(row.step ?? 1),
    audience: (row.audience as QuestionAudience) ?? 'both',
    options: coerceOptions(row.options),
    active: row.active === undefined ? true : Boolean(row.active),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}
