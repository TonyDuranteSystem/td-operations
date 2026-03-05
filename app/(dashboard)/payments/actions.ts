'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function markPaymentPaid(paymentId: string) {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase
    .from('payments')
    .update({
      status: 'Paid',
      paid_date: today,
      updated_at: new Date().toISOString(),
    })
    .eq('id', paymentId)

  if (error) throw new Error(`Errore aggiornamento: ${error.message}`)

  revalidatePath('/payments')
  revalidatePath('/accounts')
  return { success: true }
}
