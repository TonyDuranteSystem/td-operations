'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { TAX_BOARD_ASSIGNEES, type TaxBoardAssignee } from '@/lib/tax/tax-board'

/**
 * Set (or clear) the assignee on a Tax Return service delivery from the board.
 * Low-risk single-field write; no client notification. `assignee === null`
 * clears it ("Unassigned").
 */
export async function assignTaxBoardCard(
  sdId: string,
  assignee: string | null,
): Promise<ActionResult> {
  if (assignee !== null && !TAX_BOARD_ASSIGNEES.includes(assignee as TaxBoardAssignee)) {
    return { success: false, error: `Invalid assignee: ${assignee}` }
  }
  return safeAction(
    async () => {
      const supabase = createClient()
      // eslint-disable-next-line no-restricted-syntax -- board assignee write, scoped single-field, dev_task 7fb26de4
      const { error } = await supabase
        .from('service_deliveries')
        .update({ assigned_to: assignee })
        .eq('id', sdId)
        .eq('service_type', 'Tax Return')
      if (error) throw new Error(error.message)
      revalidatePath('/tax-returns')
    },
    {
      action_type: 'update',
      table_name: 'service_deliveries',
      record_id: sdId,
      summary: `Tax Board assignee → ${assignee ?? 'Unassigned'}`,
      details: { assigned_to: assignee },
    },
  )
}
