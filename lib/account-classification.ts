/**
 * Shared Account Classification
 *
 * Pure function — no DB calls. All data passed as input.
 * Used by Lifecycle Audit, Account Diagnose, and client-health tools.
 *
 * Business rules encoded here are the SINGLE SOURCE OF TRUTH for
 * account categorization. Do not duplicate these rules elsewhere.
 */

// ── Standard SD bundle for active clients ──

export const STANDARD_CLIENT_SDS = [
  'State RA Renewal',
  'State Annual Report',
  'CMRA Mailing Address',
  'Annual Renewal',
] as const

export const TAX_RETURN_SD = 'Tax Return' as const

// ── Input types ──

export interface ClassificationInput {
  // Account fields
  accountId: string
  accountType: string | null        // 'Client' | 'One-Time' | null
  accountStatus: string | null      // 'Active' | 'Inactive' | etc.
  einNumber: string | null
  formationDate: string | null      // 'YYYY-MM-DD' or null
  entityType: string | null         // 'Single Member LLC' | 'C-Corp Elected' | etc.

  // Active service deliveries for this account
  activeServiceTypes: string[]

  // Company Formation SD (if exists)
  formationSD: {
    stage: string | null
    stageOrder: number | null
    status: string                  // 'active' | 'completed'
  } | null

  // Tax return record (if exists for this account, any tax year)
  taxReturn: {
    taxYear: number
    extensionFiled: boolean
    status: string
    firstYearSkip: boolean
  } | null

  // SS-4 application (if exists)
  ss4: {
    status: string                  // 'submitted' | 'done' | etc.
  } | null

  // Current year for date comparisons (injectable for testing)
  currentYear?: number
}

// ── Output types ──

export type AccountCategory =
  | 'active_client'      // Active + Client + formation done + EIN present
  | 'one_time'           // Active + One-Time (no standard bundle expected)
  | 'new_formation'      // Active + Client + formation SD in progress
  | 'pending_ein'        // Active + Client + formed but EIN not received yet
  | 'legacy_client'      // Active + Client + formation done (via tax_returns or old data) but no formation SD
  | 'incomplete'         // Active but cannot classify confidently

export interface PendingReason {
  field: string            // e.g. 'ein_number', 'formation', 'tax_return'
  reason: string           // human-readable explanation
  expectedResolution?: string
}

export interface AccountClassification {
  // Category
  category: AccountCategory

  // Formation state
  formationComplete: boolean
  formationInProgress: boolean
  isWaitingForEIN: boolean

  // Service delivery expectations
  expectedSDs: string[]
  actualSDs: string[]
  missingSDs: string[]
  extraSDs: string[]

  // Tax return expectations
  taxReturnExpected: boolean
  taxReturnReason: string
  extensionFiled: boolean

  // Pending reasons (for audit tools to display instead of generic warnings)
  pendingReasons: PendingReason[]
}

// ── Classification function ──

