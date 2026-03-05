// GET /api/qb/test
//
// Diagnostic endpoint — tests QB API on BOTH production and sandbox
// to determine if the issue is Development vs Production keys

import { NextResponse } from 'next/server'
import { getActiveToken } from '@/lib/quickbooks'

export async function GET() {
  try {
    const realmId = process.env.QB_REALM_ID!
    const clientId = process.env.QB_CLIENT_ID!
    const accessToken = await getActiveToken()

    // Test BOTH endpoints to determine which environment the keys are for
    const productionUrl = `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`
    const sandboxUrl = `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`

    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    }

    // Test Production API
    const prodResponse = await fetch(productionUrl, { method: 'GET', headers })
    const prodStatus = prodResponse.status
    const prodText = await prodResponse.text()

    // Test Sandbox API
    const sandboxResponse = await fetch(sandboxUrl, { method: 'GET', headers })
    const sandboxStatus = sandboxResponse.status
    const sandboxText = await sandboxResponse.text()

    // Determine which environment works
    let diagnosis = 'UNKNOWN'
    if (prodStatus === 200 && sandboxStatus !== 200) {
      diagnosis = 'PRODUCTION_KEYS_OK'
    } else if (sandboxStatus === 200 && prodStatus !== 200) {
      diagnosis = 'USING_DEVELOPMENT_KEYS — tokens only work on sandbox, not production!'
    } else if (prodStatus === 200 && sandboxStatus === 200) {
      diagnosis = 'BOTH_WORK'
    } else {
      diagnosis = 'NEITHER_WORKS — possible token or realm_id issue'
    }

    const result: Record<string, unknown> = {
      diagnosis,
      client_id_prefix: clientId.substring(0, 10) + '...',
      realm_id: realmId,
      token_length: accessToken.length,
      production: {
        status: prodStatus,
        ok: prodStatus === 200,
      },
      sandbox: {
        status: sandboxStatus,
        ok: sandboxStatus === 200,
      },
    }

    // If production works, include company info
    if (prodStatus === 200) {
      try {
        const data = JSON.parse(prodText)
        result.company = data.CompanyInfo?.CompanyName
      } catch { /* ignore parse errors */ }
    }

    // If sandbox works, include sandbox company info
    if (sandboxStatus === 200) {
      try {
        const data = JSON.parse(sandboxText)
        result.sandbox_company = data.CompanyInfo?.CompanyName
      } catch { /* ignore parse errors */ }
    }

    // Include error details if both fail
    if (prodStatus !== 200 && sandboxStatus !== 200) {
      result.production_error = prodText.substring(0, 200)
      result.sandbox_error = sandboxText.substring(0, 200)
    }

    return NextResponse.json(result)

  } catch (err) {
    return NextResponse.json(
      { test: 'ERROR', error: String(err) },
      { status: 500 }
    )
  }
}
