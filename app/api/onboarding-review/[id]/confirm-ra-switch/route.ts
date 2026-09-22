/**
 * Mark the Registered Agent as switched to Harbor Compliance for a Client
 * Onboarding flow — staff-confirmed, not an API push (Antonio, 2026-09-22:
 * "that fucking button must open the website for us to do switch. once is
 * done, we will confirm in the workspace and the system will update the
 * crm"). Staff do the actual switch by hand on Harbor Compliance's own
 * site; this just advances the SD to its final stage once they say it's
 * done, which is also what retires this step's card everywhere it shows.
 *
 * Requires the RA receipt (Antonio, follow-up same day: "once we open HC
 * and do the switch, we have to upload the RA receipt and confirm the
 * switch") — the receipt is stored in Supabase Storage FIRST (the same
 * durable bucket the client's own wizard uploads already use, confirmed
 * working) BEFORE the stage advances, same "proof lives with the record"
 * principle as the RA-renewal file-and-upload flow
 * (components/calendar/mark-filed-dialog.tsx), just for the one-time
 * initial switch rather than the annual renewal.
 *
 * Copying that same receipt into the account's Google Drive folder is
 * BEST-EFFORT, not required (dev job 7535a166, 2026-09-22: Drive folder
 * creation is currently failing for every new onboarding account in
 * sandbox, a pre-existing bug in the shared Drive-folder helper, not
 * something this route introduced or can fix by itself — confirmed via
 * the job logs of multiple real accounts, including Antonio's own SAD LLC
 * test). The switch must never get stuck on Drive being broken: the
 * receipt is never lost (it's always in Storage), and the response says
 * plainly whether it also made it to Drive so staff know if a manual
 * Drive filing is still needed.
 *
 * Also stamps accounts.ra_switch_date and accounts.client_since (Antonio,
 * same follow-up: "I want the Client since and RA switch date so the crm
 * can be updated according to the rules") — the onboarding job's own
 * renewal_dates step already runs at account-creation time, before either
 * date exists, so ra_renewal_date is never derived there for a real
 * onboarding. This is the actual moment both dates are known, so this is
 * where they get set — null-only writes (never overwrite a real value —
 * matches lib/operations/renewal-dates.ts's own guard), then the SAME
 * shared engine derives ra_renewal_date from them, same as formation/
 * onboarding account creation does.
 *
 * POST (multipart/form-data, field `receipt`) → { success, message } | { success:false, error }
 * [id] = onboarding_submissions.id.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { advanceStageIfAt } from '@/lib/operations/service-delivery'
import { ensureCompanyFolder } from '@/lib/drive-folder-utils'
import { uploadBinaryToDrive } from '@/lib/google-drive'
import { deriveRenewalDates, applyRenewalDateFills } from '@/lib/operations/renewal-dates'

const MAX_RECEIPT_BYTES = 15 * 1024 * 1024

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const form = await req.formData()
    const receipt = form.get('receipt')
    if (!(receipt instanceof File) || receipt.size === 0) {
      return NextResponse.json({ success: false, error: 'The Registered Agent receipt is required before confirming the switch.' }, { status: 400 })
    }
    if (receipt.size > MAX_RECEIPT_BYTES) {
      return NextResponse.json({ success: false, error: `Receipt is too large (max ${MAX_RECEIPT_BYTES / 1024 / 1024}MB).` }, { status: 400 })
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('onboarding_submissions')
      .select('id, account_id, reviewed_at')
      .eq('id', params.id)
      .maybeSingle()

    if (subErr || !sub) {
      return NextResponse.json({ success: false, error: 'Submission not found' }, { status: 404 })
    }
    if (!sub.reviewed_at || !sub.account_id) {
      return NextResponse.json(
        { success: false, error: 'This onboarding has not been reviewed and confirmed yet — nothing to switch the RA on.' },
        { status: 400 },
      )
    }

    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, stage')
      .eq('account_id', sub.account_id)
      .eq('service_type', 'Client Onboarding')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (sdErr || !sd) {
      return NextResponse.json({ success: false, error: 'No active Client Onboarding record found for this account' }, { status: 404 })
    }

    const { data: finalStage } = await supabaseAdmin
      .from('pipeline_stages')
      .select('stage_name')
      .eq('service_type', 'Client Onboarding')
      .order('stage_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!finalStage) {
      return NextResponse.json({ success: false, error: 'Client Onboarding has no pipeline stages configured' }, { status: 500 })
    }
    if (sd.stage === finalStage.stage_name) {
      return NextResponse.json({ success: true, message: 'Already confirmed — Registered Agent switch was already recorded.' })
    }

    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id, company_name, state_of_formation, formation_date, ra_switch_date, client_since, ra_renewal_date, annual_report_due_date, cmra_renewal_date')
      .eq('id', sub.account_id)
      .maybeSingle()

    const buffer = Buffer.from(await receipt.arrayBuffer())
    const fileName = `RA_Switch_Receipt_${new Date().toISOString().slice(0, 10)}_${receipt.name}`
    const mimeType = receipt.type || 'application/pdf'

    // 1. Durable copy FIRST — the same Supabase Storage bucket the client's
    // own wizard uploads already use (confirmed working live, 2026-09-22).
    // This is the record's real proof from this point on; Drive below is a
    // bonus copy, never the only copy.
    const storagePath = `onboarding-ra-receipts/${sub.account_id}/${Date.now()}_${receipt.name}`
    const { error: storageErr } = await supabaseAdmin.storage
      .from('onboarding-uploads')
      .upload(storagePath, buffer, { contentType: mimeType })
    if (storageErr) {
      return NextResponse.json(
        { success: false, error: `Could not save the receipt: ${storageErr.message}` },
        { status: 500 },
      )
    }

    // 2. Drive copy — BEST-EFFORT ONLY (see file header, dev job 7535a166).
    // Never blocks the switch; a failure here is recorded in the response
    // text, not thrown.
    let driveNote = 'not filed to Drive automatically — the account has no Drive folder right now.'
    try {
      let driveFolderId = account?.drive_folder_id ?? null
      if (!driveFolderId && account?.company_name && account?.state_of_formation) {
        const folder = await ensureCompanyFolder(sub.account_id, account.company_name, account.state_of_formation)
        driveFolderId = folder.folderId
      }
      if (driveFolderId) {
        await uploadBinaryToDrive(fileName, buffer, mimeType, driveFolderId)
        driveNote = 'also filed to the account\'s Drive folder.'
      }
    } catch (e) {
      console.error('[confirm-ra-switch] Drive copy failed (non-fatal, receipt is safe in Storage):', e)
      driveNote = 'could not be filed to Drive automatically — Drive is currently having a problem for new accounts (tracked separately). The receipt itself is safely saved either way.'
    }

    const result = await advanceStageIfAt({
      delivery_id: sd.id,
      if_current_stage: sd.stage || '',
      target_stage: finalStage.stage_name,
      actor: 'staff (onboarding workspace)',
      notes: 'Registered Agent switched to Harbor Compliance — staff-confirmed.',
    })

    if (!result.advanced) {
      return NextResponse.json({ success: false, error: result.reason || 'Could not advance the stage' }, { status: 409 })
    }

    // Stamp today as the RA-switch date / client-since date (null-only — never
    // overwrites a real value already on the account), then derive
    // ra_renewal_date from them via the same shared engine formation uses.
    // Non-fatal: the switch itself already succeeded above; a failure here
    // is logged, not returned as an error, so staff never see "failed" for
    // something that actually worked.
    let dateNote = ''
    try {
      const today = new Date().toISOString().slice(0, 10)
      const stampFields: Record<string, string> = {}
      if (!account?.ra_switch_date) stampFields.ra_switch_date = today
      if (!account?.client_since) stampFields.client_since = today
      if (Object.keys(stampFields).length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- null-only initial-date fill, same exempted pattern as lib/operations/renewal-dates.ts's own writer (plan c2d97552)
        await supabaseAdmin.from('accounts').update(stampFields).eq('id', sub.account_id)
      }

      const fills = deriveRenewalDates({
        intake: 'onboarding',
        formation_date: account?.formation_date ?? null,
        ra_switch_date: stampFields.ra_switch_date ?? account?.ra_switch_date ?? null,
        client_since: stampFields.client_since ?? account?.client_since ?? null,
        state_of_formation: account?.state_of_formation ?? null,
        existing: {
          ra_renewal_date: account?.ra_renewal_date ?? null,
          annual_report_due_date: account?.annual_report_due_date ?? null,
          cmra_renewal_date: account?.cmra_renewal_date ?? null,
        },
      })
      const applied = await applyRenewalDateFills(sub.account_id, fills, {
        state: account?.state_of_formation,
        actor: 'onboarding-ra-switch-confirm',
      })
      const stamped = Object.keys(stampFields)
      if (stamped.length || applied.length) {
        dateNote = ` ${[...stamped, ...applied].join(', ')} recorded.`
      }
    } catch (e) {
      console.error('[confirm-ra-switch] renewal-date stamp failed (non-fatal):', e)
    }

    return NextResponse.json({ success: true, message: `Registered Agent switch confirmed and the receipt is saved — ${driveNote} Moved to ${finalStage.stage_name}.${dateNote}` })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
