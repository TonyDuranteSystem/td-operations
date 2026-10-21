import { describe, it, expect } from 'vitest'
import { isIdFieldName, looksLikeIdPaper } from '@/lib/crm-store/id-papers'

describe('isIdFieldName — the stored upload name starts with its form field', () => {
  it('ID fields', () => {
    for (const n of ['passport_image_ab12_front.jpg', 'passport_owner_1_a.pdf', 'selfie_with_id_1_a.jpg', 'driver_license_1_a.pdf', 'national_id_1_a.pdf', 'photo_id_1.jpg', 'residence_permit_1.pdf', 'visa_copy_1.pdf', 'ssn_card_1.pdf', 'itin_letter_1.pdf']) expect(isIdFieldName(n), n).toBe(true)
  })
  it('company papers', () => {
    for (const n of ['proof_of_address_1_bill.pdf', 'business_bank_statement_1.pdf', 'other_documents_1.pdf', 'articles_of_organization_1.pdf', 'ein_letter_1.pdf']) expect(isIdFieldName(n), n).toBe(false)
  })
})

describe('looksLikeIdPaper — a staff-moved file keeps any name, so any ID word counts', () => {
  it('catches ID papers named by hand', () => {
    for (const n of ['Passport - Mark Spanik.pdf', 'Mark passport copy.jpg', 'ID card front.jpg', 'Carta d\'identità Rossi.pdf', 'Passaporto.pdf', 'driver license.png', 'Permesso di soggiorno.pdf', 'SSN.pdf', 'WhatsApp passport.jpeg']) expect(looksLikeIdPaper(n), n).toBe(true)
  })
  it('lets ordinary company papers through', () => {
    for (const n of ['proof_of_address_e8f28b2a_Banksza_mlakivonat.pdf', 'Banking_Relay_Gold_Waves_LLC.pdf', 'Bank statement Sept.pdf', 'EIN letter.pdf', 'Operating Agreement.pdf']) expect(looksLikeIdPaper(n), n).toBe(false)
  })
})
