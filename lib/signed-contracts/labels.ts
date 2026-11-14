/**
 * What a signed contract is called on the card. Titles are the real agreement titles used on the signing pages
 * (standalone-service-agreement.tsx SERVICE_CONTENT, the formation/onboarding "Master Service Agreement & Statement of Work",
 * and the annual renewal agreement). Pure.
 */
const MSA_TITLE = 'Master Service Agreement, Statement of Work and add-on agreements'

export interface ContractLabel {
  chip: string
  title: string
}

/** Contract types whose signing page records January/June installment amounts. */
export const INSTALLMENT_CONTRACT_TYPES = ['formation', 'onboarding', 'renewal'] as const

export function hasInstallmentAmounts(contractType: string | null | undefined): boolean {
  return (INSTALLMENT_CONTRACT_TYPES as readonly string[]).includes(contractType ?? '')
}

export function contractLabel(contractType: string | null | undefined, year: number | string | null | undefined): ContractLabel {
  switch (contractType) {
    case 'formation':
      return { chip: 'Formation', title: MSA_TITLE }
    case 'onboarding':
      return { chip: 'Onboarding', title: MSA_TITLE }
    case 'renewal':
      return { chip: 'Annual renewal', title: year ? `Annual renewal agreement ${year}` : 'Annual renewal agreement' }
    case 'tax_return':
      return { chip: 'Tax return', title: 'Tax Return Filing Agreement' }
    case 'itin':
      return { chip: 'ITIN', title: 'ITIN Application Service Agreement' }
    case 'closure':
      return { chip: 'Closure', title: 'Company Closure Service Agreement' }
    case 'company_change_name':
      return { chip: 'Company name change', title: 'Company Name Change Service Agreement' }
    default: {
      const t = (contractType ?? '').replace(/^custom_/, '').replace(/_/g, ' ').trim()
      const chip = t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Contract'
      return { chip, title: 'Service agreement' }
    }
  }
}
