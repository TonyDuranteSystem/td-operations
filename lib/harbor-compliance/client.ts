/**
 * Harbor Compliance API Client
 *
 * OAuth2 authenticated client for HC's REST API.
 * Handles: token management (password grant + refresh), pagination, includes.
 *
 * Env vars required:
 *   HC_CLIENT_ID, HC_CLIENT_SECRET, HC_USERNAME, HC_PASSWORD
 * Optional:
 *   HC_API_BASE_URL (default: https://www.harborcompliance.com/api/v1)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type {
  HCAccount, HCAccountInput, HCAccountInclude,
  HCCompany, HCCompanyInput, HCCompanyInclude,
  HCCompanyRegistration, HCLicenseInclude, HCLicenseHolderTypeFilter,
  HCOrder, HCOrderCreateInput, HCOrderUpdateInput,
  HCRegisteredAgentDelivery, HCDeliveryInclude,
  HCJurisdiction, HCDocumentType, HCBusinessStructure, HCProduct,
  HCTokenResponse, HCStoredToken,
  HCPaginatedResponse, HCSingleResponse, HCPaginationParams,
} from './types'

// ─── Configuration ────────────────────────────────────────────

function getConfig() {
  const clientId = process.env.HC_CLIENT_ID
  const clientSecret = process.env.HC_CLIENT_SECRET
  const username = process.env.HC_USERNAME
  const password = process.env.HC_PASSWORD
  const baseUrl = process.env.HC_API_BASE_URL || 'https://www.harborcompliance.com/api/v1'

  if (!clientId || !clientSecret) {
    throw new Error('Harbor Compliance: HC_CLIENT_ID and HC_CLIENT_SECRET are required')
  }
  if (!username || !password) {
    throw new Error('Harbor Compliance: HC_USERNAME and HC_PASSWORD are required for password grant')
  }

  return { clientId, clientSecret, username, password, baseUrl }
}

// ─── Token Management ─────────────────────────────────────────

const TOKEN_ROW_ID = 'harbor-compliance'
const TOKEN_BUFFER_SECONDS = 300  // refresh 5 min before expiry

async function getStoredToken(): Promise<HCStoredToken | null> {
  const { data } = await supabaseAdmin
    .from('hc_tokens')
    .select('*')
    .eq('id', TOKEN_ROW_ID)
    .maybeSingle()
  return data
}

async function saveToken(token: HCStoredToken): Promise<void> {
  await supabaseAdmin
    .from('hc_tokens')
    .upsert({ ...token, id: TOKEN_ROW_ID, updated_at: new Date().toISOString() })
}

async function requestPasswordGrant(): Promise<HCTokenResponse> {
  const { clientId, clientSecret, username, password, baseUrl } = getConfig()

  const res = await fetch(`${baseUrl}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'admin',
      username,
      password,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HC OAuth password grant failed (${res.status}): ${body}`)
  }

  return res.json()
}

async function requestRefreshGrant(refreshToken: string): Promise<HCTokenResponse> {
  const { clientId, clientSecret, baseUrl } = getConfig()

  const res = await fetch(`${baseUrl}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'admin',
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HC OAuth refresh failed (${res.status}): ${body}`)
  }

  return res.json()
}

/** Get a valid access token, refreshing or re-authenticating as needed */
async function getAccessToken(): Promise<string> {
  const stored = await getStoredToken()

  // If we have a stored token that's still valid, use it
  if (stored) {
    const expiresAt = new Date(stored.expires_at).getTime()
    const now = Date.now()
    if (expiresAt - now > TOKEN_BUFFER_SECONDS * 1000) {
      return stored.access_token
    }

    // Try refresh (HC refresh tokens are single-use, 30-day lifetime)
    try {
      const refreshed = await requestRefreshGrant(stored.refresh_token)
      const newStored: HCStoredToken = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      }
      await saveToken(newStored)
      return newStored.access_token
    } catch {
      // Refresh failed — fall through to password grant
    }
  }

  // Fresh password grant
  const fresh = await requestPasswordGrant()
  const newStored: HCStoredToken = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
  }
  await saveToken(newStored)
  return newStored.access_token
}

