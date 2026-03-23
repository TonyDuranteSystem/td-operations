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

    // 5. Create Drive folder + copy uploaded files + register in documents table
    if (account_id) {
      try {
        // Get account details
        const { data: acct } = await supabaseAdmin
          .from('accounts')
          .select('drive_folder_id, company_name, state_of_formation')
          .eq('id', account_id)
          .single()

        let driveFolderId = acct?.drive_folder_id || null
        const stateOfFormation = data.state_of_formation || acct?.state_of_formation || ''
        const accountCompanyName = data.company_name || acct?.company_name || companyName

        // Create Drive folder if it doesn't exist
        if (!driveFolderId && accountCompanyName && stateOfFormation) {
          const { createFolder } = await import('@/lib/google-drive')

          const stateFolderMap: Record<string, string> = {
            'New Mexico': '1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4',
            'NM': '1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4',
            'Wyoming': '110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x',
            'WY': '110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x',
            'Delaware': '1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-',
            'DE': '1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-',
            'Florida': '1XToxqPl-t6z10raeal_frSpvBBBRY8nG',
            'FL': '1XToxqPl-t6z10raeal_frSpvBBBRY8nG',
          }
          const companiesRootId = '1Z32I4pDzX4enwqJQzolbFw7fK94ISuCb'
          let parentFolderId = stateFolderMap[stateOfFormation] || null

          if (!parentFolderId) {
            const newStateFolder = await createFolder(companiesRootId, stateOfFormation) as { id: string }
            parentFolderId = newStateFolder.id
          }

          // Folder name: "{Company Name} - {Owner Name}"
          let folderName = accountCompanyName
          if (clientName && clientName !== 'Client') {
            folderName = `${accountCompanyName} - ${clientName}`
          }

          const companyFolder = await createFolder(parentFolderId, folderName) as { id: string }
          driveFolderId = companyFolder.id

          // Create 5 subfolders
          for (const subName of ['1. Company', '2. Contacts', '3. Tax', '4. Banking', '5. Correspondence']) {
            try { await createFolder(driveFolderId, subName) } catch { /* ignore */ }
          }

          // Save drive_folder_id on account
          await supabaseAdmin
            .from('accounts')
            .update({ drive_folder_id: driveFolderId })
            .eq('id', account_id)
        }

        // Copy uploaded files from Supabase Storage to Drive + register in documents table
        if (driveFolderId) {
          const { uploadBinaryToDrive, listFolder } = await import('@/lib/google-drive')

          // Find the right subfolder for each file type
          const folderContents = await listFolder(driveFolderId) as { files?: { id: string; name: string; mimeType: string }[] }
          const subfolders = (folderContents.files || []).filter(f => f.mimeType === 'application/vnd.google-apps.folder')
          const companySubfolder = subfolders.find(f => f.name.includes('Company'))?.id || driveFolderId
          const contactsSubfolder = subfolders.find(f => f.name.includes('Contacts'))?.id || driveFolderId

          // Map field names to subfolders and document types
          const fileFieldMap: Record<string, { subfolder: string; docType: string; category: number }> = {
            passport_owner: { subfolder: contactsSubfolder, docType: 'Passport', category: 2 },
            articles_of_organization: { subfolder: companySubfolder, docType: 'Articles of Organization', category: 1 },
            ein_letter: { subfolder: companySubfolder, docType: 'EIN Letter', category: 1 },
            ss4_form: { subfolder: companySubfolder, docType: 'SS-4 Form', category: 1 },
          }

          for (const [fieldName, storagePath] of Object.entries(data)) {
            if (typeof storagePath !== 'string') continue
            // Match file upload fields by storage path pattern
            const fieldKey = Object.keys(fileFieldMap).find(k => storagePath.includes(`/${k}`))
            if (!fieldKey) continue

            const mapping = fileFieldMap[fieldKey]
            try {
              const cleanPath = storagePath.replace(/^\/+/, '')
              const { data: blob, error: dlErr } = await supabaseAdmin.storage
                .from('onboarding-uploads')
                .download(cleanPath)

              if (dlErr || !blob) continue

              const arrayBuffer = await blob.arrayBuffer()
              const fileData = Buffer.from(arrayBuffer)
              const fileName = cleanPath.split('/').pop() || `${fieldKey}.pdf`
              const mimeType = blob.type || 'application/pdf'

              // Upload to Drive subfolder
              const driveResult = await uploadBinaryToDrive(fileName, fileData, mimeType, mapping.subfolder) as { id: string; name: string }

              // Register in documents table so it shows in portal Documents page
              await supabaseAdmin.from('documents').insert({
                file_name: fileName,
                drive_file_id: driveResult.id,
                document_type_name: mapping.docType,
                category: mapping.category,
                account_id: account_id,
                status: 'classified',
                confidence: 1.0,
                source: 'portal_wizard',
              })

              console.log(`[wizard-submit] Uploaded ${fileName} to Drive (${driveResult.id}) → ${mapping.docType}`)
            } catch (fileErr) {
              console.error(`[wizard-submit] Failed to copy ${fieldKey}:`, fileErr)
            }
          }
        }
      } catch (driveErr) {
        // Non-blocking — don't fail the submit if Drive operations fail
        console.error('[wizard-submit] Drive/doc error (non-blocking):', driveErr)
      }
    }

    // 6. Update CRM account + contact with submitted data
    if (account_id && (wizard_type === 'onboarding' || wizard_type === 'formation')) {
      try {
        // Update account fields from wizard data
        const accountUpdates: Record<string, string> = {}
        if (data.company_name) accountUpdates.company_name = data.company_name
        if (data.ein) accountUpdates.ein = data.ein
        if (data.formation_date) accountUpdates.formation_date = data.formation_date
        if (data.state_of_formation) accountUpdates.state_of_formation = data.state_of_formation
        if (data.business_purpose) accountUpdates.notes = data.business_purpose
        if (data.registered_agent) accountUpdates.registered_agent_provider = data.registered_agent

        if (Object.keys(accountUpdates).length > 0) {
          await supabaseAdmin.from('accounts').update(accountUpdates).eq('id', account_id)
        }

        // Update contact fields
        if (contact_id) {
          const contactUpdates: Record<string, string> = {}
          if (data.owner_first_name) contactUpdates.first_name = data.owner_first_name
          if (data.owner_last_name) contactUpdates.last_name = data.owner_last_name
          if (data.owner_dob) contactUpdates.date_of_birth = data.owner_dob
          if (data.owner_nationality) contactUpdates.citizenship = data.owner_nationality
          if (data.owner_street) contactUpdates.address_line1 = data.owner_street
          if (data.owner_city) contactUpdates.address_city = data.owner_city
          if (data.owner_state_province) contactUpdates.address_state = data.owner_state_province
          if (data.owner_zip) contactUpdates.address_zip = data.owner_zip
          if (data.owner_country) contactUpdates.address_country = data.owner_country
          if (data.owner_itin) contactUpdates.itin = data.owner_itin

          if (Object.keys(contactUpdates).length > 0) {
            await supabaseAdmin.from('contacts').update(contactUpdates).eq('id', contact_id)
          }
        }
      } catch (crmErr) {
        console.error('[wizard-submit] CRM update error (non-blocking):', crmErr)
      }
    }

    // 7. Create task for staff to review
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

    // 7. Send notification email to support
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

    // 9. Advance portal_tier from "onboarding" to "active" now that wizard is complete
    if (account_id) {
      await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: 'active' })
        .eq('id', account_id)
        .eq('portal_tier', 'onboarding') // Only advance if currently onboarding
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[wizard-submit] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Submit failed' },
      { status: 500 }
    )
  }
}
