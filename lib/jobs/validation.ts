/**
 * Wizard data validation utilities.
 * Used by auto-chain handlers to validate wizard submissions before processing.
 */

export interface ValidationError {
  field: string
  message: string
  severity: "error" | "warning"
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

/** Validate EIN format: XX-XXXXXXX (2 digits, dash, 7 digits) */
export function validateEIN(ein: string | undefined | null): ValidationError | null {
  if (!ein) return null // EIN is optional for some wizard types
  const cleaned = String(ein).trim()
  if (!/^\d{2}-\d{7}$/.test(cleaned)) {
    return {
      field: "ein",
      message: `Invalid EIN format: "${cleaned}". Expected XX-XXXXXXX (e.g., 30-1482516)`,
      severity: "error",
    }
  }
  return null
}

/** Validate state is in the allowed list */
export function validateState(state: string | undefined | null): ValidationError | null {
  if (!state) return null
  const allowed = [
    "NM", "New Mexico", "WY", "Wyoming",
    "FL", "Florida", "DE", "Delaware",
  ]
  if (!allowed.some(s => s.toLowerCase() === state.toLowerCase())) {
    return {
      field: "state_of_formation",
      message: `State "${state}" is not in the standard list (NM, WY, FL, DE). May require manual review.`,
      severity: "warning",
    }
  }
  return null
}

/** Validate formation date is reasonable */
export function validateFormationDate(date: string | undefined | null): ValidationError | null {
  if (!date) return null
  const parsed = new Date(date)
  if (isNaN(parsed.getTime())) {
    return { field: "formation_date", message: `Invalid date format: "${date}"`, severity: "error" }
  }
  const now = new Date()
  if (parsed > now) {
    return { field: "formation_date", message: `Formation date "${date}" is in the future`, severity: "warning" }
  }
  // LLCs in Wyoming started in 1977, NM in 1993 — anything before 1990 is suspicious
  if (parsed.getFullYear() < 1990) {
    return { field: "formation_date", message: `Formation date "${date}" is unusually old (before 1990)`, severity: "warning" }
  }
  return null
}

/** Validate required fields are present */
export function validateRequiredFields(
  data: Record<string, unknown>,
  required: string[]
): ValidationError[] {
  const errors: ValidationError[] = []
  for (const field of required) {
    const val = data[field]
    if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
      errors.push({
        field,
        message: `Required field "${field}" is missing or empty`,
        severity: "error",
      })
    }
  }
  return errors
}

/**
 * Run all validations for onboarding wizard data.
 * Returns { valid, errors, warnings }.
 */
export function validateOnboardingData(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  // Required fields for onboarding
  const requiredFields = ["company_name", "owner_first_name", "owner_last_name"]
  errors.push(...validateRequiredFields(data, requiredFields))

  // EIN validation
  const einErr = validateEIN(data.ein as string)
  if (einErr) {
    if (einErr.severity === "error") errors.push(einErr)
    else warnings.push(einErr)
  }

  // State validation
  const stateErr = validateState(data.state_of_formation as string)
  if (stateErr) {
    if (stateErr.severity === "error") errors.push(stateErr)
    else warnings.push(stateErr)
  }

  // Formation date validation
  const dateErr = validateFormationDate(data.formation_date as string)
  if (dateErr) {
    if (dateErr.severity === "error") errors.push(dateErr)
    else warnings.push(dateErr)
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Run all validations for formation wizard data.
 */
export function validateFormationData(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  // Required fields for formation
  const requiredFields = ["owner_first_name", "owner_last_name", "llc_name_1"]
  errors.push(...validateRequiredFields(data, requiredFields))

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
