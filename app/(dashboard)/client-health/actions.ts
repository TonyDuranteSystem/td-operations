'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'

// ─── Retry Stuck Activation ────────────────────────────────

export async function retryActivation(
  offerToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Verify the activation exists and is stuck
    const { data: pa } = await supabaseAdmin
      .from('pending_activations')
      .select('id, status, activated_at, offer_token')
      .eq('offer_token', offerToken)
      .single()

    if (!pa) {
      return { success: false, error: 'Activation not found' }
    }

    if (pa.activated_at) {
      return { success: false, error: 'Already activated' }
    }

    if (pa.status !== 'payment_confirmed') {
      return { success: false, error: `Status is "${pa.status}" — must be payment_confirmed` }
    }

    // Call the activate-service endpoint
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/workflows/activate-service`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ offer_token: offerToken }),
      }
    )

    const data = await res.json()

    if (!res.ok) {
      return { success: false, error: data.error || `Activation failed (${res.status})` }
    }

    revalidatePath('/client-health')
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Repair SD Contact Link ────────────────────────────────

export async function repairSdContactId(
  accountId: string
): Promise<{ success: boolean; fixed?: number; error?: string }> {
  try {
    // Get the primary contact for this account
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', accountId)
      .limit(1)

    if (!links || links.length === 0) {
      return { success: false, error: 'No contact linked to this account' }
    }

    const primaryContactId = links[0].contact_id

    // Find SDs with missing or wrong contact_id
    const { data: brokenSDs } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, contact_id')
      .eq('account_id', accountId)
      .or(`contact_id.is.null,contact_id.neq.${primaryContactId}`)

    if (!brokenSDs || brokenSDs.length === 0) {
      return { success: true, fixed: 0 }
    }

    // Fix them
    const { error } = await supabaseAdmin
      .from('service_deliveries')
      .update({ contact_id: primaryContactId, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .or(`contact_id.is.null,contact_id.neq.${primaryContactId}`)

    if (error) {
      return { success: false, error: error.message }
    }

    revalidatePath('/client-health')
    return { success: true, fixed: brokenSDs.length }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Sync Portal Tier (3-way) ──────────────────────────────

export async function syncPortalTier(
  contactId: string
): Promise<{ success: boolean; error?: string; synced?: string }> {
  try {
    // Get contact's portal_tier (source of truth)
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('id, portal_tier, email')
      .eq('id', contactId)
      .single()

    if (!contact) {
      return { success: false, error: 'Contact not found' }
    }

    const tier = contact.portal_tier || 'lead'

    // Sync to accounts
    const { data: accountLinks } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contactId)

    if (accountLinks) {
      for (const link of accountLinks) {
        await supabaseAdmin
          .from('accounts')
          .update({ portal_tier: tier })
          .eq('id', link.account_id)
      }
    }

    // Sync to auth.users metadata
    if (contact.email) {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const authUser = users?.find(u => u.email?.toLowerCase() === contact.email?.toLowerCase())

      if (authUser) {
        const currentTier = authUser.app_metadata?.portal_tier
        if (currentTier !== tier) {
          await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
            app_metadata: { ...authUser.app_metadata, portal_tier: tier },
          })
        }
      }
    }

    revalidatePath('/client-health')
    return { success: true, synced: tier }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
