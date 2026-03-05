'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function updateDealStage(dealId: string, newStage: string) {
  const supabase = createClient()

  const updates: Record<string, unknown> = {
    stage: newStage,
    updated_at: new Date().toISOString(),
  }

  if (newStage === 'Closed Won') {
    updates.close_date = new Date().toISOString().split('T')[0]
  }

  const { error } = await supabase
    .from('deals')
    .update(updates)
    .eq('id', dealId)

  if (error) throw new Error(`Errore aggiornamento: ${error.message}`)

  revalidatePath('/pipeline')
  return { success: true }
}
