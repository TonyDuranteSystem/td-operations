import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { APP_BASE_URL } from '@/lib/config'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { getBankDetailsByPreference, type BankPreference } from '@/app/offer/[token]/contract/bank-defaults'
import type { Json } from '@/lib/database.types'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'create_offer')) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await req.json()
    const {
      lead_id,
      account_id,
      client_name,
      client_email,
      language,
      contract_type,
      payment_type,
      payment_gateway,
      bank_preference,
      services,
      cost_summary,
      recurring_costs,
      bundled_pipelines,
      referrer_name,
      referrer_type,
      required_documents,
      issues,
      admin_notes,
      installment_currency,
      // Narrative content (client-facing sections)
      intro_en,
      intro_it,
      strategy,
      next_steps,
      future_developments,
      immediate_actions,
    } = body

    if (!client_name || !client_email) {
      return NextResponse.json({ error: 'client_name and client_email are required' }, { status: 400 })
    }

    if (!lead_id && !account_id) {
      return NextResponse.json({ error: 'Either lead_id or account_id is required' }, { status: 400 })
    }

    if (!services || !cost_summary) {
      return NextResponse.json({ error: 'services and cost_summary are required' }, { status: 400 })
    }

    // Validate lead or account exists
    if (lead_id) {
      const { data: lead, error: leadErr } = await supabaseAdmin
        .from('leads')
        .select('id, full_name, email')
        .eq('id', lead_id)
        .single()

      if (leadErr || !lead) {
        return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
      }
    }

    if (account_id) {
      const { data: acct, error: acctErr } = await supabaseAdmin
        .from('accounts')
        .select('id, company_name')
        .eq('id', account_id)
        .single()

      if (acctErr || !acct) {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 })
      }
    }

    // Check if offer already exists for this lead/account
    const duplicateQuery = supabaseAdmin.from('offers').select('token').limit(1)
    if (lead_id) duplicateQuery.eq('lead_id', lead_id)
    else duplicateQuery.eq('account_id', account_id)
    const { data: existing } = await duplicateQuery.maybeSingle()

    if (existing) {
      return NextResponse.json({ error: `Offer already exists: ${existing.token}` }, { status: 409 })
    }

    // Generate token: firstname-lastname-year
    const nameParts = client_name.toLowerCase().trim().split(/\s+/)
    const year = new Date().getFullYear()
    let token = nameParts.join('-') + '-' + year

    // Check token uniqueness, append suffix if needed
    const { data: tokenCheck } = await supabaseAdmin
      .from('offers')
      .select('token')
      .eq('token', token)
      .maybeSingle()

    if (tokenCheck) {
      token = token + '-' + Date.now().toString(36).slice(-4)
    }

    // Use explicit currency if provided, fall back to symbol detection for legacy
    const explicitCurrency = (body.currency as string)?.toUpperCase()
    const costArr = Array.isArray(cost_summary) ? cost_summary : []
    const firstTotal = (costArr[0] as Record<string, unknown>)?.total as string || ''
    const servicesStr = JSON.stringify(services || [])
    const isEUR = explicitCurrency === 'EUR' ? true
      : explicitCurrency === 'USD' ? false
      : (firstTotal.includes('€') || firstTotal.toUpperCase().includes('EUR')
        || servicesStr.includes('€') || servicesStr.toUpperCase().includes('EUR'))

    // Use bank_preference if specified, otherwise auto-detect by currency
    const bank_details = getBankDetailsByPreference(
      (bank_preference || 'auto') as BankPreference,
      isEUR ? 'EUR' : 'USD'
    )

    // Create offer
    const { data: offer, error: offerErr } = await supabaseAdmin
      .from('offers')
      .insert({
        token,
        client_name,
        client_email,
        language: language || 'en',
        offer_date: new Date().toISOString().split('T')[0],
        status: 'draft',
        payment_type: payment_type || 'bank_transfer',
        contract_type: contract_type || 'formation',
        services,
        cost_summary,
        recurring_costs: recurring_costs || null,
        bundled_pipelines: bundled_pipelines || [],
        bank_details: bank_details as unknown as Json,
        lead_id: lead_id || null,
        account_id: account_id || null,
        required_documents: required_documents || null,
        issues: issues || null,
        admin_notes: admin_notes || null,
        // Narrative content (client-facing)
        intro_en: intro_en || null,
        intro_it: intro_it || null,
        strategy: strategy || null,
        next_steps: next_steps || null,
        future_developments: future_developments || null,
        immediate_actions: immediate_actions || null,
        currency: isEUR ? 'EUR' : 'USD',
        installment_currency: installment_currency || null,
        referrer_name: referrer_name || null,
        referrer_type: referrer_type || null,
        view_count: 0,
      })
      .select('token, access_code, status')
      .single()

    if (offerErr) {
      console.error('Offer creation error:', offerErr)
      return NextResponse.json({ error: offerErr.message }, { status: 500 })
    }

    // Update lead/account with offer link
    const offerUrl = `${APP_BASE_URL}/offer/${offer.token}/${offer.access_code || ''}`
    if (lead_id) {
      await supabaseAdmin
        .from('leads')
        .update({ offer_link: offerUrl, offer_status: 'Draft' })
        .eq('id', lead_id)
    }

    // Auto-create Whop plan if checkout + whop gateway (Stripe checkout is deferred to sign time)
    let whopCheckoutUrl: string | null = null
    if (payment_type === 'checkout' && payment_gateway === 'whop') {
      try {
        const { createWhopPlan } = await import('@/lib/whop-auto-plan')
        const totalNum = parseFloat(firstTotal.replace(/[^0-9.]/g, ''))
        if (totalNum > 0) {
          const servArr = Array.isArray(services) ? services : []
          const primaryService = (servArr[0] as Record<string, unknown>)?.name as string || undefined
          const whopResult = await createWhopPlan({
            clientName: client_name,
            amount: totalNum,
            currency: isEUR ? 'eur' : 'usd',
            contractType: contract_type || 'formation',
            serviceName: primaryService,
          })
          if (whopResult.success && whopResult.checkoutUrl) {
            const cardAmount = Math.round(totalNum * 1.05)
            await supabaseAdmin
              .from('offers')
              .update({
                payment_links: [{
                  url: whopResult.checkoutUrl,
                  label: `Pay ${isEUR ? '€' : '$'}${totalNum.toLocaleString()} by Card`,
                  amount: cardAmount,
                  gateway: 'whop',
                }],
              })
              .eq('token', token)
            whopCheckoutUrl = whopResult.checkoutUrl
          }
        }
      } catch {
        // Whop auto-plan failed — offer still created, just no card payment link
      }
    }

    // Log to action_log
    await supabaseAdmin.from('action_log').insert({
      action_type: 'create',
      table_name: 'offers',
      record_id: token,
      summary: `Offer created via CRM: ${client_name} (${token})`,
      details: { lead_id, account_id, contract_type, payment_type, payment_gateway, bank_preference, bundled_pipelines, required_documents, source: 'crm-button' },
    })

    return NextResponse.json({
      success: true,
      token: offer.token,
      offer_url: offerUrl,
      whop_checkout_url: whopCheckoutUrl,
    })
  } catch (err) {
    console.error('Create offer error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
