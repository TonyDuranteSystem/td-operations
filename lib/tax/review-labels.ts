/**
 * An answer's name in the CLIENT's language, for the message and the banner that tell the client what to fix.
 *
 * Staff see the saved answers grouped and labelled by `describeAnswerKey` (English, derived from the key). The client's own
 * questionnaire has real labels (English + Italian) in its configuration; this finds the same field there so the client reads the
 * words they filled in. An answer the configuration does not know falls back to the English label from the key.
 */

import { TAX_FIELDS, TAX_MEMBER_FIELDS, TAX_MMLLC_FIELDS, TAX_CORP_FIELDS } from "@/components/portal/wizard/wizard-configs"
import type { FieldConfig } from "@/components/portal/wizard/wizard-field"
import { describeAnswerKey } from "@/lib/flows/submitted-data"

const ALL_TOP_LEVEL: FieldConfig[] = [
  ...Object.values(TAX_FIELDS).flat(),
  ...Object.values(TAX_MMLLC_FIELDS).flat(),
  ...Object.values(TAX_CORP_FIELDS).flat(),
]

const GROUP_IT: Record<string, string> = { member: "Membro", bank_account: "Conto bancario", bank_accounts: "Conto bancario" }

function pickLabel(f: FieldConfig | undefined, locale: "en" | "it"): string | null {
  if (!f) return null
  return locale === "it" && f.labelIt ? f.labelIt : f.label
}

export function resolveClientLabel(key: string, locale: "en" | "it"): string {
  const fallback = describeAnswerKey(key)
  // 1. a plain field: `comp_foreign_accounts`, `owner_first_name`, `formation_costs` …
  const direct = pickLabel(ALL_TOP_LEVEL.find((f) => f.name === key), locale)
  if (direct) return direct

  // 2. one member's field: `member_1_member_first_name` → the member configuration's field, with the member's number
  const mem = /^member_(\d+)_(.+)$/.exec(key)
  if (mem) {
    const label = pickLabel(TAX_MEMBER_FIELDS.find((f) => f.name === mem[2]), locale)
    if (label) return `${label} (${locale === "it" ? GROUP_IT.member : "Member"} ${Number(mem[1]) + 1})`
  }

  // 3. one row of a repeating list: `bank_accounts_0_bank_name` → that list's sub-field, with the row's number
  const rep = /^([a-z][a-z0-9_]*?)_(\d+)_(.+)$/.exec(key)
  if (rep) {
    const list = ALL_TOP_LEVEL.find((f) => f.name === rep[1] && f.repeaterFields)
    const label = pickLabel(list?.repeaterFields?.find((f) => f.name === rep[3]), locale)
    if (label) return `${label} (${locale === "it" ? GROUP_IT[rep[1]] ?? fallback.group.replace(/ \d+$/, "") : fallback.group.replace(/ \d+$/, "")} ${Number(rep[2]) + 1})`
  }

  // 4. unknown to the questionnaire: the English label the review screen showed
  return fallback.group.match(/ \d+$/) ? `${fallback.label} (${fallback.group})` : fallback.label
}