// ─── HTTP Helpers ─────────────────────────────────────────────

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>
  body?: unknown
  rawResponse?: boolean  // return raw Response (for binary downloads)
}

async function hcFetch<_T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions & { rawResponse: true }
): Promise<Response>
async function hcFetch<T>(
  method: HttpMethod,
  path: string,
  options?: RequestOptions
): Promise<T>
async function hcFetch<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {}
): Promise<T | Response> {
  const { baseUrl } = getConfig()
  const token = await getAccessToken()

  // Build URL with query params
  const url = new URL(`${baseUrl}${path}`)
  if (options.params) {
    for (const [key, val] of Object.entries(options.params)) {
      if (val !== undefined && val !== null) {
        url.searchParams.set(key, String(val))
      }
    }
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  }
  if (options.body) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (options.rawResponse) return res

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HC API ${method} ${path} failed (${res.status}): ${body}`)
  }

  // 204 No Content (DELETE)
  if (res.status === 204) return undefined as T

  return res.json()
}

// ─── Include & Filter helpers ─────────────────────────────────

function buildParams(
  pagination?: HCPaginationParams,
  include?: string[],
  filters?: Record<string, string | undefined>
): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {}
  if (pagination?.limit) params.limit = pagination.limit
  if (pagination?.page) params.page = pagination.page
  if (include?.length) params.include = include.join(',')
  if (filters) {
    for (const [key, val] of Object.entries(filters)) {
      if (val !== undefined) params[`filter[${key}]`] = val
    }
  }
  return params
}

// ─── Public API ───────────────────────────────────────────────

export const harborCompliance = {
  // ── Accounts ──────────────────────────────────────────────

  /** List accounts (paginated, filterable by name) */
  async listAccounts(opts?: {
    pagination?: HCPaginationParams
    include?: HCAccountInclude[]
    filterName?: string
  }): Promise<HCPaginatedResponse<HCAccount>> {
    return hcFetch('GET', '/accounts', {
      params: buildParams(opts?.pagination, opts?.include, { name: opts?.filterName }),
    })
  },

  /** Get account by ID */
  async getAccount(id: string, include?: HCAccountInclude[]): Promise<HCSingleResponse<HCAccount>> {
    return hcFetch('GET', `/accounts/${id}`, {
      params: include?.length ? { include: include.join(',') } : undefined,
    })
  },

  /** Create a new account */
  async createAccount(input: HCAccountInput): Promise<HCSingleResponse<HCAccount>> {
    return hcFetch('POST', '/accounts', { body: input })
  },

  /** Update an account */
  async updateAccount(id: string, input: Partial<HCAccountInput>): Promise<HCSingleResponse<HCAccount>> {
    return hcFetch('PATCH', `/accounts/${id}`, { body: input })
  },

  // ── Companies ─────────────────────────────────────────────

  /** List companies (filterable by account_id) */
  async listCompanies(opts?: {
    pagination?: HCPaginationParams
    include?: HCCompanyInclude[]
    accountId?: string
  }): Promise<HCPaginatedResponse<HCCompany>> {
    return hcFetch('GET', '/companies', {
      params: buildParams(opts?.pagination, opts?.include, { account_id: opts?.accountId }),
    })
  },

  /** Get company by ID */
  async getCompany(id: string, include?: HCCompanyInclude[]): Promise<HCSingleResponse<HCCompany>> {
    return hcFetch('GET', `/companies/${id}`, {
      params: include?.length ? { include: include.join(',') } : undefined,
    })
  },

  /** Create a company (auto-enrolls in Entity Manager) */
  async createCompany(input: HCCompanyInput): Promise<HCSingleResponse<HCCompany>> {
    return hcFetch('POST', '/companies', { body: input })
  },

  /** Update a company */
  async updateCompany(id: string, input: Partial<HCCompanyInput>): Promise<HCSingleResponse<HCCompany>> {
    return hcFetch('PATCH', `/companies/${id}`, { body: { data: input } })
  },

  /** Delete a company */
  async deleteCompany(id: string): Promise<void> {
    await hcFetch('DELETE', `/companies/${id}`)
  },

  // ── Orders ────────────────────────────────────────────────

  /**
   * Create an order.
   * Allowed products: "Annual Report", "Change of Registered Agent", "Registered Agent"
   */
  async createOrder(input: HCOrderCreateInput): Promise<HCSingleResponse<HCOrder>> {
    return hcFetch('POST', '/orders', { body: input })
  },

  /** Get order by ID */
  async getOrder(id: string): Promise<HCSingleResponse<HCOrder>> {
    return hcFetch('GET', `/orders/${id}`)
  },

  /** Update an unsubmitted order */
  async updateOrder(id: string, input: HCOrderUpdateInput): Promise<HCSingleResponse<HCOrder>> {
    return hcFetch('PATCH', `/orders/${id}`, { body: input })
  },

  // ── Registered Agent Deliveries ───────────────────────────

  /** List RA deliveries (mail/packages received) */
  async listDeliveries(opts?: {
    pagination?: HCPaginationParams
    include?: HCDeliveryInclude[]
    accountId?: string
  }): Promise<HCPaginatedResponse<HCRegisteredAgentDelivery>> {
    return hcFetch('GET', '/registered-agent-deliveries', {
      params: buildParams(opts?.pagination, opts?.include, { account_id: opts?.accountId }),
    })
  },

  /** Get delivery by ID */
  async getDelivery(id: string, opts?: {
    include?: HCDeliveryInclude[]
    accountId?: string
  }): Promise<HCSingleResponse<HCRegisteredAgentDelivery>> {
    return hcFetch('GET', `/registered-agent-deliveries/${id}`, {
      params: buildParams(undefined, opts?.include, { account_id: opts?.accountId }),
    })
  },

  /** Download delivery document as binary (PDF) */
  async downloadDeliveryFile(id: string, accountId?: string): Promise<Buffer> {
    const res = await hcFetch<Response>('GET', `/registered-agent-deliveries/${id}/file`, {
      params: accountId ? { 'filter[account_id]': accountId } : undefined,
      rawResponse: true,
    })
    if (!res.ok) {
      throw new Error(`HC download delivery file failed (${res.status})`)
    }
    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  },

  // ── Licenses ──────────────────────────────────────────────

  /** List licenses/registrations */
  async listLicenses(opts?: {
    pagination?: HCPaginationParams
    include?: HCLicenseInclude[]
    holderType?: HCLicenseHolderTypeFilter
    companyId?: string
  }): Promise<HCPaginatedResponse<HCCompanyRegistration>> {
    return hcFetch('GET', '/licenses', {
      params: buildParams(opts?.pagination, opts?.include, {
        license_holder_type: opts?.holderType,
        company_id: opts?.companyId,
      }),
    })
  },

  /** Get license by ID */
  async getLicense(id: string, include?: HCLicenseInclude[]): Promise<HCSingleResponse<HCCompanyRegistration>> {
    return hcFetch('GET', `/licenses/${id}`, {
      params: include?.length ? { include: include.join(',') } : undefined,
    })
  },

  // ── Reference Data ────────────────────────────────────────

  /** List all jurisdictions (paginated) */
  async listJurisdictions(pagination?: HCPaginationParams): Promise<HCPaginatedResponse<HCJurisdiction>> {
    return hcFetch('GET', '/jurisdictions', { params: buildParams(pagination) })
  },

  /** List all document types */
  async listDocumentTypes(pagination?: HCPaginationParams): Promise<HCPaginatedResponse<HCDocumentType>> {
    return hcFetch('GET', '/document-types', { params: buildParams(pagination) })
  },

  /** List all business structures */
  async listBusinessStructures(pagination?: HCPaginationParams): Promise<HCPaginatedResponse<HCBusinessStructure>> {
    return hcFetch('GET', '/business-structures', { params: buildParams(pagination) })
  },

  /** List all products */
  async listProducts(pagination?: HCPaginationParams): Promise<HCPaginatedResponse<HCProduct>> {
    return hcFetch('GET', '/products', { params: buildParams(pagination) })
  },
}
