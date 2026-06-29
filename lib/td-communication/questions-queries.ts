/**
 * TD Communication — questions data layer (server-side, service role).
 *
 * td_comm_questions is RLS ON with NO policy. supabaseAdmin (RLS bypass);
 * the API layer authorizes (staff read, admin write).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { shapeQuestion, type QuestionWriteInput } from './questions'
import type { TdCommQuestion } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const COLUMNS =
  'id, key, label_en, label_it, type, required, step, audience, options, active, sort_order, created_at, updated_at'

const PG_UNIQUE_VIOLATION = '23505'

/** All questions ordered by step then sort_order. Excludes inactive unless includeInactive. */
export async function listQuestions(opts: { includeInactive?: boolean } = {}): Promise<TdCommQuestion[]> {
  let q = db
    .from('td_comm_questions')
    .select(COLUMNS)
    .order('step', { ascending: true })
    .order('sort_order', { ascending: true })
  if (!opts.includeInactive) q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []).map(shapeQuestion)
}

export async function createQuestion(input: QuestionWriteInput): Promise<TdCommQuestion> {
  const now = new Date().toISOString()
  const row = {
    key: input.key,
    label_en: input.label_en,
    label_it: input.label_it ?? null,
    type: input.type ?? 'text',
    required: input.required ?? false,
    step: input.step ?? 1,
    audience: input.audience ?? 'both',
    options: input.options ?? [],
    active: input.active ?? true,
    sort_order: input.sort_order ?? 0,
    created_at: now,
    updated_at: now,
  }
  const { data, error } = await db.from('td_comm_questions').insert(row).select(COLUMNS).maybeSingle()
  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) throw new Error(`A question with key "${input.key}" already exists.`)
    throw new Error(error.message)
  }
  if (!data) throw new Error('Question was not created.')
  return shapeQuestion(data)
}

export async function updateQuestion(id: string, input: QuestionWriteInput): Promise<TdCommQuestion> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const fields: (keyof QuestionWriteInput)[] = [
    'key', 'label_en', 'label_it', 'type', 'required', 'step', 'audience', 'options', 'active', 'sort_order',
  ]
  for (const f of fields) {
    if (input[f] !== undefined) patch[f] = input[f]
  }
  const { data, error } = await db
    .from('td_comm_questions')
    .update(patch)
    .eq('id', id)
    .select(COLUMNS)
    .maybeSingle()
  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) throw new Error(`A question with key "${input.key}" already exists.`)
    throw new Error(error.message)
  }
  if (!data) throw new Error('Question not found.')
  return shapeQuestion(data)
}

/** Soft-delete (active=false). */
export async function softDeleteQuestion(id: string): Promise<void> {
  const { data, error } = await db
    .from('td_comm_questions')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Question not found.')
}
