'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createDealSchema, updateDealSchema, type CreateDealInput, type UpdateDealInput } from '@/lib/schemas/deal'
import type { DryRunResult } from '@/lib/operations/destructive'

// ── Mapping: deal service_type → service delivery tickets to create ──
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

// ── Existing: updateDealStage (with service ticket auto-creation) ──
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
    // eslint-disable-next-line no-console -- operational tracing; legacy pre-P2 pattern
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

  // eslint-disable-next-line no-console -- operational tracing; legacy pre-P2 pattern
  console.log(`Deal ${dealId} → ${newServices.length} service tickets creati per account ${deal.account_id}`)
}

// ── New: createDeal ──
export async function createDeal(input: CreateDealInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createDealSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('deals')
      .insert({ ...parsed.data, created_at: now, updated_at: now })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/pipeline')
    return data
  }, {
    action_type: 'create', table_name: 'deals', account_id: parsed.data?.account_id,
    summary: `Created: ${parsed.data.deal_name}`,
    details: { ...parsed.data },
  })
}

// ── New: updateDeal ──
export async function updateDeal(input: UpdateDealInput): Promise<ActionResult> {
  const parsed = updateDealSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { id, updated_at, ...updates } = parsed.data

  return safeAction(async () => {
    const result = await updateWithLock('deals', id, updates, updated_at)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/pipeline')
  }, {
    action_type: 'update', table_name: 'deals', record_id: id,
    summary: `Updated: ${Object.keys(updates).join(', ')}`,
    details: updates,
  })
}

// ── New: addDealNote ──
export async function addDealNote(
  dealId: string,
  note: string,
  updatedAt: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()

    // Read current notes
    const { data: current, error: readError } = await supabase
      .from('deals')
      .select('notes')
      .eq('id', dealId)
      .single()
    if (readError) throw new Error(readError.message)

    const datePrefix = new Date().toISOString().split('T')[0]
    const newNote = `[${datePrefix}] ${note.trim()}`
    const updatedNotes = current?.notes
      ? `${newNote}\n${current.notes}`
      : newNote

    const result = await updateWithLock('deals', dealId, { notes: updatedNotes }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/pipeline')
  }, {
    action_type: 'update', table_name: 'deals', record_id: dealId,
    summary: `Note added`, details: { note },
  })
}

// ── P3.9 — delete deal ──
export async function deleteDealPreview(
  dealId: string,
): Promise<{ success: boolean; preview?: DryRunResult; error?: string }> {
  try {
    const supabase = createClient()
    const { data: deal } = await supabase
      .from('deals')
      .select('id, deal_name, stage, amount, amount_currency, service_type, payment_status, account_id')
      .eq('id', dealId)
      .maybeSingle()
    if (!deal) return { success: false, error: 'Deal not found' }

    const { count: sdCount } = await supabase
      .from('service_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('deal_id', dealId)

    const stage = deal.stage ?? ''
    const isLocked = stage === 'Closed Won' || stage === 'Paid'

    const items: DryRunResult['items'] = [
      {
        label: deal.deal_name ?? 'Untitled deal',
        details: [
          deal.stage ?? 'no stage',
          deal.amount != null ? `${deal.amount} ${deal.amount_currency ?? ''}`.trim() : '',
          deal.service_type ?? '',
          deal.payment_status ? `payment ${deal.payment_status}` : '',
        ].filter(Boolean) as string[],
      },
    ]
    if ((sdCount ?? 0) > 0) {
      items.push({
        label: `${sdCount} linked service deliver${sdCount === 1 ? 'y' : 'ies'} will keep running`,
        details: ['deal_id reference will be null'],
      })
    }

    return {
      success: true,
      preview: {
        affected: { deal: 1, linked_service_deliveries: sdCount ?? 0 },
        items,
        warnings: [
          'The deal record is removed from the pipeline.',
          'Linked service deliveries are NOT deleted — they keep running with a null deal_id.',
        ],
        blocker: isLocked
          ? 'This deal is Closed Won / Paid. Deleting it corrupts revenue history — leave it for audit trail.'
          : undefined,
        record_label: deal.deal_name ?? dealId,
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Preview failed' }
  }
}

export async function deleteDeal(dealId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const { data: deal } = await supabase
      .from('deals')
      .select('id, stage')
      .eq('id', dealId)
      .maybeSingle()
    if (!deal) throw new Error('Deal not found')
    if (deal.stage === 'Closed Won' || deal.stage === 'Paid') {
      throw new Error('Closed Won / Paid deals cannot be deleted.')
    }

    // Null out deal_id on linked service deliveries so they keep running.
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    await supabase
      .from('service_deliveries')
      .update({ deal_id: null, updated_at: new Date().toISOString() })
      .eq('deal_id', dealId)

    const { error } = await supabase.from('deals').delete().eq('id', dealId)
    if (error) throw new Error(error.message)
    revalidatePath('/pipeline')
  }, {
    action_type: 'delete',
    table_name: 'deals',
    record_id: dealId,
    summary: 'Deal deleted',
  })
}
