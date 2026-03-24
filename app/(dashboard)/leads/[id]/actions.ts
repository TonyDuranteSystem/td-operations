'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { PORTAL_BASE_URL } from '@/lib/config'
import { revalidatePath } from 'next/cache'

interface ActivateResult {
  success: boolean
  message: string
  credentials?: {
    email: string
    tempPassword: string
    loginUrl: string
  }
}

/**
 * Full "Register Payment" flow:
 * 1. Call activate-service → creates Contact from Lead + SDs from bundled_pipelines
 * 2. Find the newly created contact
 * 3. Create portal user (Supabase Auth) with contact_id
 * 4. Return login credentials
 */
export async function registerPayment(leadId: string): Promise<ActivateResult> {
  try {
    // ── 1. Find pending_activation ──────────────────────────
    const { data: activation, error: actErr } = await supabaseAdmin
      .from('pending_activations')
      .select('id, status')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (actErr) {
      return { success: false, message: `Error looking up activation: ${actErr.message}` }
    }
    if (!activation) {
      return { success: false, message: 'No pending activation found. The offer must be signed first.' }
    }
    if (activation.status === 'activated') {
      return { success: false, message: 'This lead has already been activated.' }
    }

    // ── 2. Call activate-service endpoint ────────────────────
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000')

    const res = await fetch(`${baseUrl}/api/workflows/activate-service`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.API_SECRET_TOKEN}`,
      },
      body: JSON.stringify({ pending_activation_id: activation.id }),
    })

    const result = await res.json()

    if (!res.ok) {
      return { success: false, message: result.error || 'Activation failed' }
    }

    // ── 3. Find the contact created by activate-service ─────
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('email, full_name')
      .eq('id', leadId)
      .single()

    if (!lead?.email) {
      return {
        success: true,
        message: `Activation ${result.mode}. ${result.steps?.length || 0} steps processed. Portal user NOT created — lead has no email.`,
      }
    }

    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('id')
      .ilike('email', lead.email)
      .limit(1)
      .maybeSingle()

    // ── 4. Create portal user (Supabase Auth) ───────────────
    // Check if auth user already exists
    const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    const existingUser = (existingList?.users ?? []).find(u => u.email === lead.email)

    if (existingUser) {
      revalidatePath(`/leads/${leadId}`)
      revalidatePath('/leads')
      return {
        success: true,
        message: `Activation completed (${result.mode}). Portal user already exists for ${lead.email}.`,
      }
    }

    const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

    const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: lead.email,
      password: tempPassword,
      email_confirm: true,
      app_metadata: {
        role: 'client',
        ...(contact?.id ? { contact_id: contact.id } : {}),
      },
      user_metadata: {
        full_name: lead.full_name,
        must_change_password: true,
      },
    })

    if (createErr) {
      revalidatePath(`/leads/${leadId}`)
      return {
        success: true,
        message: `Activation completed but portal user creation failed: ${createErr.message}`,
      }
    }

    // Log the action
    await supabaseAdmin.from('action_log').insert({
      action_type: 'create',
      entity_type: 'auth.users',
      entity_id: leadId,
      summary: `Portal user created via Register Payment: ${lead.full_name} (${lead.email})`,
    })

    revalidatePath(`/leads/${leadId}`)
    revalidatePath('/leads')

    const loginUrl = `${PORTAL_BASE_URL}/portal/login`

    return {
      success: true,
      message: `Activation completed (${result.mode}). Portal user created.`,
      credentials: {
        email: lead.email,
        tempPassword,
        loginUrl,
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { success: false, message: msg }
  }
}
