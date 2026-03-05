// GET /api/qb/test
//
// Diagnostic endpoint — tests QB API connectivity
// Tries a simple CompanyInfo read to verify authorization works

import { NextResponse } from 'next/server'
import { getActiveToken } from '@/lib/quickbooks'

export async function GET() {
  try {
    const realmId = process.env.QB_REALM_ID!
    const accessToken = await getActiveToken()

    // Test 1: Get company info (simplest possible API call)
    const companyUrl = `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`

    console.log(`[QB Test] Calling: ${companyUrl}`)
    console.log(`[QB Test] Token (first 20 chars): ${accessToken.substring(0, 20)}...`)

    const response = await fetch(companyUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    })

    const responseText = await response.text()

    if (!response.ok) {
      return NextResponse.json({
        test: 'FAILED',
        status_code: response.status,
        realm_id: realmId,
        token_length: accessToken.length,
        error: responseText,
        hint: response.status === 403
          ? 'App not authorized for this company. Try re-authorizing at /api/qb/authorize'
          : 'Unknown error',
      })
    }

    const data = JSON.parse(responseText)
    const company = data.CompanyInfo

    return NextResponse.json({
      test: 'PASSED',
      company_name: company?.CompanyName,
      company_id: company?.Id,
      legal_name: company?.LegalName,
      country: company?.Country,
      realm_id: realmId,
      token_length: accessToken.length,
    })

  } catch (err) {
    return NextResponse.json(
      { test: 'ERROR', error: String(err) },
      { status: 500 }
    )
  }
}
