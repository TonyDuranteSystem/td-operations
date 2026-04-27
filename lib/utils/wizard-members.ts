/**
 * Shared utility for extracting MMLLC member data from wizard submissions.
 *
 * Two submission paths exist:
 *   A) Standalone formation/onboarding form → sends `additional_members: [...]` array
 *   B) Portal wizard → sends flat keys: `member_{index}_{field_name}`, plus `member_count`
 *
 * Both handlers (formation-setup.ts, onboarding-setup.ts) must use this utility
 * instead of checking `Array.isArray(submitted.additional_members)` directly.
 * The flat-key path was silently dropping all members (the array was always undefined).
 *
 * Returns a normalized array in both cases. member_type defaults to 'individual'
 * when not present (backward-compatible with submissions before Step 3 adds the toggle).
 */

export type NormalizedIndividualMember = {
  member_type: 'individual'
  member_first_name: string | null
  member_last_name: string | null
  member_email: string | null
  member_ownership_pct: number | null
  member_dob: string | null
  member_nationality: string | null
  member_street: string | null
  member_city: string | null
  member_state_province: string | null
  member_zip: string | null
  member_country: string | null
}

export type NormalizedCompanyMember = {
  member_type: 'company'
  member_company_name: string | null
  member_company_ein: string | null
  member_ownership_pct: number | null
  member_company_street: string | null
  member_company_city: string | null
  member_company_state: string | null
  member_company_zip: string | null
  member_company_country: string | null
  member_rep_name: string | null
  member_rep_email: string | null
  member_rep_phone: string | null
  member_rep_address_street: string | null
  member_rep_address_city: string | null
  member_rep_address_state: string | null
  member_rep_address_zip: string | null
  member_rep_address_country: string | null
}

export type NormalizedMember = NormalizedIndividualMember | NormalizedCompanyMember

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v).trim() || null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function normalizeFromObject(raw: Record<string, unknown>): NormalizedMember {
  const memberType = str(raw.member_type) === 'company' ? 'company' : 'individual'

  if (memberType === 'company') {
    return {
      member_type: 'company',
      member_company_name: str(raw.member_company_name),
      member_company_ein: str(raw.member_company_ein),
      member_ownership_pct: num(raw.member_ownership_pct),
      member_company_street: str(raw.member_company_street),
      member_company_city: str(raw.member_company_city),
      member_company_state: str(raw.member_company_state),
      member_company_zip: str(raw.member_company_zip),
      member_company_country: str(raw.member_company_country),
      member_rep_name: str(raw.member_rep_name),
      member_rep_email: str(raw.member_rep_email),
      member_rep_phone: str(raw.member_rep_phone),
      member_rep_address_street: str(raw.member_rep_address_street),
      member_rep_address_city: str(raw.member_rep_address_city),
      member_rep_address_state: str(raw.member_rep_address_state),
      member_rep_address_zip: str(raw.member_rep_address_zip),
      member_rep_address_country: str(raw.member_rep_address_country),
    }
  }

  return {
    member_type: 'individual',
    member_first_name: str(raw.member_first_name),
    member_last_name: str(raw.member_last_name),
    member_email: str(raw.member_email),
    member_ownership_pct: num(raw.member_ownership_pct),
    member_dob: str(raw.member_dob),
    member_nationality: str(raw.member_nationality),
    member_street: str(raw.member_street),
    member_city: str(raw.member_city),
    member_state_province: str(raw.member_state_province),
    member_zip: str(raw.member_zip),
    member_country: str(raw.member_country),
  }
}

/**
 * Extract additional members from a wizard submission payload.
 * Handles both the standalone form (array path) and portal wizard (flat key path).
 * Returns empty array for SMLLC or when no member data is present.
 */
export function extractMembersFromWizardData(submitted: Record<string, unknown>): NormalizedMember[] {
  // Path A: standalone form sends an explicit array
  if (Array.isArray(submitted.additional_members) && submitted.additional_members.length > 0) {
    return (submitted.additional_members as Array<Record<string, unknown>>).map(normalizeFromObject)
  }

  // Path B: portal wizard sends flat keys member_{index}_{field}
  // Determine count: prefer explicit member_count, fall back to scanning for member_0_* keys
  let count = 0
  if (typeof submitted.member_count === 'number' && submitted.member_count > 0) {
    count = submitted.member_count
  } else if (typeof submitted.member_count === 'string' && Number(submitted.member_count) > 0) {
    count = Number(submitted.member_count)
  } else {
    // Scan for highest member index present
    for (const key of Object.keys(submitted)) {
      const match = key.match(/^member_(\d+)_/)
      if (match) {
        const idx = parseInt(match[1], 10) + 1
        if (idx > count) count = idx
      }
    }
  }

  if (count === 0) return []

  const members: NormalizedMember[] = []
  for (let i = 0; i < count; i++) {
    // Extract all member_{i}_{field} keys into a flat object with just {field: value}
    const raw: Record<string, unknown> = {}
    for (const key of Object.keys(submitted)) {
      const prefix = `member_${i}_`
      if (key.startsWith(prefix)) {
        raw[key.slice(prefix.length)] = submitted[key]
      }
    }
    // Only include member if it has at least one non-null identifying field
    const hasData = raw.member_first_name || raw.member_last_name || raw.member_email || raw.member_company_name
    if (hasData) {
      members.push(normalizeFromObject(raw))
    }
  }

  return members
}
