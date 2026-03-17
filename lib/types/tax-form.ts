/**
 * Tax Form Types — Field configs, bilingual labels, tooltips
 * Used by: app/tax-form/[token]/page.tsx, lib/mcp/tools/tax.ts
 *
 * Entity Types:
 *   SMLLC  = Foreign-Owned Single Member LLC (Form 1120/5472)
 *   MMLLC  = Multi-Member LLC / Partnership (Form 1065)
 *   Corp   = C-Corporation (Form 1120)
 */

// ─── DB Record ──────────────────────────────────────────────

export interface TaxFormSubmission {
  id: string
  token: string
  account_id: string | null
  contact_id: string | null
  tax_year: number
  entity_type: 'SMLLC' | 'MMLLC' | 'Corp'
  language: 'en' | 'it'
  prefilled_data: Record<string, unknown>
  submitted_data: Record<string, unknown>
  changed_fields: Record<string, { old: unknown; new: unknown }>
  has_articles_on_file: boolean
  has_ein_letter_on_file: boolean
  upload_paths: string[]
  tax_return_id: string | null
  status: 'pending' | 'sent' | 'opened' | 'completed' | 'reviewed'
  sent_at: string | null
  opened_at: string | null
  completed_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  client_ip: string | null
  client_user_agent: string | null
  confirmation_accepted: boolean
  created_at: string
  updated_at: string
}

// ─── Field Config ───────────────────────────────────────────

export type FieldType = 'text' | 'email' | 'phone' | 'number' | 'date' | 'select' | 'textarea' | 'boolean' | 'currency' | 'country'

export interface FieldConfig {
  key: string
  type: FieldType
  required: boolean
  step: 1 | 2 | 3 | 4
  /** Which entity types use this field. Omit = all types */
  entityTypes?: ('SMLLC' | 'MMLLC' | 'Corp')[]
  /** CRM field to pre-fill from. Format: "table.column" */
  prefillFrom?: string
  options?: string[]
  /** If true, this is a dynamic array field (e.g., additional members) */
  isArray?: boolean
  /** Array sub-fields */
  arrayFields?: Omit<FieldConfig, 'step' | 'entityTypes' | 'isArray' | 'arrayFields'>[]
}

// ─── Step Labels ────────────────────────────────────────────

export const STEPS = {
  en: ['Owner Information', 'LLC Information', 'Financial Information', 'Documents & Review'],
  it: ['Informazioni Titolare', 'Informazioni LLC', 'Informazioni Finanziarie', 'Documenti e Revisione'],
} as const

// ─── Field Definitions ──────────────────────────────────────
// ALL fields across all entity types. Filter by entityTypes per form.

