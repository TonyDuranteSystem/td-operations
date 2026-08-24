import type { FieldConfig } from "@/components/portal/wizard/wizard-field"
import type { WizardStep } from "@/components/portal/wizard/wizard-shell"
import * as wizardConfigs from "@/components/portal/wizard/wizard-configs"
import { isExcludedFieldName, isExcludedWarningFieldName } from "@/lib/portal/translation-exclusions"

/**
 * Every translatable English phrase across every wizard's field/step
 * configuration (dev job 12cab351) — the second content source fed into
 * the shared AI translation engine (lib/portal/translation-generator.ts),
 * after the central portal dictionary.
 *
 * Keyed by the phrase's own English text (not a synthetic id): these are
 * short, self-contained UI strings, several of which repeat verbatim
 * across different wizards ("First Name", the generic disclaimer wording,
 * etc.) — reusing one translation for identical English text is the
 * correct behavior here, not a collision to avoid, and it means
 * wizard-configs.ts itself never has to be touched to add translation
 * support.
 *
 * MUST consult lib/portal/translation-exclusions.ts before adding any
 * field to the output — see that file for what's excluded and why. A
 * field named in EXCLUDED_WIZARD_FIELD_NAMES contributes NONE of its text
 * (label, placeholder, hint, options, danger) — the whole field is
 * off-limits, not just its label.
 */

function addIfPresent(out: Record<string, string>, text: string | undefined): void {
  if (text && text.trim()) out[text] = text
}

/** Walk one field (and its nested repeaterFields/options), collecting
 * every translatable string into `out`, unless the field's name is
 * excluded. warningOnValue is checked separately — it can be excluded even
 * on a field whose ordinary label/hint are fine to translate (e.g. the
 * $25,000 related-party-transaction warning). */
function collectField(field: FieldConfig, out: Record<string, string>): void {
  const fieldExcluded = isExcludedFieldName(field.name)

  if (!fieldExcluded) {
    addIfPresent(out, field.label)
    addIfPresent(out, field.placeholder)
    addIfPresent(out, field.hint)
    addIfPresent(out, field.repeaterAddLabel)
    addIfPresent(out, field.danger?.text)
    for (const opt of field.options ?? []) addIfPresent(out, opt.label)
  }

  if (field.warningOnValue?.text && !isExcludedWarningFieldName(field.name)) {
    addIfPresent(out, field.warningOnValue.text)
  }

  for (const sub of field.repeaterFields ?? []) collectField(sub, out)
}

function collectStep(step: WizardStep, out: Record<string, string>): void {
  addIfPresent(out, step.title)
  addIfPresent(out, step.description)
}

/** True for anything shaped like a FieldConfig (has a string `name` and `label`). */
function isFieldConfig(value: unknown): value is FieldConfig {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as FieldConfig).name === "string" &&
    typeof (value as FieldConfig).label === "string"
  )
}

function isWizardStep(value: unknown): value is WizardStep {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as WizardStep).id === "string" &&
    typeof (value as WizardStep).title === "string"
  )
}

/**
 * Static UI copy hardcoded directly in the two wizard rendering components —
 * toasts, validation messages, button labels, headers — as opposed to
 * FieldConfig-derived content (collected above by walking wizard-configs.ts).
 * These are literal strings with no source-of-truth data structure to walk,
 * so they're just listed here by hand, one entry per real pickText()/pick()
 * call site in those two files (dev job 12cab351, second migration pass,
 * 2026-08-24). Keyed by the phrase's own English text, same convention as
 * everything else in this file.
 *
 * Keep this list in sync with app/portal/wizard/wizard-client.tsx and
 * components/portal/wizard/wizard-field.tsx: a new pickText()/pick() call
 * site in either file needs its English string added here too, or that
 * phrase never gets translated for a language outside en/it.
 */
