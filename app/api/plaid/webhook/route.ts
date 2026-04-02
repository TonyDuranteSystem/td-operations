/**
 * POST /api/plaid/webhook
 * Receives Plaid webhook events and triggers transaction sync.
 *
 * Security: Verifies Plaid JWT-based webhook signatures.
 * The Plaid-Verification header contains a JWT signed with a key from Plaid's JWKS.
 * We verify the signature, check the body hash, and validate freshness.
 *
 * Register this URL in Plaid Dashboard: <your-domain>/api/plaid/webhook
 */

import { NextRequest, NextResponse } from 'next/server'
import { syncPlaidTransactions } from '@/lib/plaid-sync'
import { supabaseAdmin } from '@/lib/supabase-admin'
import * as jose from 'jose'
import { createHash } from 'crypto'

const PLAID_WEBHOOK_MAX_AGE_SECONDS = 300 // 5 minutes

async function verifyPlaidWebhook(req: NextRequest, body: string): Promise<boolean> {
  // If Plaid credentials aren't configured, skip verification gracefully
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    console.warn('[plaid-webhook] Plaid credentials not configured — skipping signature verification')
    return true
  }

  const verificationHeader = req.headers.get('plaid-verification')
  if (!verificationHeader) {
    console.error('[plaid-webhook] Missing Plaid-Verification header')
    return false
  }

  try {
    // Decode JWT header to get key_id
    const protectedHeader = jose.decodeProtectedHeader(verificationHeader)
    const keyId = protectedHeader.kid
    if (!keyId) {
      console.error('[plaid-webhook] JWT header missing kid')
      return false
    }

    // Fetch the verification key from Plaid
    const { plaidClient } = await import('@/lib/plaid')
    const keyResponse = await plaidClient.webhookVerificationKeyGet({
      key_id: keyId,
    })

    const jwk = keyResponse.data.key
    const publicKey = await jose.importJWK(jwk as jose.JWK)

    // Verify the JWT signature and claims
    const { payload } = await jose.jwtVerify(verificationHeader, publicKey, {
      algorithms: ['ES256'],
    })

    // Check body hash: SHA-256 of the raw request body
    const expectedHash = createHash('sha256').update(body).digest('hex')
    if (payload.request_body_sha256 !== expectedHash) {
      console.error('[plaid-webhook] Body hash mismatch')
      return false
    }

    // Check freshness: iat should be within MAX_AGE seconds
    const iat = payload.iat
    if (iat) {
      const ageSeconds = Math.floor(Date.now() / 1000) - iat
      if (ageSeconds > PLAID_WEBHOOK_MAX_AGE_SECONDS) {
        console.error(`[plaid-webhook] JWT too old: ${ageSeconds}s (max ${PLAID_WEBHOOK_MAX_AGE_SECONDS}s)`)
        return false
      }
    }

    return true
  } catch (err) {
    console.error('[plaid-webhook] Verification failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  // Verify webhook signature
  const isValid = await verifyPlaidWebhook(req, rawBody)
  if (!isValid) {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }

  const body = JSON.parse(rawBody)
  const { webhook_type, webhook_code, item_id } = body

  // Log webhook for debugging
  await supabaseAdmin.from('webhook_events').insert({
    source: 'plaid',
    event_type: `${webhook_type}.${webhook_code}`,
    payload: body,
  }).then(() => null)

  if (webhook_type === 'TRANSACTIONS') {
    if (webhook_code === 'SYNC_UPDATES_AVAILABLE' || webhook_code === 'DEFAULT_UPDATE') {
      // Get access token for this item
      const { data: connection } = await supabaseAdmin
        .from('plaid_connections')
        .select('access_token, bank_name')
        .eq('item_id', item_id)
        .single()

      if (connection) {
        await syncPlaidTransactions(connection.access_token, connection.bank_name)
      }
    }
  }

  return NextResponse.json({ received: true })
}
