/**
 * POST /api/portal/wizard-submit — Submit completed wizard data.
 *
 * Marks wizard_progress as 'submitted', creates a notification for staff,
 * and stores the data for review. The actual CRM updates happen during
 * review (formation_form_review / onboarding_form_review) — same as external forms.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'
import { APP_BASE_URL } from '@/lib/config'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { wizard_type, entity_type, data, account_id, contact_id, progress_id } = body

  if (!wizard_type || !data) {
    return NextResponse.json({ error: 'wizard_type and data are required' }, { status: 400 })
  }

  try {
    // 0. Deduplication — check if already submitted
    if (progress_id) {
      const { data: existing } = await supabaseAdmin
        .from('wizard_progress')
        .select('status')
        .eq('id', progress_id)
        .single()
      if (existing?.status === 'submitted') {
        return NextResponse.json({ success: true, message: 'Already submitted' })
      }
    }

    // 1. Mark wizard_progress as submitted
    if (progress_id) {
      await supabaseAdmin
        .from('wizard_progress')
        .update({
          data,
          status: 'submitted',
          updated_at: new Date().toISOString(),
        })
        .eq('id', progress_id)
    } else {
      // Create + submit in one step
      await supabaseAdmin
        .from('wizard_progress')
        .insert({
          wizard_type,
          data,
          account_id: account_id || null,
          contact_id: contact_id || null,
          status: 'submitted',
          current_step: 99, // completed
        })
    }

    // 2. Get client name for notification
    let clientName = user.user_metadata?.full_name || user.email || 'Client'
    if (data.owner_first_name && data.owner_last_name) {
      clientName = `${data.owner_first_name} ${data.owner_last_name}`
    }

    // 3. Get company name if available
    let companyName = data.company_name || data.llc_name_1 || ''
    if (!companyName && account_id) {
      const { data: acct } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', account_id)
        .single()
      companyName = acct?.company_name || ''
    }

    // 4. Save to form submissions table (same format as external forms)
    // This allows the existing MCP tools (formation_form_review, onboarding_form_review) to process it
    const submissionTable = wizard_type === 'formation' ? 'formation_submissions'
      : wizard_type === 'onboarding' ? 'onboarding_submissions'
      : null

    let submissionToken: string | null = null
    if (submissionTable) {
      // Generate a token for the submission
      const nameSlug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-')
      submissionToken = `portal-${nameSlug}-${new Date().getFullYear()}`

      // Collect upload paths from data (fields that contain storage paths)
      const uploadPaths: string[] = []
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'string' && (val.includes('/passport_') || val.includes('/articles_') || val.includes('/ein_') || val.includes('/ss4_'))) {
          uploadPaths.push(val)
        }
      }

      await supabaseAdmin.from(submissionTable).upsert({
        token: submissionToken,
        lead_id: null, // Portal submissions don't have a lead
        contact_id: contact_id || null,
        account_id: account_id || null,
        entity_type: entity_type || 'SMLLC',
        language: 'en',
        prefilled_data: {}, // No prefill tracking for portal wizard
        submitted_data: data,
        changed_fields: {},
        upload_paths: uploadPaths,
        status: 'completed', // Ready for review
      }, { onConflict: 'token' })
    }

    // 5. Create task for staff to review
    const taskTitle = wizard_type === 'formation'
      ? `Portal Wizard: Formation data submitted — ${clientName}${companyName ? ` (${companyName})` : ''}`
      : `Portal Wizard: Onboarding data submitted — ${clientName}${companyName ? ` (${companyName})` : ''}`

    await supabaseAdmin.from('tasks').insert({
      task_title: taskTitle,
      description: [
        `${entity_type || 'SMLLC'} ${wizard_type} wizard completed via portal.`,
        submissionToken ? `Review with: ${wizard_type}_form_review(token="${submissionToken}")` : '',
        `Then apply changes to create CRM records.`,
      ].filter(Boolean).join('\n'),
      status: 'To Do',
      priority: 'High',
      category: wizard_type === 'formation' ? 'Formation' : 'Client Response',
      assigned_to: 'Luca',
      account_id: account_id || null,
    })

    // 5. Send notification email to support
    // (non-blocking, don't wait)
    fetch(`${APP_BASE_URL}/api/internal/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'wizard_submitted',
        wizard_type,
        client_name: clientName,
        company_name: companyName,
        account_id,
      }),
    }).catch(() => {}) // silent

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[wizard-submit] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Submit failed' },
      { status: 500 }
    )
  }
}
