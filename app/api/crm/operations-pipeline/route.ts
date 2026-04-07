import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isDashboardUser(user)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const now = Date.now()
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .split('T')[0]

    // Run all queries in parallel
    const [
      offersResult,
      awaitingPaymentResult,
      awaitingActivationResult,
      activeServicesResult,
      revenueResult,
    ] = await Promise.all([
      // 1. Pending offers (sent/viewed, not signed)
      supabaseAdmin
        .from('offers')
        .select('token, client_name, client_email, status, contract_type, created_at, account_id, lead_id, cost_summary')
        .in('status', ['sent', 'viewed'])
        .order('created_at', { ascending: false }),

      // 2. Awaiting payment (signed but not paid)
      supabaseAdmin
        .from('pending_activations')
        .select('id, offer_token, client_email, signed_at, payment_method, status')
        .not('signed_at', 'is', null)
        .is('payment_confirmed_at', null)
        .order('signed_at', { ascending: true }),

      // 3. Awaiting activation (paid but not activated)
      supabaseAdmin
        .from('pending_activations')
        .select('id, offer_token, client_email, payment_confirmed_at, payment_method, status')
        .not('payment_confirmed_at', 'is', null)
        .is('activated_at', null)
        .order('payment_confirmed_at', { ascending: true }),

      // 4. Active service deliveries grouped by account
      supabaseAdmin
        .from('service_deliveries')
        .select('id, account_id, service_name, service_type, stage, status, updated_at, pipeline')
        .eq('status', 'active')
        .order('updated_at', { ascending: false }),

      // 5. Revenue: payments collected this month
      supabaseAdmin
        .from('payments')
        .select('amount, amount_currency, paid_date, status')
        .eq('status', 'Paid')
        .gte('paid_date', monthStart),
    ])

    // Process offers - add days_in_stage and extract value
    const pendingOffers = (offersResult.data ?? []).map(o => ({
      token: o.token,
      client_name: o.client_name,
      status: o.status,
      contract_type: o.contract_type,
      account_id: o.account_id,
      lead_id: o.lead_id,
      days_in_stage: Math.floor((now - new Date(o.created_at).getTime()) / (1000 * 60 * 60 * 24)),
      value: extractOfferValue(o.cost_summary),
    }))

    // Process awaiting payment - enrich with offer data
    const awaitingPaymentTokens = (awaitingPaymentResult.data ?? []).map(pa => pa.offer_token)
    const awaitingPaymentOffers: Record<string, { client_name: string; contract_type: string | null; cost_summary: unknown }> = {}
    if (awaitingPaymentTokens.length > 0) {
      const { data: offerData } = await supabaseAdmin
        .from('offers')
        .select('token, client_name, contract_type, cost_summary')
        .in('token', awaitingPaymentTokens)
      for (const o of offerData ?? []) {
        awaitingPaymentOffers[o.token] = o
      }
    }

    const awaitingPayment = (awaitingPaymentResult.data ?? []).map(pa => {
      const daysSinceSigned = Math.floor((now - new Date(pa.signed_at).getTime()) / (1000 * 60 * 60 * 24))
      return {
        offer_token: pa.offer_token,
        client_name: awaitingPaymentOffers[pa.offer_token]?.client_name ?? pa.client_email,
        contract_type: awaitingPaymentOffers[pa.offer_token]?.contract_type ?? null,
        signed_at: pa.signed_at,
        days_since_signed: daysSinceSigned,
        value: extractOfferValue(awaitingPaymentOffers[pa.offer_token]?.cost_summary),
        urgency: daysSinceSigned > 7 ? 'red' : daysSinceSigned > 3 ? 'amber' : 'green',
      }
    })

    // Process awaiting activation
    const awaitingActivationTokens = (awaitingActivationResult.data ?? []).map(pa => pa.offer_token)
    const awaitingActivationOffers: Record<string, { client_name: string }> = {}
    if (awaitingActivationTokens.length > 0) {
      const { data: offerData } = await supabaseAdmin
        .from('offers')
        .select('token, client_name')
        .in('token', awaitingActivationTokens)
      for (const o of offerData ?? []) {
        awaitingActivationOffers[o.token] = o
      }
    }

    const awaitingActivation = (awaitingActivationResult.data ?? []).map(pa => {
      const daysSincePaid = Math.floor((now - new Date(pa.payment_confirmed_at).getTime()) / (1000 * 60 * 60 * 24))
      return {
        offer_token: pa.offer_token,
        client_name: awaitingActivationOffers[pa.offer_token]?.client_name ?? pa.client_email,
        payment_confirmed_at: pa.payment_confirmed_at,
        payment_method: pa.payment_method,
        days_since_paid: daysSincePaid,
        urgency: daysSincePaid > 2 ? 'red' : 'green',
      }
    })

    // Process active services - group by account
    const servicesByAccount = new Map<string, Array<{ service_name: string | null; stage: string | null; pipeline: string | null; updated_at: string }>>()
    for (const sd of activeServicesResult.data ?? []) {
      if (!sd.account_id) continue
      if (!servicesByAccount.has(sd.account_id)) servicesByAccount.set(sd.account_id, [])
      servicesByAccount.get(sd.account_id)!.push({
        service_name: sd.service_name,
        stage: sd.stage,
        pipeline: sd.pipeline,
        updated_at: sd.updated_at,
      })
    }

    // Fetch account names for service accounts
    const accountIds = Array.from(servicesByAccount.keys())
    const accountNames: Record<string, string> = {}
    if (accountIds.length > 0) {
      const { data: accounts } = await supabaseAdmin
        .from('accounts')
        .select('id, company_name')
        .in('id', accountIds)
      for (const a of accounts ?? []) {
        accountNames[a.id] = a.company_name
      }
    }

    // Split services into "onboarding" (early stages) and "in_service" (later stages)
    const EARLY_STAGES = ['New', 'Data Collection']
    const onboarding: Array<{ account_id: string; company_name: string; services: Array<{ service_name: string | null; stage: string | null }> }> = []
    const inService: Array<{ account_id: string; company_name: string; services: Array<{ service_name: string | null; stage: string | null; days_in_stage: number }> }> = []

    for (const [accountId, services] of Array.from(servicesByAccount.entries())) {
      const companyName = accountNames[accountId] ?? 'Unknown'
      const earlyServices = services.filter(s => EARLY_STAGES.includes(s.stage ?? ''))
      const laterServices = services.filter(s => !EARLY_STAGES.includes(s.stage ?? ''))

      if (earlyServices.length > 0 && laterServices.length === 0) {
        onboarding.push({
          account_id: accountId,
          company_name: companyName,
          services: earlyServices.map(s => ({ service_name: s.service_name, stage: s.stage })),
        })
      } else if (laterServices.length > 0) {
        inService.push({
          account_id: accountId,
          company_name: companyName,
          services: laterServices.map(s => ({
            service_name: s.service_name,
            stage: s.stage,
            days_in_stage: Math.floor((now - new Date(s.updated_at).getTime()) / (1000 * 60 * 60 * 24)),
          })),
        })
      }
    }

    // Revenue summary
    const monthlyRevenue = (revenueResult.data ?? []).reduce((sum, p) => {
      const amount = p.amount ?? 0
      return sum + amount
    }, 0)

    const pendingOffersValue = pendingOffers.reduce((sum, o) => sum + (o.value ?? 0), 0)
    const awaitingPaymentValue = awaitingPayment.reduce((sum, o) => sum + (o.value ?? 0), 0)

    return NextResponse.json({
      pipeline: {
        pending_offers: pendingOffers,
        awaiting_payment: awaitingPayment,
        awaiting_activation: awaitingActivation,
        onboarding,
        in_service: inService,
      },
      counts: {
        pending_offers: pendingOffers.length,
        awaiting_payment: awaitingPayment.length,
        awaiting_activation: awaitingActivation.length,
        onboarding: onboarding.length,
        in_service: inService.length,
      },
      revenue: {
        pending_offers_value: pendingOffersValue,
        awaiting_payment_value: awaitingPaymentValue,
        collected_this_month: monthlyRevenue,
      },
    })
  } catch (err) {
    console.error('Operations pipeline error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

function extractOfferValue(costSummary: unknown): number {
  if (!Array.isArray(costSummary)) return 0
  let total = 0
  for (const group of costSummary) {
    const t = (group as Record<string, unknown>)?.total as string
    if (t) {
      const num = parseFloat(t.replace(/[^0-9.]/g, ''))
      if (!isNaN(num)) total += num
    }
  }
  return total
}
