/**
 * Harbor Compliance API — TypeScript Types
 * Generated from OpenAPI spec: https://www.harborcompliance.com/api/v1/openapi
 *
 * Covers: Accounts, Companies, Orders, RA Deliveries, Licenses, Reference Data
 */

// ─── Pagination ───────────────────────────────────────────────

export interface HCPaginatedResponse<T> {
  has_more: boolean
  data: T[]
}

export interface HCSingleResponse<T> {
  data: T
}

export interface HCPaginationParams {
  limit?: number  // 1-100, default 20
  page?: number   // default 1
}

// ─── Reference Types ──────────────────────────────────────────

export interface HCJurisdiction {
  id: string
  name: string
}

export interface HCBusinessStructure {
  id: string
  name: string
}

export interface HCDocumentType {
  id: string
  name: string
}

export interface HCProduct {
  id: string
  name: string  // "Annual Report", "Change of Registered Agent", "Registered Agent"
}

export interface HCFilingAuthority {
  id: string
  name: string
}

export interface HCRefAccountType {
  id: number
  name: string
}

export interface HCBrand {
  id: string  // uuid
  name: string
}

export interface HCRefLicenseHolderType {
  id: string
  name: string
}

export interface HCRefLicense {
  id: string
  name: string
}

export interface HCRefLicenseType {
  id: string
  name: string
}

export interface HCRefModule {
  id: string
  name: string
}

export interface HCRefRegistrationType {
  id: string
  name: string
}

export interface HCRefRegistrationStatusGroup {
  id: string
  name: string
}

// ─── Address ──────────────────────────────────────────────────

export interface HCAddress {
  address_line_1: string
  address_line_2?: string | null
  locality: string
  postal_code: string
  administrative_area?: HCJurisdiction  // state
  country?: HCJurisdiction
}

export interface HCAddressInput {
  address_line_1: string
  locality: string
  administrative_area: { id: string }  // state jurisdiction ID
  postal_code: string
  country: { id: string }              // country jurisdiction ID
  address_line_2?: string
}

// ─── User ─────────────────────────────────────────────────────

export interface HCUser {
  id: number
  first_name: string
  middle_name?: string | null
  last_name: string
  full_name: string
  email: string
}

// ─── Account ──────────────────────────────────────────────────

export interface HCAccount {
  id: string  // uuid
  name: string
  website?: string | null
  ref_account_type_id?: number | null
  ref_account_type?: HCRefAccountType
  billing_address?: HCAddress
  brand?: HCBrand
}

export interface HCAccountInput {
  name: string
  website?: string
  ref_account_type_id?: number
  billing_address?: HCAddressInput
  brand?: { id: string }
}

// ─── Company ──────────────────────────────────────────────────

export interface HCCompany {
  id: string
  legal_name: string
  fiscal_year_end?: string | null  // MM/DD format
  phone?: string | null
  email?: string | null
  domicile?: HCJurisdiction
  business_structure?: HCBusinessStructure
  principal_address?: HCAddress
  mailing_address?: HCAddress
}

export interface HCCompanyInput {
  account_id: string
  legal_name: string
  business_structure: { id: string }
  domicile: { id: string }          // jurisdiction ID for state of formation
  principal_address: HCAddressInput
  mailing_address: HCAddressInput
  fiscal_year_end?: string           // MM/DD
  email?: string
  phone?: string
}

// ─── License / Company Registration ──────────────────────────

export interface HCCompanyRegistration {
  id: string  // uuid
  license_number: string
  license_holder_on_license?: string
  license_name?: string
  effective_date: string             // YYYY-MM-DD
  expiration_date?: string | null    // YYYY-MM-DD
  next_annual_report_due_date?: string | null  // YYYY-MM-DD
  registration_type?: string
  ref_module_id?: number
  ref_license_holder_type_id?: number
  account?: HCAccount
  company?: HCCompany
  individual_license_holder?: HCUser
  ref_jurisdiction?: HCJurisdiction
  ref_filing_authority?: HCFilingAuthority
  ref_license_holder_type?: HCRefLicenseHolderType
  ref_license?: HCRefLicense
  ref_license_types?: HCRefLicenseType[]
  ref_module?: HCRefModule
  ref_registration_type?: HCRefRegistrationType
  ref_registration_status_group?: HCRefRegistrationStatusGroup
}

export type HCLicenseHolderTypeFilter = 'company' | 'individual'

// ─── Order ────────────────────────────────────────────────────

export interface HCOrder {
  id: string  // uuid
  linked_to_order_id?: string | null
  company?: HCCompany
  product?: HCProduct
  jurisdictions?: HCJurisdiction[]
}

/** Create order with explicit product + jurisdictions */
export interface HCOrderCreateWithProduct {
  company: { id: string }        // uuid
  product: { id: string }        // uuid — must be a valid product ID
  jurisdictions: { id: string }[]  // min 1
  linked_to_order_id?: string | null
}

/** Create order with a preconfigured product (account-level config) */
export interface HCOrderCreateWithPreconfiguredProduct {
  company: { id: string }
  preconfigured_product: { id: string }  // AccountProductConfig ID
}

export type HCOrderCreateInput = HCOrderCreateWithProduct | HCOrderCreateWithPreconfiguredProduct

export interface HCOrderUpdateInput {
  company: { id: string }
  jurisdictions: { id: string }[]  // min 1
}

// ─── Registered Agent Delivery ────────────────────────────────

export interface HCRegisteredAgentDelivery {
  id: string  // uuid
  name: string
  created_at?: string              // ISO 8601
  is_downloadable?: boolean
  downloaded_at?: string | null    // ISO 8601
  company?: HCCompany
  jurisdiction?: HCJurisdiction
  document_type?: HCDocumentType
}

// ─── OAuth2 ───────────────────────────────────────────────────

export interface HCTokenResponse {
  token_type: 'Bearer'
  expires_in: number               // seconds (typically 3599)
  access_token: string
  refresh_token: string
}

export interface HCPasswordGrantRequest {
  grant_type: 'password'
  client_id: string
  client_secret: string
  scope: 'admin'
  username: string
  password: string
}

export interface HCRefreshTokenRequest {
  grant_type: 'refresh_token'
  client_id: string
  client_secret: string
  scope: 'admin'
  refresh_token: string
}

export interface HCAuthCodeGrantRequest {
  grant_type: 'authorization_code'
  client_id: string
  client_secret: string
  scope: 'admin'
  redirect_uri: string
  code: string
}

// ─── Filter / Include helpers ─────────────────────────────────

export type HCAccountInclude = 'ref_account_type' | 'billing_address' | 'brand'
export type HCCompanyInclude = 'domicile' | 'business_structure' | 'principal_address' | 'mailing_address'
export type HCLicenseInclude =
  | 'account' | 'company' | 'individual_license_holder'
  | 'ref_jurisdiction' | 'ref_entity_override' | 'ref_filing_authority'
  | 'ref_license_holder_type' | 'ref_license' | 'ref_license_types'
  | 'ref_module' | 'ref_registration_type' | 'ref_registration_status_group'
export type HCDeliveryInclude = 'company' | 'ref_jurisdiction' | 'document_type'

// ─── Stored token (Supabase) ──────────────────────────────────

export interface HCStoredToken {
  id?: string
  access_token: string
  refresh_token: string
  expires_at: string    // ISO 8601 — when access_token expires
  created_at?: string
  updated_at?: string
}
