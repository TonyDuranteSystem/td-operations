/**
 * QuickBooks Online API Helper
 * Handles OAuth2 token management and API calls
 *
 * Token lifecycle:
 * - Access token: 1 hour
 * - Refresh token: 101 days
 * - Auto-refresh before expiry via cron or on-demand
 */

import { createClient } from '@supabase/supabase-js'

// Supabase admin client (bypasses RLS for token storage)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// QuickBooks OAuth2 endpoints
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2'
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'

// API base — uses QB_BASE_URL env var (sandbox or production)
const QB_API_BASE = process.env.QB_BASE_URL
  ? process.env.QB_BASE_URL.replace(/\/v3\/company\/.*$/, '/v3/company')
  : 'https://quickbooks.api.intuit.com/v3/company'

// Scopes
const QB_SCOPES = 'com.intuit.quickbooks.accounting'

/**
 * Generate the OAuth2 authorization URL
 * User gets redirected here to grant access
 */
export function getAuthorizationUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID!,
    redirect_uri: process.env.QB_REDIRECT_URI!,
    response_type: 'code',
    scope: QB_SCOPES,
    state: state || 'td-operations-qb-auth',
  })

  return `${QB_AUTH_URL}?${params.toString()}`
}

/**
 * Exchange authorization code for access + refresh tokens
 */
export async function exchangeCodeForTokens(code: string) {
  const credentials = Buffer.from(
    `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
  ).toString('base64')

  const response = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.QB_REDIRECT_URI!,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Token exchange failed: ${response.status} — ${error}`)
  }

  return response.json()
}

/**
 * Refresh an expired access token using the refresh token
 */
export async function refreshAccessToken(refreshToken: string) {
  const credentials = Buffer.from(
    `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
  ).toString('base64')

  const response = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Token refresh failed: ${response.status} — ${error}`)
  }

  return response.json()
}

/**
 * Store tokens in Supabase (deactivates previous tokens first)
 *
 * Uses UPDATE (not delete+insert) to avoid unique constraint issues.
 * Falls back to upsert if no active row exists.
 */
export async function storeTokens(tokenData: {
  access_token: string
  refresh_token: string
  expires_in: number         // seconds (typically 3600 = 1h)
  x_refresh_token_expires_in: number  // seconds (typically 8726400 = 101 days)
  token_type: string
}, userId?: string) {
  const realmId = process.env.QB_REALM_ID!
  const now = new Date()

  // Calculate expiry timestamps
  const accessExpires = new Date(now.getTime() + tokenData.expires_in * 1000)
  const refreshExpires = new Date(now.getTime() + tokenData.x_refresh_token_expires_in * 1000)

  // Strategy: UPDATE the existing active row in-place (avoids constraint issues)
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('qb_tokens')
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type || 'bearer',
      access_token_expires_at: accessExpires.toISOString(),
      refresh_token_expires_at: refreshExpires.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('realm_id', realmId)
    .eq('is_active', true)
    .select()
    .single()

  if (!updateErr && updated) {
    console.log('[QB] Token refreshed and saved to Supabase')
    return updated
  }

  // Fallback: no active row found — insert a new one
  console.warn('[QB] No active token row to update, inserting new row...')

  // Clean up any stale inactive rows first
  const { error: cleanupErr } = await supabaseAdmin
    .from('qb_tokens')
    .delete()
    .eq('realm_id', realmId)
    .eq('is_active', false)

  if (cleanupErr) {
    console.error('[QB] Cleanup failed:', cleanupErr.message)
  }

  const { data, error } = await supabaseAdmin
    .from('qb_tokens')
    .insert({
      realm_id: realmId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type || 'bearer',
      access_token_expires_at: accessExpires.toISOString(),
      refresh_token_expires_at: refreshExpires.toISOString(),
      created_by: userId || null,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error('[QB] Failed to store tokens:', error.message, error.details)
    throw new Error(`Failed to store tokens: ${error.message}`)
  }

  console.log('[QB] New token row inserted')
  return data
}

/**
 * Get the current active token, auto-refreshing if expired
 */
export async function getActiveToken(): Promise<string> {
  const realmId = process.env.QB_REALM_ID!

  // Fetch active token
  const { data: token, error } = await supabaseAdmin
    .from('qb_tokens')
    .select('*')
    .eq('realm_id', realmId)
    .eq('is_active', true)
    .single()

  if (error || !token) {
    throw new Error('No active QB token found. Please re-authorize at /api/qb/authorize')
  }

  // Check if access token is still valid (with 5 min buffer)
  const now = new Date()
  const expiresAt = new Date(token.access_token_expires_at)
  const bufferMs = 5 * 60 * 1000 // 5 minutes

  if (now.getTime() < expiresAt.getTime() - bufferMs) {
    // Token still valid
    return token.access_token
  }

  // Check if refresh token is still valid
  const refreshExpiresAt = new Date(token.refresh_token_expires_at)
  if (now.getTime() >= refreshExpiresAt.getTime()) {
    throw new Error('Refresh token expired. Please re-authorize at /api/qb/authorize')
  }

  // Auto-refresh the access token
  console.log('[QB] Access token expired, refreshing...')
  const newTokenData = await refreshAccessToken(token.refresh_token)
  await storeTokens(newTokenData, token.created_by)

  return newTokenData.access_token
}

/**
 * Make an authenticated API call to QuickBooks
 */
export async function qbApiCall(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: Record<string, unknown>
  } = {}
) {
  const accessToken = await getActiveToken()
  const realmId = process.env.QB_REALM_ID!
  const baseUrl = `${QB_API_BASE}/${realmId}`

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`QB API error: ${response.status} — ${error}`)
  }

  return response.json()
}