export const FORM_FIELDS: FieldConfig[] = [
  // ═══════════════════════════════════════
  // STEP 1: Owner Information
  // ═══════════════════════════════════════

  // Shared fields (all entity types)
  { key: 'owner_first_name', type: 'text', required: true, step: 1, prefillFrom: 'contacts.first_name' },
  { key: 'owner_last_name', type: 'text', required: true, step: 1, prefillFrom: 'contacts.last_name' },
  { key: 'owner_street', type: 'text', required: true, step: 1, prefillFrom: 'contacts.address_street' },
  { key: 'owner_city', type: 'text', required: true, step: 1, prefillFrom: 'contacts.address_city' },
  { key: 'owner_state_province', type: 'text', required: true, step: 1 },
  { key: 'owner_zip', type: 'text', required: true, step: 1 },
  { key: 'owner_country', type: 'country', required: true, step: 1, prefillFrom: 'contacts.residency' },
  { key: 'owner_phone', type: 'phone', required: true, step: 1, prefillFrom: 'contacts.phone' },
  { key: 'owner_email', type: 'email', required: true, step: 1, prefillFrom: 'contacts.email' },
  { key: 'owner_tax_residency', type: 'country', required: true, step: 1, prefillFrom: 'contacts.citizenship' },
  { key: 'owner_local_tax_number', type: 'text', required: true, step: 1 },

  // SMLLC-specific
  { key: 'owner_direct_100_pct', type: 'boolean', required: true, step: 1, entityTypes: ['SMLLC'] },
  { key: 'owner_ultimate_25_pct', type: 'boolean', required: true, step: 1, entityTypes: ['SMLLC'] },
  { key: 'ultimate_owner_name', type: 'text', required: false, step: 1, entityTypes: ['SMLLC'] },
  { key: 'ultimate_owner_address', type: 'text', required: false, step: 1, entityTypes: ['SMLLC'] },
  { key: 'ultimate_owner_country', type: 'country', required: false, step: 1, entityTypes: ['SMLLC'] },
  { key: 'ultimate_owner_tax_id', type: 'text', required: false, step: 1, entityTypes: ['SMLLC'] },

  // MMLLC-specific
  {
    key: 'additional_members', type: 'text', required: false, step: 1, entityTypes: ['MMLLC'],
    isArray: true,
    arrayFields: [
      { key: 'member_name', type: 'text', required: true },
      { key: 'member_ownership_pct', type: 'number', required: true },
      { key: 'member_itin_ssn', type: 'text', required: false },
      { key: 'member_tax_residency', type: 'country', required: true },
      { key: 'member_address', type: 'text', required: true },
    ],
  },

  // Corp-specific
  { key: 'ownership_structure', type: 'textarea', required: true, step: 1, entityTypes: ['Corp'] },
  { key: 'foreign_owned_25_pct', type: 'boolean', required: true, step: 1, entityTypes: ['Corp'] },
  { key: 'foreign_owner_details', type: 'textarea', required: false, step: 1, entityTypes: ['Corp'] },

  // ═══════════════════════════════════════
  // STEP 2: LLC Information
  // ═══════════════════════════════════════

  // Shared fields
  { key: 'llc_name', type: 'text', required: true, step: 2, prefillFrom: 'accounts.company_name' },
  { key: 'ein_number', type: 'text', required: true, step: 2, prefillFrom: 'accounts.ein_number' },
  { key: 'date_of_incorporation', type: 'date', required: true, step: 2, prefillFrom: 'accounts.formation_date' },
  { key: 'state_of_incorporation', type: 'text', required: true, step: 2, prefillFrom: 'accounts.state_of_formation' },
  { key: 'website_url', type: 'text', required: false, step: 2 },
  { key: 'principal_product_service', type: 'textarea', required: true, step: 2 },
  { key: 'us_business_activities', type: 'textarea', required: true, step: 2 },

  // Corp-specific
  { key: 'state_revenue_breakdown', type: 'textarea', required: false, step: 2, entityTypes: ['Corp'] },
  { key: 'new_activities_markets', type: 'textarea', required: false, step: 2, entityTypes: ['Corp'] },
  { key: 'has_payroll_w2', type: 'boolean', required: true, step: 2, entityTypes: ['Corp'] },
  { key: 'payroll_details', type: 'textarea', required: false, step: 2, entityTypes: ['Corp'] },

  // ═══════════════════════════════════════
  // STEP 3: Financial Information
  // ═══════════════════════════════════════

  // SMLLC Financial
  { key: 'formation_costs', type: 'currency', required: true, step: 3, entityTypes: ['SMLLC'] },
  { key: 'bank_contributions', type: 'currency', required: true, step: 3, entityTypes: ['SMLLC'] },
  { key: 'distributions_withdrawals', type: 'currency', required: true, step: 3, entityTypes: ['SMLLC'] },
  { key: 'personal_expenses', type: 'currency', required: true, step: 3, entityTypes: ['SMLLC'] },
  {
    key: 'related_party_transactions', type: 'text', required: false, step: 3, entityTypes: ['SMLLC'],
    isArray: true,
    arrayFields: [
      { key: 'rpt_company_name', type: 'text', required: true },
      { key: 'rpt_address', type: 'text', required: true },
      { key: 'rpt_country', type: 'country', required: true },
      { key: 'rpt_vat_number', type: 'text', required: false },
      { key: 'rpt_amount', type: 'currency', required: true },
      { key: 'rpt_description', type: 'text', required: false },
    ],
  },
  { key: 'smllc_additional_comments', type: 'textarea', required: false, step: 3, entityTypes: ['SMLLC'] },

  // MMLLC Financial
  { key: 'prior_year_returns_filed', type: 'boolean', required: true, step: 3, entityTypes: ['MMLLC'] },
  { key: 'financial_statements_sent', type: 'boolean', required: true, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_has_payroll', type: 'boolean', required: true, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_ownership_change', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_foreign_partners', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_assets_over_50k', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_received_1099', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_issued_1099', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_crypto_transactions', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_real_estate', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_foreign_bank_accounts', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_related_party_trans', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_debt_forgiveness', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_vehicle_business_use', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_home_office', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_retirement_plan', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_health_insurance', type: 'boolean', required: false, step: 3, entityTypes: ['MMLLC'] },
  { key: 'mmllc_additional_info', type: 'textarea', required: false, step: 3, entityTypes: ['MMLLC'] },

  // Corp Financial
  { key: 'corp_contributions', type: 'currency', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_distributions', type: 'currency', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_dividends_paid', type: 'currency', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_debt_modifications', type: 'textarea', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_estimated_taxes_paid', type: 'currency', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_rental_passive_income', type: 'currency', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_minute_book_updated', type: 'boolean', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_received_1099', type: 'boolean', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_vehicle_ownership', type: 'boolean', required: false, step: 3, entityTypes: ['Corp'] },
  { key: 'corp_additional_info', type: 'textarea', required: false, step: 3, entityTypes: ['Corp'] },

  // ═══════════════════════════════════════
  // STEP 4: Documents & Review (no input fields — handled in UI)
  // ═══════════════════════════════════════
]

// ─── Get fields for a specific entity type + step ───────────

export function getFieldsForStep(entityType: string, step: number): FieldConfig[] {
  return FORM_FIELDS.filter(f => {
    if (f.step !== step) return false
    if (!f.entityTypes) return true
    return f.entityTypes.includes(entityType as 'SMLLC' | 'MMLLC' | 'Corp')
  })
}

// ─── Bilingual Labels ───────────────────────────────────────

export const LABELS = {
  en: {
    // Page chrome
    title: 'Tax Return Information',
    subtitle: 'Data Collection Form',
    step: 'Step',
    of: 'of',
    next: 'Next',
    back: 'Back',
    submit: 'Submit Form',
    submitting: 'Submitting...',
    required: 'Required',
    prefilled: 'Pre-filled',
    changed: 'Changed',

    // Entity types
    entitySMLLC: 'Single Member LLC (Form 1120/5472)',
    entityMMLLC: 'Multi-Member LLC (Form 1065)',
    entityCorp: 'C-Corporation (Form 1120)',

    // Email gate
    emailGateTitle: 'Verify Your Identity',
    emailGateMessage: 'Enter the email address associated with this form to access it.',
    emailGateButton: 'Access Form',
    emailGateError: 'The email does not match our records. Please try again.',
    emailPlaceholder: 'your@email.com',

    // Step 1
    step1Title: 'Owner Information',
    owner_first_name: 'First Name',
    owner_last_name: 'Last Name',
    owner_street: 'Street Address',
    owner_city: 'City',
    owner_state_province: 'State / Province',
    owner_zip: 'ZIP / Postal Code',
    owner_country: 'Country of Residence',
    owner_phone: 'Phone Number',
    owner_email: 'Email Address',
    owner_tax_residency: 'Country of Tax Residency',
    owner_local_tax_number: 'Local Tax ID Number',
    owner_direct_100_pct: 'Are you the direct 100% owner?',
    owner_ultimate_25_pct: 'Is there an ultimate owner with more than 25% interest?',
    ultimate_owner_name: 'Ultimate Owner Full Name',
    ultimate_owner_address: 'Ultimate Owner Address',
    ultimate_owner_country: 'Ultimate Owner Country',
    ultimate_owner_tax_id: 'Ultimate Owner Tax ID',
    ownership_structure: 'Describe the ownership structure',
    foreign_owned_25_pct: 'Is the corporation more than 25% foreign-owned?',
    foreign_owner_details: 'Foreign owner details (name, country, percentage)',
    additional_members: 'Additional Members / Partners',
    member_name: 'Full Name',
    member_ownership_pct: 'Ownership %',
    member_itin_ssn: 'ITIN / SSN',
    member_tax_residency: 'Tax Residency',
    member_address: 'Address',
    addMember: '+ Add Member',
    removeMember: 'Remove',

    // Step 2
    step2Title: 'LLC Information',
    llc_name: 'LLC Legal Name',
    ein_number: 'EIN Number',
    date_of_incorporation: 'Date of Incorporation',
    state_of_incorporation: 'State of Incorporation',
    website_url: 'Website URL',
    principal_product_service: 'Principal Product or Service',
    us_business_activities: 'Describe US Business Activities',
    state_revenue_breakdown: 'Revenue Breakdown by State',
    new_activities_markets: 'New Activities or Markets This Year',
    has_payroll_w2: 'Does the company have payroll / W-2 employees?',
    payroll_details: 'Payroll Details',

    // Step 3
    step3Title: 'Financial Information',

    // SMLLC
    formation_costs: 'Formation Costs (USD)',
    bank_contributions: 'Bank Contributions / Capital Deposited (USD)',
    distributions_withdrawals: 'Distributions / Withdrawals (USD)',
    personal_expenses: 'Personal Expenses Paid Through LLC (USD)',
    related_party_transactions: 'Related Party Transactions',
    rpt_company_name: 'Company Name',
    rpt_address: 'Address',
    rpt_country: 'Country',
    rpt_vat_number: 'VAT / Tax Number',
    rpt_amount: 'Amount (USD)',
    rpt_description: 'Description',
    addTransaction: '+ Add Transaction',
    removeTransaction: 'Remove',
    smllc_additional_comments: 'Additional Comments',

    // MMLLC
    prior_year_returns_filed: 'Were prior year returns filed?',
    financial_statements_sent: 'Have financial statements been sent?',
    mmllc_has_payroll: 'Does the LLC have payroll?',
    mmllc_ownership_change: 'Any ownership changes during the year?',
    mmllc_foreign_partners: 'Any foreign partners?',
    mmllc_assets_over_50k: 'Total assets over $50,000?',
    mmllc_received_1099: 'Did the LLC receive any 1099 forms?',
    mmllc_issued_1099: 'Did the LLC issue any 1099 forms?',
    mmllc_crypto_transactions: 'Any cryptocurrency transactions?',
    mmllc_real_estate: 'Any real estate holdings or transactions?',
    mmllc_foreign_bank_accounts: 'Any foreign bank accounts?',
    mmllc_related_party_trans: 'Any related party transactions?',
    mmllc_debt_forgiveness: 'Any debt forgiveness?',
    mmllc_vehicle_business_use: 'Any vehicles used for business?',
    mmllc_home_office: 'Any home office deduction?',
    mmllc_retirement_plan: 'Any retirement plan contributions?',
    mmllc_health_insurance: 'Any health insurance premiums?',
    mmllc_additional_info: 'Additional Information',

    // Corp
    corp_contributions: 'Capital Contributions (USD)',
    corp_distributions: 'Distributions to Shareholders (USD)',
    corp_dividends_paid: 'Dividends Paid (USD)',
    corp_debt_modifications: 'Debt Modifications or Forgiveness',
    corp_estimated_taxes_paid: 'Estimated Taxes Paid (USD)',
    corp_rental_passive_income: 'Rental / Passive Income (USD)',
    corp_minute_book_updated: 'Is the minute book up to date?',
    corp_received_1099: 'Did the corporation receive any 1099 forms?',
    corp_vehicle_ownership: 'Does the corporation own any vehicles?',
    corp_additional_info: 'Additional Information',

    // Step 4
    step4Title: 'Documents & Review',
    documentsOnFile: 'Documents On File',
    articlesOfOrg: 'Articles of Organization',
    einLetter: 'EIN Confirmation Letter (CP 575)',
    onFile: 'On File',
    uploadRequired: 'Upload Required',
    uploadFile: 'Upload File',
    financialStatements: 'Financial Statements',
    uploadFinancials: 'Upload Financial Statements (if available)',
    bankStatementsUpload: 'Bank Statements (Company)',
    bankStatementsHint: 'Upload all bank statements for the year (PDF, CSV, Excel). You can select multiple files at once or add them one by one.',
    bankStatementsCsvNote: 'Important: CSV format is strongly preferred. If your bank allows it, please download statements as CSV.',

    disclaimer: 'I confirm that I have reviewed all the information in this form, including pre-filled fields, and the data is accurate and complete. I understand that Tony Durante LLC relies on this information to prepare my tax return.',
    disclaimerRequired: 'You must accept the disclaimer to submit',

    // Success
    successTitle: 'Form Submitted Successfully!',
    successMessage: 'Your tax return information has been received. We will contact you if we need any clarification.',
    successTimestamp: 'Submitted on',

    // Errors
    notFound: 'Form Not Found',
    notFoundMessage: 'This form link is not valid or has expired.',
    loading: 'Loading form...',
    errorSubmit: 'An error occurred while submitting. Please try again.',
    alreadySubmitted: 'This form has already been submitted.',
    alreadySubmittedMessage: 'If you need to make changes, please contact us.',
  },
  it: {
    // Page chrome
    title: 'Informazioni Tax Return',
    subtitle: 'Modulo Raccolta Dati',
    step: 'Passo',
    of: 'di',
    next: 'Avanti',
    back: 'Indietro',
    submit: 'Invia Modulo',
    submitting: 'Invio in corso...',
    required: 'Obbligatorio',
    prefilled: 'Precompilato',
    changed: 'Modificato',

    // Entity types
    entitySMLLC: 'Single Member LLC (Form 1120/5472)',
    entityMMLLC: 'Multi-Member LLC (Form 1065)',
    entityCorp: 'C-Corporation (Form 1120)',

    // Email gate
    emailGateTitle: 'Verifica la tua identità',
    emailGateMessage: 'Inserisci l\'indirizzo email associato a questo modulo per accedervi.',
    emailGateButton: 'Accedi al Modulo',
    emailGateError: 'L\'email non corrisponde ai nostri dati. Riprova.',
    emailPlaceholder: 'tua@email.com',

    // Step 1
    step1Title: 'Informazioni Titolare',
    owner_first_name: 'Nome',
    owner_last_name: 'Cognome',
    owner_street: 'Indirizzo',
    owner_city: 'Città',
    owner_state_province: 'Stato / Provincia',
    owner_zip: 'CAP / Codice Postale',
    owner_country: 'Paese di Residenza',
    owner_phone: 'Telefono',
    owner_email: 'Email',
    owner_tax_residency: 'Paese di Residenza Fiscale',
    owner_local_tax_number: 'Codice Fiscale / Partita IVA',
    owner_direct_100_pct: 'Sei il proprietario diretto al 100%?',
    owner_ultimate_25_pct: 'C\'è un proprietario finale con più del 25%?',
    ultimate_owner_name: 'Nome Completo Proprietario Finale',
    ultimate_owner_address: 'Indirizzo Proprietario Finale',
    ultimate_owner_country: 'Paese Proprietario Finale',
    ultimate_owner_tax_id: 'Codice Fiscale Proprietario Finale',
    ownership_structure: 'Descrivi la struttura societaria',
    foreign_owned_25_pct: 'La società è posseduta per più del 25% da soggetti esteri?',
    foreign_owner_details: 'Dettagli proprietario estero (nome, paese, percentuale)',
    additional_members: 'Membri / Soci Aggiuntivi',
    member_name: 'Nome Completo',
    member_ownership_pct: 'Quota %',
    member_itin_ssn: 'ITIN / SSN',
    member_tax_residency: 'Residenza Fiscale',
    member_address: 'Indirizzo',
    addMember: '+ Aggiungi Membro',
    removeMember: 'Rimuovi',

    // Step 2
    step2Title: 'Informazioni LLC',
    llc_name: 'Nome Legale della LLC',
    ein_number: 'Numero EIN',
    date_of_incorporation: 'Data di Costituzione',
    state_of_incorporation: 'Stato di Costituzione',
    website_url: 'Sito Web',
    principal_product_service: 'Prodotto o Servizio Principale',
    us_business_activities: 'Descrivi le Attività Commerciali negli USA',
    state_revenue_breakdown: 'Ripartizione Ricavi per Stato',
    new_activities_markets: 'Nuove Attività o Mercati quest\'Anno',
    has_payroll_w2: 'L\'azienda ha dipendenti / buste paga W-2?',
    payroll_details: 'Dettagli Buste Paga',

    // Step 3
    step3Title: 'Informazioni Finanziarie',

    // SMLLC
    formation_costs: 'Costi di Costituzione (USD)',
    bank_contributions: 'Conferimenti Bancari / Capitale Versato (USD)',
    distributions_withdrawals: 'Distribuzioni / Prelievi (USD)',
    personal_expenses: 'Spese Personali Pagate dalla LLC (USD)',
    related_party_transactions: 'Transazioni con Parti Correlate',
    rpt_company_name: 'Nome Azienda',
    rpt_address: 'Indirizzo',
    rpt_country: 'Paese',
    rpt_vat_number: 'Partita IVA / Codice Fiscale',
    rpt_amount: 'Importo (USD)',
    rpt_description: 'Descrizione',
    addTransaction: '+ Aggiungi Transazione',
    removeTransaction: 'Rimuovi',
    smllc_additional_comments: 'Commenti Aggiuntivi',

    // MMLLC
    prior_year_returns_filed: 'Le dichiarazioni dell\'anno precedente sono state presentate?',
    financial_statements_sent: 'I bilanci sono stati inviati?',
    mmllc_has_payroll: 'La LLC ha buste paga?',
    mmllc_ownership_change: 'Cambiamenti nella proprietà durante l\'anno?',
    mmllc_foreign_partners: 'Soci esteri?',
    mmllc_assets_over_50k: 'Attività totali superiori a $50.000?',
    mmllc_received_1099: 'La LLC ha ricevuto moduli 1099?',
    mmllc_issued_1099: 'La LLC ha emesso moduli 1099?',
    mmllc_crypto_transactions: 'Transazioni in criptovalute?',
    mmllc_real_estate: 'Proprietà immobiliari o transazioni?',
    mmllc_foreign_bank_accounts: 'Conti bancari esteri?',
    mmllc_related_party_trans: 'Transazioni con parti correlate?',
    mmllc_debt_forgiveness: 'Cancellazione di debiti?',
    mmllc_vehicle_business_use: 'Veicoli usati per attività?',
    mmllc_home_office: 'Deduzione ufficio domestico?',
    mmllc_retirement_plan: 'Contributi piano pensionistico?',
    mmllc_health_insurance: 'Premi assicurazione sanitaria?',
    mmllc_additional_info: 'Informazioni Aggiuntive',

    // Corp
    corp_contributions: 'Conferimenti di Capitale (USD)',
    corp_distributions: 'Distribuzioni agli Azionisti (USD)',
    corp_dividends_paid: 'Dividendi Pagati (USD)',
    corp_debt_modifications: 'Modifiche o Cancellazione Debiti',
    corp_estimated_taxes_paid: 'Tasse Stimate Pagate (USD)',
    corp_rental_passive_income: 'Redditi da Locazione / Passivi (USD)',
    corp_minute_book_updated: 'Il libro verbali è aggiornato?',
    corp_received_1099: 'La società ha ricevuto moduli 1099?',
    corp_vehicle_ownership: 'La società possiede veicoli?',
    corp_additional_info: 'Informazioni Aggiuntive',

    // Step 4
    step4Title: 'Documenti e Revisione',
    documentsOnFile: 'Documenti in Archivio',
    articlesOfOrg: 'Atto Costitutivo (Articles of Organization)',
    einLetter: 'Lettera EIN (CP 575)',
    onFile: 'In Archivio',
    uploadRequired: 'Caricamento Richiesto',
    uploadFile: 'Carica File',
    financialStatements: 'Bilanci',
    uploadFinancials: 'Carica Bilanci (se disponibili)',
    bankStatementsUpload: 'Estratti Conto Bancari (Società)',
    bankStatementsHint: 'Carica tutti gli estratti conto bancari dell\'anno (PDF, CSV, Excel). Puoi selezionare più file contemporaneamente o aggiungerli uno alla volta.',
    bankStatementsCsvNote: 'Importante: il formato CSV è fortemente preferito. Se la tua banca lo consente, scarica gli estratti conto in CSV.',

    disclaimer: 'Confermo di aver controllato tutte le informazioni presenti in questo modulo, inclusi i campi precompilati, e che i dati sono accurati e completi. Comprendo che Tony Durante LLC si basa su queste informazioni per la preparazione della dichiarazione dei redditi.',
    disclaimerRequired: 'Devi accettare la dichiarazione per inviare',

    // Success
    successTitle: 'Modulo Inviato con Successo!',
    successMessage: 'Le informazioni per la dichiarazione dei redditi sono state ricevute. Ti contatteremo se avremo bisogno di chiarimenti.',
    successTimestamp: 'Inviato il',

    // Errors
    notFound: 'Modulo Non Trovato',
    notFoundMessage: 'Questo link non è valido o è scaduto.',
    loading: 'Caricamento modulo...',
    errorSubmit: 'Si è verificato un errore durante l\'invio. Riprova.',
    alreadySubmitted: 'Questo modulo è già stato inviato.',
    alreadySubmittedMessage: 'Se hai bisogno di modifiche, contattaci.',
  },
} as const

export type LabelKey = keyof typeof LABELS.en

// ─── Bilingual Tooltips ─────────────────────────────────────

export const TOOLTIPS: Record<string, { en: string; it: string }> = {
  // Step 1
  owner_first_name: {
    en: 'Your legal first name as it appears on your passport or national ID.',
    it: 'Il tuo nome legale come appare sul passaporto o documento d\'identità.',
  },
  owner_last_name: {
    en: 'Your legal last name as it appears on your passport or national ID.',
    it: 'Il tuo cognome legale come appare sul passaporto o documento d\'identità.',
  },
  owner_street: {
    en: 'Your current residential street address (not a P.O. Box).',
    it: 'Il tuo indirizzo di residenza attuale (non casella postale).',
  },
  owner_tax_residency: {
    en: 'The country where you are required to pay income taxes. This is usually where you live most of the year.',
    it: 'Il paese in cui sei tenuto a pagare le imposte sul reddito. Di solito è dove vivi per la maggior parte dell\'anno.',
  },
  owner_local_tax_number: {
    en: 'Your tax identification number in your country of residence (e.g., Codice Fiscale for Italy, NIF for Spain).',
    it: 'Il tuo codice fiscale o numero di identificazione fiscale nel tuo paese di residenza.',
  },
  owner_direct_100_pct: {
    en: 'Select "Yes" if you directly own 100% of the LLC with no intermediary companies or trusts.',
    it: 'Seleziona "Sì" se possiedi direttamente il 100% della LLC senza società o trust intermediari.',
  },
  owner_ultimate_25_pct: {
    en: 'Select "Yes" if there is any individual or entity that owns more than 25% of the LLC through indirect ownership chains.',
    it: 'Seleziona "Sì" se esiste un individuo o entità che possiede più del 25% della LLC attraverso catene di proprietà indiretta.',
  },
  ownership_structure: {
    en: 'List all shareholders and their ownership percentages. Include any holding companies.',
    it: 'Elenca tutti gli azionisti e le loro percentuali di proprietà. Includi eventuali holding.',
  },
  foreign_owned_25_pct: {
    en: 'Required for Form 5472. If yes, provide details of all foreign owners with 25%+ interest.',
    it: 'Richiesto per il Form 5472. Se sì, fornisci i dettagli di tutti i proprietari esteri con il 25%+ di partecipazione.',
  },

  // Step 2
  llc_name: {
    en: 'The exact legal name of your LLC as it appears in the Articles of Organization filed with the state.',
    it: 'Il nome legale esatto della tua LLC come appare nell\'atto costitutivo depositato presso lo stato.',
  },
  ein_number: {
    en: 'Your 9-digit Employer Identification Number (XX-XXXXXXX). Found on your EIN confirmation letter (IRS Letter CP 575).',
    it: 'Il tuo numero EIN a 9 cifre (XX-XXXXXXX). Si trova nella lettera di conferma EIN (IRS Letter CP 575).',
  },
  date_of_incorporation: {
    en: 'The date your LLC was officially formed with the state. Found in your Articles of Organization.',
    it: 'La data in cui la tua LLC è stata ufficialmente costituita presso lo stato. Si trova nell\'atto costitutivo.',
  },
  state_of_incorporation: {
    en: 'The US state where your LLC was formed (e.g., Wyoming, Delaware, New Mexico).',
    it: 'Lo stato americano dove è stata costituita la tua LLC (es. Wyoming, Delaware, New Mexico).',
  },
  principal_product_service: {
    en: 'Describe the main business activity of your LLC (e.g., "e-commerce sales", "software development", "consulting services").',
    it: 'Descrivi l\'attività principale della tua LLC (es. "vendita e-commerce", "sviluppo software", "servizi di consulenza").',
  },
  us_business_activities: {
    en: 'Describe any activities conducted in the United States: employees, offices, inventory, or services provided to US customers.',
    it: 'Descrivi qualsiasi attività svolta negli Stati Uniti: dipendenti, uffici, magazzino o servizi forniti a clienti americani.',
  },
  has_payroll_w2: {
    en: 'Select "Yes" if the company has employees who receive W-2 wage and tax statements.',
    it: 'Seleziona "Sì" se l\'azienda ha dipendenti che ricevono il modulo W-2.',
  },

  // Step 3 — SMLLC
  formation_costs: {
    en: 'Total costs incurred to form the LLC: state filing fees, registered agent fees, legal fees, etc.',
    it: 'Costi totali sostenuti per la costituzione della LLC: tasse statali, agente registrato, spese legali, ecc.',
  },
  bank_contributions: {
    en: 'Total amount deposited into the LLC bank account as capital contribution from the owner.',
    it: 'Importo totale depositato sul conto bancario della LLC come conferimento di capitale dal titolare.',
  },
  distributions_withdrawals: {
    en: 'Total amount withdrawn from the LLC bank account for personal use or distributed to the owner.',
    it: 'Importo totale prelevato dal conto della LLC per uso personale o distribuito al titolare.',
  },
  personal_expenses: {
    en: 'Total personal expenses paid through the LLC that are NOT business expenses (e.g., personal travel, personal purchases).',
    it: 'Spese personali totali pagate dalla LLC che NON sono spese aziendali (es. viaggi personali, acquisti personali).',
  },
  related_party_transactions: {
    en: 'Transactions between the LLC and companies owned by you or your family members. Required for Form 5472.',
    it: 'Transazioni tra la LLC e aziende di proprietà tua o di membri della tua famiglia. Richiesto per il Form 5472.',
  },

  // Step 3 — MMLLC
  prior_year_returns_filed: {
    en: 'Were the LLC\'s federal and state tax returns filed for the previous year?',
    it: 'Le dichiarazioni dei redditi federali e statali della LLC sono state presentate per l\'anno precedente?',
  },
  financial_statements_sent: {
    en: 'Have you sent us the profit & loss statement and balance sheet for this tax year?',
    it: 'Ci hai inviato il conto economico e lo stato patrimoniale per quest\'anno fiscale?',
  },

  // Step 3 — Corp
  corp_contributions: {
    en: 'Total capital contributed to the corporation by shareholders during the year.',
    it: 'Capitale totale conferito alla società dagli azionisti durante l\'anno.',
  },
  corp_distributions: {
    en: 'Total distributions paid to shareholders (not including dividends or salary).',
    it: 'Distribuzioni totali pagate agli azionisti (esclusi dividendi e stipendio).',
  },
  corp_estimated_taxes_paid: {
    en: 'Total estimated tax payments made to the IRS during the year (Form 1120-W).',
    it: 'Pagamenti totali di tasse stimate versati all\'IRS durante l\'anno (Form 1120-W).',
  },
  corp_minute_book_updated: {
    en: 'The corporate minute book should contain records of all board meetings, resolutions, and major decisions.',
    it: 'Il libro verbali aziendale dovrebbe contenere i verbali di tutte le riunioni del consiglio, risoluzioni e decisioni importanti.',
  },
}
