'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function completeService(serviceId: string) {
  const supabase = createClient()

  const { error } = await supabase
    .from('services')
    .update({
      status: 'Completed',
      end_date: new Date().toISOString().split('T')[0],
      updated_at: new Date().toISOString(),
    })
    .eq('id', serviceId)

  if (error) throw new Error(`Errore aggiornamento: ${error.message}`)

  revalidatePath('/services')
  revalidatePath('/accounts')
  return { success: true }
}

export async function updateServiceStatus(serviceId: string, newStatus: string) {
  const supabase = createClient()

  const updates: Record<string, unknown> = {
    status: newStatus,
    stage_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  if (newStatus !== 'Blocked') {
    updates.blocked_waiting_external = false
    updates.blocked_reason = null
    updates.blocked_since = null
  }

  const { error } = await supabase
    .from('services')
    .update(updates)
    .eq('id', serviceId)

  if (error) throw new Error(`Errore aggiornamento: ${error.message}`)

  revalidatePath('/services')
  return { success: true }
}