/**
 * Get the next sequential DocNumber (INV-XXXXXX format)
 * Queries QB for the highest existing DocNumber and increments
 */
async function getNextDocNumber(): Promise<string> {
  const query = encodeURIComponent(
    "SELECT DocNumber FROM Invoice WHERE DocNumber LIKE 'INV-%' ORDERBY DocNumber DESC MAXRESULTS 1"
  )
  const result = await qbApiCall(`/query?query=${query}`)
  const invoices = result.QueryResponse?.Invoice || []

  if (invoices.length > 0) {
    const lastDoc = invoices[0].DocNumber as string
    const numPart = parseInt(lastDoc.replace('INV-', ''), 10)
    return `INV-${String(numPart + 1).padStart(6, '0')}`
  }

  return 'INV-000001'
}

/**
 * Create an invoice in QuickBooks
 */
export async function createInvoice(params: {
  customerName: string
  customerEmail?: string
  lineItems: Array<{
    description: string
    amount: number
    quantity?: number
  }>
  dueDate?: string  // YYYY-MM-DD format
  memo?: string
}) {
  // First, find or create the customer
  const customerRef = await findOrCreateCustomer(params.customerName, params.customerEmail)

  // Build the invoice object — online payments always disabled (we send via Postmark with bank details)
  const invoice: Record<string, unknown> = {
    CustomerRef: {
      value: customerRef.id,
      name: customerRef.name,
    },
    Line: params.lineItems.map((item, index) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: item.amount * (item.quantity || 1),
      Description: item.description,
      SalesItemLineDetail: {
        Qty: item.quantity || 1,
        UnitPrice: item.amount,
      },
      LineNum: index + 1,
    })),
    AllowOnlineCreditCardPayment: false,
    AllowOnlineACHPayment: false,
  }

  if (params.dueDate) {
    invoice.DueDate = params.dueDate
  }

  if (params.memo) {
    invoice.PrivateNote = params.memo
  }

  // Auto-assign sequential DocNumber
  invoice.DocNumber = await getNextDocNumber()

  // Create the invoice
  return qbApiCall('/invoice', {
    method: 'POST',
    body: invoice,
  })
}

/**
 * Find a customer by name, or create one if not found
 */
async function findOrCreateCustomer(
  displayName: string,
  email?: string
): Promise<{ id: string; name: string }> {
  // Search for existing customer
  const query = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}'`)
  const searchResult = await qbApiCall(`/query?query=${query}`)

  if (searchResult.QueryResponse?.Customer?.length > 0) {
    const customer = searchResult.QueryResponse.Customer[0]
    return { id: customer.Id, name: customer.DisplayName }
  }

  // Customer not found — create new one
  const newCustomer: Record<string, unknown> = {
    DisplayName: displayName,
  }

  if (email) {
    newCustomer.PrimaryEmailAddr = { Address: email }
  }

  const result = await qbApiCall('/customer', {
    method: 'POST',
    body: newCustomer,
  })

  return {
    id: result.Customer.Id,
    name: result.Customer.DisplayName,
  }
}
