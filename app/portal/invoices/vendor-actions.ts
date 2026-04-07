'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

export interface Vendor {
  id: string
  account_id: string
  name: string
  contact_person: string | null
  email: string | null
  phone: string | null
  vat_number: string | null
  address: string | null
  notes: string | null
  created_at: string
}

/**
 * List all vendors for an account.
 */
export async function listVendors(accountId: string): Promise<Vendor[]> {
  const { data } = await supabaseAdmin
    .from('client_vendors')
    .select('*')
    .eq('account_id', accountId)
    .order('name')

  return (data ?? []) as Vendor[]
}

/**
 * Create a new vendor.
 */
export async function createVendor(input: {
  account_id: string
  name: string
  contact_person?: string
  email?: string
  phone?: string
  vat_number?: string
  address?: string
  notes?: string
}): Promise<ActionResult<{ id: string }>> {
  return safeAction(async () => {
    const { data, error } = await supabaseAdmin
      .from('client_vendors')
      .insert({
        account_id: input.account_id,
        name: input.name,
        contact_person: input.contact_person || null,
        email: input.email || null,
        phone: input.phone || null,
        vat_number: input.vat_number || null,
        address: input.address || null,
        notes: input.notes || null,
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
    return data
  }, {
    action_type: 'create', table_name: 'client_vendors', account_id: input.account_id,
    summary: `Vendor created: ${input.name}`,
  })
}

/**
 * Update an existing vendor.
 */
export async function updateVendor(
  vendorId: string,
  updates: {
    name?: string
    contact_person?: string
    email?: string
    phone?: string
    vat_number?: string
    address?: string
    notes?: string
  }
): Promise<ActionResult> {
  return safeAction(async () => {
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (updates.name !== undefined) updateData.name = updates.name
    if (updates.contact_person !== undefined) updateData.contact_person = updates.contact_person || null
    if (updates.email !== undefined) updateData.email = updates.email || null
    if (updates.phone !== undefined) updateData.phone = updates.phone || null
    if (updates.vat_number !== undefined) updateData.vat_number = updates.vat_number || null
    if (updates.address !== undefined) updateData.address = updates.address || null
    if (updates.notes !== undefined) updateData.notes = updates.notes || null

    const { error } = await supabaseAdmin
      .from('client_vendors')
      .update(updateData)
      .eq('id', vendorId)
    if (error) throw new Error(error.message)

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_vendors', record_id: vendorId,
    summary: `Vendor updated: ${updates.name ?? vendorId}`,
  })
}

/**
 * Delete a vendor (only if no expenses reference it).
 */
export async function deleteVendor(vendorId: string): Promise<ActionResult> {
  return safeAction(async () => {
    // Check for linked expenses
    const { count } = await supabaseAdmin
      .from('client_expenses')
      .select('id', { count: 'exact', head: true })
      .eq('vendor_id', vendorId)

    if (count && count > 0) {
      throw new Error(`Cannot delete: ${count} expense(s) linked to this vendor`)
    }

    const { error } = await supabaseAdmin
      .from('client_vendors')
      .delete()
      .eq('id', vendorId)
    if (error) throw new Error(error.message)

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'delete', table_name: 'client_vendors', record_id: vendorId,
    summary: 'Vendor deleted',
  })
}
