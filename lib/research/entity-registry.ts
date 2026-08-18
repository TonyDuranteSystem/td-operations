/**
 * Research Console — entity/field registry.
 *
 * Single source of truth for what can be searched and how. The search API and
 * field-values API both validate every incoming entity/field against this
 * registry before touching the database — a client can never name an
 * arbitrary table or column (see lib/research/query-builder.ts).
 *
 * To add a new searchable record type: add one EntityConfig here. No new API
 * route or UI code needed — the generic engine picks it up automatically.
 */

export type FieldType = 'text' | 'select' | 'date' | 'number' | 'boolean' | 'reference'

export interface FieldConfig {
  key: string
  label: string
  type: FieldType
  /** For type 'reference': which registry entity this column points to. */
  refEntity?: string
}

export interface EntityConfig {
  key: string
  label: string
  table: string
  defaultSort: { field: string; ascending: boolean }
  /** Column used as the main label in results and in reference pickers. */
  displayField: string
  /** Detail-page link prefix, e.g. '/accounts' -> /accounts/{id}. Omit if no detail page exists. */
  linkPrefix?: string
  fields: FieldConfig[]
}

export const ENTITY_REGISTRY: Record<string, EntityConfig> = {
  accounts: {
    key: 'accounts',
    label: 'Companies',
    table: 'accounts',
    defaultSort: { field: 'company_name', ascending: true },
    displayField: 'company_name',
    linkPrefix: '/accounts',
    fields: [
      { key: 'company_name', label: 'Company name', type: 'text' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'entity_type', label: 'Entity type', type: 'select' },
      { key: 'account_type', label: 'Account type', type: 'select' },
      { key: 'state_of_formation', label: 'State of formation', type: 'select' },
      { key: 'client_health', label: 'Client health', type: 'select' },
      { key: 'portal_tier', label: 'Portal tier', type: 'select' },
      { key: 'member_structure', label: 'Member structure', type: 'select' },
      { key: 'ein_number', label: 'EIN', type: 'text' },
      { key: 'formation_date', label: 'Formation date', type: 'date' },
      { key: 'onboarding_date', label: 'Onboarding date', type: 'date' },
      { key: 'client_since', label: 'Client since', type: 'date' },
      { key: 'cancellation_date', label: 'Cancellation date', type: 'date' },
      { key: 'annual_report_due_date', label: 'Annual report due', type: 'date' },
      { key: 'ra_renewal_date', label: 'RA renewal due', type: 'date' },
      { key: 'portal_account', label: 'Has portal account', type: 'boolean' },
      { key: 'audit_flag', label: 'Audit flag', type: 'boolean' },
      { key: 'dunning_pause', label: 'Dunning paused', type: 'boolean' },
      { key: 'lead_source', label: 'Lead source', type: 'select' },
      { key: 'welcome_package_status', label: 'Welcome package status', type: 'select' },
      { key: 'created_at', label: 'Created', type: 'date' },
    ],
  },

  contacts: {
    key: 'contacts',
    label: 'Contacts',
    table: 'contacts',
    defaultSort: { field: 'full_name', ascending: true },
    displayField: 'full_name',
    linkPrefix: '/contacts',
    fields: [
      { key: 'full_name', label: 'Full name', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'portal_tier', label: 'Portal tier', type: 'select' },
      { key: 'citizenship', label: 'Citizenship', type: 'select' },
      { key: 'residency', label: 'Residency', type: 'select' },
      { key: 'language', label: 'Language', type: 'select' },
      { key: 'kyc_status', label: 'KYC status', type: 'select' },
      { key: 'passport_on_file', label: 'Passport on file', type: 'boolean' },
      { key: 'passport_expiry_date', label: 'Passport expiry', type: 'date' },
      { key: 'itin_number', label: 'ITIN', type: 'text' },
      { key: 'itin_issue_date', label: 'ITIN issued', type: 'date' },
      { key: 'itin_renewal_date', label: 'ITIN renewal due', type: 'date' },
      { key: 'is_partner', label: 'Is partner', type: 'boolean' },
      { key: 'preferred_channel', label: 'Preferred channel', type: 'select' },
      { key: 'address_city', label: 'City', type: 'text' },
      { key: 'address_state', label: 'State', type: 'select' },
      { key: 'address_country', label: 'Country', type: 'select' },
      { key: 'created_at', label: 'Created', type: 'date' },
    ],
  },

  leads: {
    key: 'leads',
    label: 'Leads',
    table: 'leads',
    defaultSort: { field: 'created_at', ascending: false },
    displayField: 'full_name',
    linkPrefix: '/leads',
    fields: [
      { key: 'full_name', label: 'Full name', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'source', label: 'Source', type: 'select' },
      { key: 'channel', label: 'Channel', type: 'select' },
      { key: 'language', label: 'Language', type: 'select' },
      { key: 'offer_status', label: 'Offer status', type: 'select' },
      { key: 'offer_year1_amount', label: 'Offer year-1 amount', type: 'number' },
      { key: 'offer_annual_amount', label: 'Offer annual amount', type: 'number' },
      { key: 'offer_year1_currency', label: 'Offer currency', type: 'select' },
      { key: 'referrer_name', label: 'Referrer name', type: 'text' },
      { key: 'call_date', label: 'Call date', type: 'date' },
      { key: 'created_at', label: 'Created', type: 'date' },
    ],
  },

  deals: {
    key: 'deals',
    label: 'Deals',
    table: 'deals',
    defaultSort: { field: 'created_at', ascending: false },
    displayField: 'deal_name',
    fields: [
      { key: 'deal_name', label: 'Deal name', type: 'text' },
      { key: 'account_id', label: 'Company', type: 'reference', refEntity: 'accounts' },
      { key: 'contact_id', label: 'Contact', type: 'reference', refEntity: 'contacts' },
      { key: 'stage', label: 'Stage', type: 'select' },
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'amount_currency', label: 'Currency', type: 'select' },
      { key: 'deal_type', label: 'Deal type', type: 'select' },
      { key: 'deal_category', label: 'Deal category', type: 'select' },
      { key: 'service_type', label: 'Service type', type: 'select' },
      { key: 'payment_status', label: 'Payment status', type: 'select' },
      { key: 'pipeline', label: 'Pipeline', type: 'select' },
      { key: 'close_date', label: 'Close date', type: 'date' },
      { key: 'created_at', label: 'Created', type: 'date' },
    ],
  },

  service_deliveries: {
    key: 'service_deliveries',
    label: 'Services',
    table: 'service_deliveries',
    defaultSort: { field: 'created_at', ascending: false },
    displayField: 'service_name',
    fields: [
      { key: 'service_name', label: 'Service name', type: 'text' },
      { key: 'account_id', label: 'Company', type: 'reference', refEntity: 'accounts' },
      { key: 'service_type', label: 'Service type', type: 'select' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'stage', label: 'Stage', type: 'select' },
      { key: 'billing_type', label: 'Billing type', type: 'select' },
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'amount_currency', label: 'Currency', type: 'select' },
      { key: 'assigned_to', label: 'Assigned to', type: 'select' },
      { key: 'start_date', label: 'Start date', type: 'date' },
      { key: 'end_date', label: 'End date', type: 'date' },
      { key: 'due_date', label: 'Due date', type: 'date' },
    ],
  },

  payments: {
    key: 'payments',
    label: 'Payments',
    table: 'payments',
    defaultSort: { field: 'due_date', ascending: false },
    displayField: 'invoice_number',
    fields: [
      { key: 'invoice_number', label: 'Invoice number', type: 'text' },
      { key: 'account_id', label: 'Company', type: 'reference', refEntity: 'accounts' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'invoice_status', label: 'Invoice status', type: 'select' },
      { key: 'period', label: 'Period', type: 'select' },
      { key: 'year', label: 'Year', type: 'number' },
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'amount_due', label: 'Amount due', type: 'number' },
      { key: 'amount_paid', label: 'Amount paid', type: 'number' },
      { key: 'amount_currency', label: 'Currency', type: 'select' },
      { key: 'payment_method', label: 'Payment method', type: 'select' },
      { key: 'payment_category', label: 'Payment category', type: 'select' },
      { key: 'due_date', label: 'Due date', type: 'date' },
      { key: 'paid_date', label: 'Paid date', type: 'date' },
      { key: 'issue_date', label: 'Issue date', type: 'date' },
    ],
  },

  tasks: {
    key: 'tasks',
    label: 'Tasks',
    table: 'tasks',
    defaultSort: { field: 'due_date', ascending: true },
    displayField: 'task_title',
    fields: [
      { key: 'task_title', label: 'Title', type: 'text' },
      { key: 'account_id', label: 'Company', type: 'reference', refEntity: 'accounts' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'priority', label: 'Priority', type: 'select' },
      { key: 'category', label: 'Category', type: 'select' },
      { key: 'assigned_to', label: 'Assigned to', type: 'select' },
      { key: 'due_date', label: 'Due date', type: 'date' },
      { key: 'completed_date', label: 'Completed date', type: 'date' },
    ],
  },

  offers: {
    key: 'offers',
    label: 'Offers',
    table: 'offers',
    defaultSort: { field: 'offer_date', ascending: false },
    displayField: 'client_name',
    fields: [
      { key: 'client_name', label: 'Client name', type: 'text' },
      { key: 'client_email', label: 'Client email', type: 'text' },
      { key: 'account_id', label: 'Company', type: 'reference', refEntity: 'accounts' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'entity_type', label: 'Entity type', type: 'select' },
      { key: 'contract_type', label: 'Contract type', type: 'select' },
      { key: 'payment_type', label: 'Payment type', type: 'select' },
      { key: 'language', label: 'Language', type: 'select' },
      { key: 'currency', label: 'Currency', type: 'select' },
      { key: 'offer_date', label: 'Offer date', type: 'date' },
      { key: 'expires_at', label: 'Expires', type: 'date' },
      { key: 'view_count', label: 'View count', type: 'number' },
      { key: 'viewed_at', label: 'Viewed at', type: 'date' },
    ],
  },

  lease_agreements: {
    key: 'lease_agreements',
    label: 'Lease Agreements',
    table: 'lease_agreements',
    defaultSort: { field: 'created_at', ascending: false },
    displayField: 'tenant_company',
    fields: [
      { key: 'tenant_company', label: 'Tenant company', type: 'text' },
      { key: 'account_id', label: 'Company', type: 'reference', refEntity: 'accounts' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'tenant_state', label: 'Tenant state', type: 'select' },
      { key: 'landlord_name', label: 'Landlord name', type: 'text' },
      { key: 'premises_address', label: 'Premises address', type: 'text' },
      { key: 'monthly_rent', label: 'Monthly rent', type: 'number' },
      { key: 'yearly_rent', label: 'Yearly rent', type: 'number' },
      { key: 'term_start_date', label: 'Term start', type: 'date' },
      { key: 'term_end_date', label: 'Term end', type: 'date' },
      { key: 'effective_date', label: 'Effective date', type: 'date' },
      { key: 'language', label: 'Language', type: 'select' },
      { key: 'signed_at', label: 'Signed at', type: 'date' },
    ],
  },

  oa_agreements: {
    key: 'oa_agreements',
    label: 'Operating Agreements',
    table: 'oa_agreements',
    defaultSort: { field: 'created_at', ascending: false },
    displayField: 'company_name',
    fields: [
      { key: 'company_name', label: 'Company name', type: 'text' },
      { key: 'account_id', label: 'Company', type: 'reference', refEntity: 'accounts' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'entity_type', label: 'Entity type', type: 'select' },
      { key: 'state_of_formation', label: 'State of formation', type: 'select' },
      { key: 'member_name', label: 'Member name', type: 'text' },
      { key: 'manager_name', label: 'Manager name', type: 'text' },
      { key: 'language', label: 'Language', type: 'select' },
      { key: 'signed_at', label: 'Signed at', type: 'date' },
      { key: 'signed_count', label: 'Signed count', type: 'number' },
      { key: 'total_signers', label: 'Total signers', type: 'number' },
    ],
  },
}

