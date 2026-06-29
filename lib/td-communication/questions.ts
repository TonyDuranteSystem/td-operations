/**
 * TD Communication — brand-audit question validation + helpers (pure, client-safe).
 *
 * Questions are operator-editable (td_comm_questions). No server imports here;
 * the reads/writes live in ./questions-queries. Types in ./types.
 */

import type { TdCommQuestion, QuestionFieldType, QuestionAudience } from './types'

export const QUESTION_TYPES: readonly QuestionFieldType[] = ['text', 'textarea', 'select', 'number', 'file']
export const QUESTION_AUDIENCES: readonly QuestionAudience[] = ['new_brand', 'rebrand', 'both']

/** lowercase snake/kebab key for form_data (e.g. "business_name"). */
const KEY_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/

export interface QuestionWriteInput {
  key?: string
  label_en?: string
  label_it?: string | null
  type?: QuestionFieldType
  required?: boolean
  step?: number
  audience?: QuestionAudience
  options?: string[]
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
    if (!Array.isArray(input.options) || input.options.some((s) => typeof s !== 'string')) {
      errors.push('Options must be a list of text values.')
    }
  }
  // A select with no options is unusable.
  if (input.type === 'select') {
    const opts2 = input.options ?? []
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
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    active: row.active === undefined ? true : Boolean(row.active),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}