const WIZARD_UI_TEXT_EN: string[] = [
  // wizard-client.tsx — PrepareCsvStep
  '⚠️ Read this carefully before you start',
  'As part of your tax return, WE prepare your Profit & Loss (P&L) and Balance Sheet for you — the complete financial picture of your company.',
  'These are built directly from your bank statements, so they must be as accurate and complete as possible. If any transactions are missing, your P&L, Balance Sheet and tax return will be wrong.',
  '👉 Before you start the questionnaire, download ALL of your bank statements for the full year — for every bank and every currency — and save them on your device. You will upload them during this process.',
  'Tip: CSV is the most reliable format. Use the lookup below to see exactly how to download it from your bank.',
  'Which bank do you use? (e.g. Mercury, Wise, Chase, Revolut, Airwallex, Relay)',
  'Type your bank name…',
  'Finding instructions…',
  'Show me how to download the CSV',
  'How to download the CSV from {name}:',
  'Only have a PDF? Please still download the CSV from your bank — it’s the most reliable and fastest option. You’ll upload the files in the final step.',
  'I have read the above and I have downloaded all my bank statements for the full year.',
  // wizard-client.tsx — WizardClient
  'Could not generate a draft.',
  'Required field',
  'Value is not valid',
  'Confirm you have read the above and downloaded your statements to continue',
  'Ownership shares must total 100% (currently {pctSum}%)',
  'Add at least one entry',
  'Member ownership',
  'Draft saved',
  'Save failed',
  'Complete the highlighted fields to submit',
  'Select exactly {itinCount} person(s) to apply for the ITIN (you selected {chosen}).',
  'Select exactly one person as the SS-4 Responsible Party.',
  "All members' ownership must total 100% (currently {pctSum}%). Remember to include yourself as a member.",
  "Additional members' ownership must total more than 0% and less than 100% (currently {pctSum}%). The owner takes the remaining share.",
  'Data submitted successfully!',
  "Submit didn't go through after a few tries. Refresh the page — if it shows as already submitted, it worked.",
  'One question before we start',
  'Who will own the new company? You can change this by talking to us at any time.',
  'Just me',
  'A single owner',
  'Me and other owners',
  'You will add the other owners in the form',
  'Your details are with us',
  'We have started work on your company, so this form can no longer be edited. If something needs correcting, send us a message in chat and we will take care of it.',
  'Message us in chat',
  'Tax information reviewed',
  'Your tax information has been reviewed and is being processed. No further action is required from you.',
  'Back to Dashboard',
  '{bankLabel} — Application submitted!',
  'We are preparing your Profit & Loss and Balance Sheet from the files you uploaded — check them, answer any remaining questions, and confirm the numbers.',
  'Our team will review your information and contact you shortly.',
  'See your Profit & Loss and Balance Sheet →',
  'Continue with other banks →',
  'Re-submit',
  'Saved',
  'Already submitted — you can edit',
  "Your data has been submitted but not yet reviewed. You can update your answers until we begin the review.",
  'To continue, complete these fields:',
  'Member {n}',
  'Remove',
  'Member {n} is the SS-4 Responsible Party.',
  'Add member',
  '✓ Total ownership: {pctSum}%',
  'Total ownership: {pctSum}% — must equal 100%. Include every member, including yourself.',
  'SS-4 Responsible Party',
  'I will be the SS-4 Responsible Party.',
  'Exactly one person across the owner and members must be selected.',
  '(required)',
  '(optional)',
  'Add at least one entry to continue.',
  'No entries added yet.',
  "⚠️ Double-check the account number after you type it — if it's wrong, your P&L will be wrong.",
  'This is a multi-currency service or crypto (no single account number)',
  // wizard-field.tsx
  'Pre-filled',
  'Draft an answer with AI',
  'Drafting…',
  'Generate',
  'AI generation — coming soon',
  'Suggested draft',
  'Use this',
  'Add to my answer',
  'Regenerate',
  'Dismiss',
  'Select...',
  'Select country...',
  'Upload failed: {files}',
  'Uploading',
  'Uploading...',
  'Remove file',
  'This amount cannot be negative.',
  'Must be at least {min}.',
]

/**
 * Every exported field/step config in wizard-configs.ts, whatever shape it
 * is exported as (a single FieldConfig, a FieldConfig[], a
 * Record<string, FieldConfig[]>, or a WizardStep[]) — walked generically
 * so a newly-added wizard is picked up automatically without editing this
 * file, rather than requiring every new export to be named here by hand.
 * Merged with the hand-listed static UI copy above (WIZARD_UI_TEXT_EN) —
 * both are the "wizard" content source fed into the shared AI translation
 * engine.
 */
export function getWizardTranslatableText(): Record<string, string> {
  const out: Record<string, string> = {}

  for (const value of Object.values(wizardConfigs)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isFieldConfig(item)) collectField(item, out)
        else if (isWizardStep(item)) collectStep(item, out)
      }
    } else if (isFieldConfig(value)) {
      collectField(value, out)
    } else if (value && typeof value === "object") {
      // Record<string, FieldConfig[]>
      for (const fields of Object.values(value as Record<string, unknown>)) {
        if (!Array.isArray(fields)) continue
        for (const item of fields) {
          if (isFieldConfig(item)) collectField(item, out)
        }
      }
    }
  }

  for (const text of WIZARD_UI_TEXT_EN) out[text] = text

  return out
}
