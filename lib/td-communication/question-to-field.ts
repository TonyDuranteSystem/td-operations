/**
 * TD Communication — DB questions → wizard config (pure, client-safe).
 *
 * Turns the operator-editable `td_comm_questions` rows into the `{ steps, fields }`
 * shape the portal wizard renders (the same shape `getWizardConfig` returns).
 * This is the bridge that makes the brand-audit wizard DB-driven: Cris edits the
 * questions in the CRM admin panel and the client wizard reflects them with no
 * code deploy.
 *
 * No DB / no I/O here — the page fetches the rows and calls this. Unit-tested in
 * tests/unit/td-comm-question-to-field.test.ts (R086).
 */

import type { FieldConfig } from '@/components/portal/wizard/wizard-field'
import type { WizardStep } from '@/components/portal/wizard/wizard-shell'
import { questionsForAudience } from './questions'
import type { TdCommQuestion, TdCommOption, QuestionAudience } from './types'

export interface TdCommWizardConfig {
  steps: WizardStep[]
  fields: Record<string, FieldConfig[]>
}

/** Bilingual title/description for each known step number. Fallback = "Step N". */
const TD_COMM_STEP_META: Record<number, { titleEn: string; titleIt: string }> = {
  1: { titleEn: 'Business & Strategy', titleIt: 'Business e Strategia' },
  2: { titleEn: 'Brand Personality', titleIt: 'Personalità del Brand' },
  3: { titleEn: 'Visual & Design', titleIt: 'Visual e Design' },
  4: { titleEn: 'Final Details', titleIt: 'Dettagli Finali' },
}

/** The mandatory confirmation checkbox appended to the final step. */
const DISCLAIMER_FIELD: FieldConfig = {
  name: 'disclaimer_accepted',
  label: 'I confirm this information is accurate',
  labelIt: 'Confermo che queste informazioni sono corrette',
  type: 'checkbox',
  required: true,
}

/** Fold an optional description into a label: "Label — description". */
function foldDesc(label: string, desc: string | null | undefined): string {
  const d = typeof desc === 'string' ? desc.trim() : ''
  return d ? `${label} — ${d}` : label
}

/** Map one option to the wizard's `{ value, label, labelIt }` shape (desc folded in). */
function optionToField(o: TdCommOption): { value: string; label: string; labelIt?: string } {
  const label = foldDesc(o.label_en, o.description_en)
  const labelIt = o.label_it ? foldDesc(o.label_it, o.description_it) : undefined
  return labelIt ? { value: o.value, label, labelIt } : { value: o.value, label }
}

/** Map one question row to a wizard FieldConfig. */
function questionToField(q: TdCommQuestion): FieldConfig {
  const field: FieldConfig = {
    name: q.key,
    label: q.label_en,
    type: q.type,
    required: q.required,
  }
  if (q.label_it) field.labelIt = q.label_it
  if (q.type === 'select' && q.options.length > 0) {
    field.options = q.options.map(optionToField)
  }
  // DB-driven ✨ Generate helper: the operator toggles ai_assist per question in
  // the CRM Questions editor (backfilled true for every textarea). Only textareas
  // render the button (wizard-field ignores the flag on other types), but we gate
  // here too so a mis-set flag on a non-textarea never lights it up.
  if (q.ai_assist && q.type === 'textarea') field.aiAssist = true
  return field
}

/**
 * Build the wizard `{ steps, fields }` from active questions for an audience.
 * Steps are derived dynamically from the distinct `step` numbers present (no
 * hardcoded step count); each step id is `step_<n>`. The disclaimer checkbox is
 * appended to the LAST (highest-numbered) step. Returns empty steps/fields when
 * there are no questions — the caller falls back to the code-side config.
 */
export function buildTdCommWizardConfig(
  questions: TdCommQuestion[],
  audience: QuestionAudience,
): TdCommWizardConfig {
  const applicable = questionsForAudience(questions, audience)
  if (applicable.length === 0) return { steps: [], fields: {} }

  // Distinct step numbers, ascending (questionsForAudience already sorts by
  // step then sort_order, so grouping preserves intra-step order).
  const stepNumbers: number[] = []
  const byStep = new Map<number, FieldConfig[]>()
  for (const q of applicable) {
    if (!byStep.has(q.step)) {
      byStep.set(q.step, [])
      stepNumbers.push(q.step)
    }
    byStep.get(q.step)!.push(questionToField(q))
  }
  stepNumbers.sort((a, b) => a - b)

  const lastStep = stepNumbers[stepNumbers.length - 1]
  byStep.get(lastStep)!.push(DISCLAIMER_FIELD)

  const steps: WizardStep[] = stepNumbers.map((n) => {
    const meta = TD_COMM_STEP_META[n]
    return {
      id: `step_${n}`,
      title: meta ? meta.titleEn : `Step ${n}`,
      titleIt: meta ? meta.titleIt : `Passo ${n}`,
    }
  })

  const fields: Record<string, FieldConfig[]> = {}
  for (const n of stepNumbers) fields[`step_${n}`] = byStep.get(n)!

  return { steps, fields }
}