export function classifyAccount(input: ClassificationInput): AccountClassification {
  const year = input.currentYear ?? new Date().getFullYear()

  // ─── Step 1: Formation completeness ───

  const hasEIN = !!input.einNumber
  const formationSDCompleted = input.formationSD?.status === 'completed'
  const hasTaxReturn = !!input.taxReturn
  const formedBeforeThisYear = !!input.formationDate &&
    parseInt(input.formationDate.split('-')[0], 10) < year
  const formedThisYear = !!input.formationDate &&
    parseInt(input.formationDate.split('-')[0], 10) === year

  const formationComplete =
    hasEIN ||
    formationSDCompleted ||
    formedBeforeThisYear ||
    hasTaxReturn  // Double effect: tax_returns row → company exists → formed

  const formationInProgress =
    !!input.formationSD && input.formationSD.status === 'active'

  // EIN wait detection
  const ss4Submitted = input.ss4?.status === 'submitted' ||
    input.ss4?.status === 'pending'
  const formationAtEINStage = input.formationSD?.stage != null &&
    /ein/i.test(input.formationSD.stage)
  const isWaitingForEIN =
    !hasEIN &&
    !!input.formationDate &&
    (ss4Submitted || formationAtEINStage || formationInProgress)

  // ─── Step 2: Category ───

  const isClient = input.accountType === 'Client'
  const isOneTime = input.accountType === 'One-Time'

  let category: AccountCategory

  if (isOneTime) {
    category = 'one_time'
  } else if (isWaitingForEIN) {
    // Waiting for EIN — formation started but EIN not received yet
    // Must come BEFORE new_formation check (formation is in progress but at EIN stage)
    category = 'pending_ein'
  } else if (formationInProgress && !formationComplete) {
    // Formation SD active and not yet complete (early stages, pre-EIN)
    category = 'new_formation'
  } else if (formationComplete && !input.formationSD && isClient) {
    // Formation done but no formation SD in system — imported/migrated client
    category = 'legacy_client'
  } else if (formationComplete && isClient) {
    // Formation done with formation SD present — standard active client
    category = 'active_client'
  } else if (isClient && !formationComplete && !formationInProgress) {
    category = 'incomplete'
  } else {
    category = 'incomplete'
  }

  // ─── Step 3: Tax return expectation ───

  let taxReturnExpected = false
  let taxReturnReason = ''
  const extensionFiled = input.taxReturn?.extensionFiled ?? false

  if (isOneTime) {
    taxReturnExpected = hasTaxReturn  // Only if they explicitly have one
    taxReturnReason = hasTaxReturn ? 'One-Time account with active tax return' : 'One-Time account — no standard tax filing'
  } else if (category === 'new_formation') {
    taxReturnExpected = false
    taxReturnReason = 'Formation not complete — tax return not yet applicable'
  } else if (input.taxReturn?.firstYearSkip) {
    taxReturnExpected = false
    taxReturnReason = `First-year skip — company formed in ${input.formationDate?.split('-')[0] || 'current year'}`
  } else if (formedThisYear && !hasTaxReturn) {
    taxReturnExpected = false
    taxReturnReason = `Company formed in ${year} — first tax return expected in ${year + 1}`
  } else if (extensionFiled) {
    taxReturnExpected = true
    taxReturnReason = `Extension filed for TY ${input.taxReturn!.taxYear}`
  } else if (hasTaxReturn) {
    taxReturnExpected = true
    taxReturnReason = `Tax return record exists (TY ${input.taxReturn!.taxYear}, status: ${input.taxReturn!.status})`
  } else if (formationComplete && hasEIN && formedBeforeThisYear) {
    taxReturnExpected = true
    taxReturnReason = 'Active client with EIN, formed before this year — tax filing expected'
  } else {
    taxReturnExpected = false
    taxReturnReason = 'Cannot determine tax return expectation'
  }

  // ─── Step 4: Expected SDs ───

  let expectedSDs: string[] = []

  if (category === 'one_time') {
    // One-Time: no standard bundle. Only what they already have.
    expectedSDs = []
  } else if (category === 'new_formation') {
    // Formation in progress: only the formation SD is expected
    expectedSDs = ['Company Formation']
  } else if (category === 'active_client' || category === 'legacy_client' || category === 'pending_ein') {
    // Standard client bundle
    expectedSDs = [...STANDARD_CLIENT_SDS]
    if (taxReturnExpected) {
      expectedSDs.push(TAX_RETURN_SD)
    }
  }
  // 'incomplete' → empty expectedSDs (can't determine)

  const actualSDs = [...input.activeServiceTypes]
  const missingSDs = expectedSDs.filter(e => !actualSDs.includes(e))
  const extraSDs = actualSDs.filter(a => !expectedSDs.includes(a) && a !== 'Company Formation')

  // ─── Step 5: Pending reasons ───

  const pendingReasons: PendingReason[] = []

  if (isWaitingForEIN) {
    const stage = input.formationSD?.stage || 'unknown'
    pendingReasons.push({
      field: 'ein_number',
      reason: ss4Submitted
        ? 'SS-4 submitted to IRS — typically takes 4-6 weeks'
        : formationAtEINStage
          ? `Formation at "${stage}" stage — EIN application in progress`
          : 'Company formed but EIN not yet received',
    })
  }

  if (!hasEIN && hasTaxReturn) {
    pendingReasons.push({
      field: 'ein_number',
      reason: 'EIN not recorded in CRM but company has a tax return record — likely missing data entry',
    })
  }

  if (formationInProgress) {
    const stage = input.formationSD?.stage || 'unknown'
    pendingReasons.push({
      field: 'formation',
      reason: `Formation in progress (stage: ${stage})`,
    })
  }

  if (hasTaxReturn && input.taxReturn!.status !== 'Completed' && input.taxReturn!.status !== 'Filed') {
    pendingReasons.push({
      field: 'tax_return',
      reason: `Tax return in progress (status: ${input.taxReturn!.status})`,
    })
  }

  return {
    category,
    formationComplete,
    formationInProgress,
    isWaitingForEIN,
    expectedSDs,
    actualSDs,
    missingSDs,
    extraSDs,
    taxReturnExpected,
    taxReturnReason,
    extensionFiled,
    pendingReasons,
  }
}
