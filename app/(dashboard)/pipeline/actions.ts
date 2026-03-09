'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

// Mapping: deal service_type → service delivery tickets to create
const SERVICE_MAP: Record<string, { type: string; billing: string }[]> = {
  'Company Formation': [
    { type: 'Company Formation', billing: 'One-Time' },
    { type: 'EIN Application', billing: 'One-Time' },
    { type: 'State RA Renewal', billing: 'Included' },
    { type: 'State Annual Report', billing: 'Included' },
    { type: 'Tax Return', billing: 'Included' },
    { type: 'CMRA', billing: 'Included' },
  ],
  'Client Onboarding': [
    { type: 'Client Onboarding', billing: 'One-Time' },
    { type: 'State RA Renewal', billing: 'Included' },
    { type: 'State Annual Report', billing: 'Included' },
    { type: 'Tax Return', billing: 'Included' },
    { type: 'CMRA', billing: 'Included' },
  ],
  'Company Closure': [
    { type: 'Company Closure', billing: 'One-Time' },
    { type: 'Client Offboarding', billing: 'One-Time' },
  ],
  // Single-service deals
  'ITIN': [{ type: 'ITIN', billing: 'One-Time' }],
  'Banking Fintech': [{ type: 'Banking Fintech', billing: 'One-Time' }],
  'Banking Physical': [{ type: 'Banking Physical', billing: 'One-Time' }],
  'Shipping': [{ type: 'Shipping', billing: 'One-Time' }],
  'Public Notary': [{ type: 'Public Notary', billing: 'One-Time' }],
  'CMRA': [{ type: 'CMRA', billing: 'Standalone' }],
  'Tax Return': [{ type: 'Tax Return', billing: 'Standalone' }],
  'State RA Renewal': [{ type: 'State RA Renewal', billing: 'Standalone' }],
  'State Annual Report': [{ type: 'State Annual Report', billing: 'Standalone' }],
}

export async function updateDealStage(dealId: string, newStage: string) {
  const supabase = createClient()

  const updates: Record<string, unknown> = {
    stage: newStage,
    updated_at: new Date().toISOString(),
  }

  if (newStage === 'Paid') {
    updates.payment_status = 'Paid'
  }

  if (newStage === 'Closed Won') {
    updates.close_date = new Date().toISOString().split('T')[0]
  }

  const { error } = await supabase
    .from('deals')
    .update(updates)
    .eq('id', dealId)

  if (error) throw new Error(`Errore aggiornamento deal: ${error.message}`)

  // Automazione: Closed Won → crea service delivery tickets
  if (newStage === 'Closed Won') {
    await createServiceDeliveryTickets(dealId)
  }

  revalidatePath('/pipeline')
  return { success: true }
}

async function createServiceDeliveryTickets(dealId: string) {
  const supabase = createClient()

  // 1. Leggi il deal
  const { data: deal, error: dealError } = await supabase
    .from('deals')
    .select('id, account_id, contact_id, service_type, deal_name, amount')
    .eq('id', dealId)
    .single()

  if (dealError || !deal) {
    console.error('Errore lettura deal:', dealError?.message)
    return
  }

  // 2. Se non c'è service_type, non possiamo creare automaticamente
  if (!deal.service_type) {
    console.warn(`Deal ${dealId} senza service_type — service tickets non creati automaticamente`)
    return
  }

  // 3. Determina quali services creare
  const servicesToCreate = SERVICE_MAP[deal.service_type]
  if (!servicesToCreate) {
    console.warn(`Deal service_type "${deal.service_type}" non mappato — nessun ticket creato`)
    return
  }

  // 4. Controlla quali services già esistono per l'account (evita duplicati)
  const { data: existingServices } = await supabase
    .from('services')
    .select('service_type')
    .eq('account_id', deal.account_id)

  const existingTypes = new Set(existingServices?.map(s => s.service_type) || [])

  // 5. Crea solo i services che non esistono già
  const newServices = servicesToCreate
    .filter(s => !existingTypes.has(s.type))
    .map(s => ({
      service_name: `${s.type} — ${deal.deal_name || 'Deal'}`,
      service_type: s.type,
      account_id: deal.account_id,
      contact_id: deal.contact_id,
      deal_id: deal.id,
      status: 'Not Started',
      billing_type: s.billing,
      start_date: new Date().toISOString().split('T')[0],
      stage_entered_at: new Date().toISOString(),
    }))

  if (newServices.length === 0) {
    console.log(`Deal ${dealId}: tutti i services esistono già per account ${deal.account_id}`)
    return
  }

  const { error: insertError } = await supabase
    .from('services')
    .insert(newServices)

  if (insertError) {
    console.error('Errore creazione service tickets:', insertError.message)
    return
  }

  console.log(`Deal ${dealId} → ${newServices.length} service tickets creati per account ${deal.account_id}`)
}
