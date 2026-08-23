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
 * Every exported field/step config in wizard-configs.ts, whatever shape it
 * is exported as (a single FieldConfig, a FieldConfig[], a
 * Record<string, FieldConfig[]>, or a WizardStep[]) — walked generically
 * so a newly-added wizard is picked up automatically without editing this
 * file, rather than requiring every new export to be named here by hand.
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

  return out
}