export function getEntity(key: string): EntityConfig | null {
  return Object.prototype.hasOwnProperty.call(ENTITY_REGISTRY, key) ? ENTITY_REGISTRY[key] : null
}

export function getField(entity: EntityConfig, fieldKey: string): FieldConfig | null {
  return entity.fields.find(f => f.key === fieldKey) ?? null
}

export interface UnionField {
  field: FieldConfig
  /** Which of the given entity keys actually have this field. */
  appliesTo: string[]
}

/**
 * Multi-entity search shares one field picker across every selected record
 * type: a shared field name (e.g. "status") shows once, not once per entity.
 * The FIRST entity (in the order given) that declares a field wins for its
 * displayed label/type — later entities only contribute to `appliesTo`.
 * A condition built from this field is later applied only to the entities
 * listed in `appliesTo`, never silently to one that lacks it.
 */
export function unionFieldsAcrossEntities(entityKeys: string[]): UnionField[] {
  const byKey = new Map<string, UnionField>()
  for (const key of entityKeys) {
    const entity = getEntity(key)
    if (!entity) continue
    for (const field of entity.fields) {
      const existing = byKey.get(field.key)
      if (existing) existing.appliesTo.push(key)
      else byKey.set(field.key, { field, appliesTo: [key] })
    }
  }
  return Array.from(byKey.values())
}
