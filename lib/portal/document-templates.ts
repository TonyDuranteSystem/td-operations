/**
 * Shared types and helpers for portal document generation
 * (Distribution Resolution + Tax Statement)
 */

export type GeneratedDocumentType = 'distribution_resolution' | 'tax_statement'

export type EntityCategory = 'SMLLC' | 'MMLLC' | 'Corporation'

export interface DocumentFormData {
  amount: number
  fiscalYear: number
  distributionDate: string // YYYY-MM-DD
  currency: string
}

export interface MemberInfo {
  fullName: string
  role: string
  ownershipPct: number | null
}

export interface DocumentCompanyData {
  companyName: string
  ein: string | null
  stateOfFormation: string | null
  formationDate: string | null
  physicalAddress: string | null
  logoUrl: string | null
  entityType: string | null
}

export interface DocumentTemplateProps {
  company: DocumentCompanyData
  members: MemberInfo[]
  form: DocumentFormData
  entityCategory: EntityCategory
  signatureImage?: string | null // data URL when signed
}

const DEFAULT_ADDRESS = '10225 Ulmerton Rd, Suite 3D, Largo, FL 33771'

/**
 * Derive entity category from raw entity_type string
 */
export function getEntityCategory(entityType: string | null): EntityCategory {
  if (!entityType) return 'SMLLC'
  const lower = entityType.toLowerCase()
  if (lower.includes('single') || lower === 'smllc') return 'SMLLC'
  if (lower.includes('multi') || lower === 'mmllc') return 'MMLLC'
  if (lower.includes('corp') || lower.includes('c-corp') || lower.includes('s-corp')) return 'Corporation'
  // Default to SMLLC for LLC without qualifier
  if (lower.includes('llc')) return 'SMLLC'
  return 'SMLLC'
}

/**
 * Get the address to use on documents, with fallback
 */
export function getDocumentAddress(physicalAddress: string | null): string {
  return physicalAddress || DEFAULT_ADDRESS
}

/**
 * Format currency amount for legal documents
 */
export function formatDocumentAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
  }).format(amount)
}

/**
 * Convert number to words (for legal documents)
 */
export function numberToWords(n: number): string {
  if (n === 0) return 'Zero'
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

  const intPart = Math.floor(n)
  const cents = Math.round((n - intPart) * 100)

  function convert(num: number): string {
    if (num < 20) return ones[num]
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? '-' + ones[num % 10] : '')
    if (num < 1000) return ones[Math.floor(num / 100)] + ' Hundred' + (num % 100 ? ' ' + convert(num % 100) : '')
    if (num < 1000000) return convert(Math.floor(num / 1000)) + ' Thousand' + (num % 1000 ? ' ' + convert(num % 1000) : '')
    if (num < 1000000000) return convert(Math.floor(num / 1000000)) + ' Million' + (num % 1000000 ? ' ' + convert(num % 1000000) : '')
    return String(num)
  }

  let result = convert(intPart) + ' Dollars'
  if (cents > 0) {
    result += ' and ' + convert(cents) + ' Cents'
  }
  return result
}

/**
 * Format a date string for legal documents
 */
export function formatLegalDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Get the primary/managing member from the members list
 */
export function getManagingMember(members: MemberInfo[]): MemberInfo | null {
  // Prefer owner/manager role
  const manager = members.find(m =>
    m.role?.toLowerCase() === 'manager' || m.role?.toLowerCase() === 'owner'
  )
  return manager || members[0] || null
}

/**
 * Get fiscal year options (current year + 3 previous)
 */
export function getFiscalYearOptions(): number[] {
  const currentYear = new Date().getFullYear()
  return [currentYear, currentYear - 1, currentYear - 2, currentYear - 3]
}
