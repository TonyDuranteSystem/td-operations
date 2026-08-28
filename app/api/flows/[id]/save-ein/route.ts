/**
 * EIN entry for a Company Formation flow's "EIN Received" stage.
 *
 *   GET  → { ein_number } — the SD's account's current EIN (or null). Backs the
 *          ein_entry component's read (so it shows read-only when already set).
 *   POST → validate + save accounts.ein_number (via updateAccount — the canonical
 *          write path), then notify the client (portal notification + a flow chat
 *          message) that the EIN is issued and formation is complete.
 *
 * Reuses the same account write + notification primitives as the
 * formation.confirm_ein_received workflow handler — no duplicated logic. This
 * route does NOT advance the SD stage (the SD is already AT "EIN Received") and
 * does NOT spawn the RA/Annual-Report SDs (that's the "Mark Formation Complete"
 * action). It only records the EIN + tells the client.
 *
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isItalian } from '@/lib/locale'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { updateAccount } from '@/lib/operations/account'
import { createPortalNotification, notifyClientOfAdminMessage } from '@/lib/portal/notifications'
import { deriveFlowYear, buildFlowTopic } from '@/lib/flows/resolve-flows'
import type { HandlerContext } from '@/lib/tasks/types'

/** Normalize an EIN to XX-XXXXXXX, or null when it isn't 9 digits. */
function normalizeEin(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== 9) return null
  return `${digits.slice(0, 2)}-${digits.slice(2)}`
}

async function resolveSd(serviceDeliveryId: string) {
  const { data } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, account_id, due_date, stage_entered_at, created_at')
    .eq('id', serviceDeliveryId)
    .maybeSingle()
  return data ?? null
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sd = await resolveSd(params.id)
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (!sd.account_id) return NextResponse.json({ success: true, ein_number: null })

    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('ein_number')
      .eq('id', sd.account_id)
      .maybeSingle()

    return NextResponse.json({ success: true, ein_number: account?.ein_number ?? null })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sd = await resolveSd(params.id)
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (sd.service_type !== 'Company Formation') {
      return NextResponse.json({ success: false, error: 'EIN entry only applies to Company Formation flows.' }, { status: 400 })
    }
    if (!sd.account_id) {
      return NextResponse.json({ success: false, error: 'No CRM account linked to this flow yet.' }, { status: 400 })
    }

    const body = await req.json().catch(() => ({}))
    const ein = normalizeEin(typeof body.ein === 'string' ? body.ein : '')
    if (!ein) {
      return NextResponse.json({ success: false, error: 'Invalid EIN format. Expected XX-XXXXXXX (9 digits).' }, { status: 400 })
    }

    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('id, company_name, ein_number')
      .eq('id', sd.account_id)
      .single()
    if (!account) return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 })

    // Idempotent: if the EIN is already recorded, don't overwrite or re-notify.
    if (account.ein_number) {
      return NextResponse.json({ success: true, ein_number: account.ein_number, already_set: true })
    }

    // ── Save via the canonical account write path ──
    const update = await updateAccount({
      id: sd.account_id,
      patch: { ein_number: ein } as Parameters<typeof updateAccount>[0]['patch'],
      actor: 'flow-save-ein',
      summary: `EIN received ${ein} (${account.company_name})`,
      details: { field: 'ein_number', previous_value: null, new_value: ein },
    })
    if (!update.success) {
      return NextResponse.json({ success: false, error: update.error || 'Could not save the EIN.' }, { status: 500 })
    }

    // ── Re-enqueue the welcome-package setup (dev job c3efa6cb) ──
    // This is the ONLY screen staff have actually used to record an EIN for
    // the last 90 days (confirmed via action_log), but it never triggered
    // this job — lib/operations/ein-received.ts's legacy path does, this one
    // didn't. Without it, an account's banking-application record (and OA/
    // Lease) never gets seeded, and the banking-wizard staff notification
    // has nothing to key off of (silently skips — the BRIXEL LLC incident).
    // Best-effort: a failure here must never block the EIN save itself.
    try {
      const { enqueueJob } = await import('@/lib/jobs/queue')
      await enqueueJob({
        job_type: 'welcome_package_prepare',
        payload: { account_id: sd.account_id },
        priority: 5,
        account_id: sd.account_id,
        created_by: 'flow-save-ein',
      })
    } catch (e) {
      console.error('[save-ein] welcome_package_prepare enqueue failed:', e instanceof Error ? e.message : String(e))
    }

    // ── Resolve the client contact (+ language) for the notification/chat ──
    let contactId: string | null = null
    let language: 'en' | 'it' = 'en'
    const { data: link } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', sd.account_id)
      .limit(1)
      .maybeSingle()
    contactId = link?.contact_id ?? null
    if (contactId) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('language')
        .eq('id', contactId)
        .maybeSingle()
      // contacts.language is free text ("Italian", not "it") — normalize.
      if (isItalian(contact?.language)) language = 'it'
    }

    const company = account.company_name || 'your company'
    const message =
      language === 'it'
        ? `Ottime notizie — l'IRS ha emesso il tuo EIN: ${ein}. ${company} è ora completamente costituita e attiva! 🎉

Alcuni passaggi importanti:

1) Conserva al sicuro i documenti della tua azienda. Il tuo Atto Costitutivo (Articles of Organization) e la lettera EIN (CP 575) sono nel portale, nella sezione Documenti. Scaricali e conservali in un luogo sicuro — ti serviranno per aprire il conto bancario, firmare contratti e presentare le tasse.

2) Non condividere mai il modulo SS-4 firmato con nessuno. È un documento fiscale interno e NON serve per aprire il conto bancario né per gestire la tua attività. Per aprire un conto bancario aziendale ti bastano l'EIN e l'Atto Costitutivo.

3) Apri il tuo conto bancario aziendale. Vai su "Apertura Conto Bancario" nella barra laterale del portale e inizia la richiesta da lì: troverai le banche che consigliamo, con le indicazioni per candidarti. Puoi candidarti anche a più di una banca.

4) Descrivi chiaramente la tua attività quando fai domanda. Le banche chiedono cosa fa la tua azienda — fornisci una descrizione precisa e accurata: cosa vendi, a chi e come vieni pagato. Risposte vaghe come "consulenza" o "business online" rallentano l'approvazione o causano rifiuti.

5) Durante ogni fase di questo processo, consultaci in chat se hai bisogno di aiuto. Se non sei sicuro di qualcosa, non procedere — contattaci prima. Questo è un passaggio importante, quindi abbi pazienza se non rispondiamo subito. Facci sapere quando intendi fare domanda così possiamo trovare un momento che vada bene per entrambi.

Non sai quale banca fa per te? Scrivici quando vuoi qui nel portale.`
        : `Great news — the IRS has issued your EIN: ${ein}. ${company} is now fully formed and active! 🎉

A few important next steps:

1) Keep your company documents safe. Your Articles of Organization and EIN letter (CP 575) are in your portal under Documents. Download and store them somewhere secure — you'll use them to open a bank account, sign contracts, and file taxes.

2) Never share your signed SS-4 form with anyone. It's an internal tax document and is NOT needed to open a bank account or run your business. To open a business bank account you only need your EIN and your Articles of Organization.

3) Open your business bank account. Go to Bank Applications in your portal sidebar and start your application from there — you'll find the banks we recommend, with instructions for applying. You can apply to more than one.

4) Describe your business clearly when you apply. Banks ask what your company does — give a specific, accurate description: what you sell, to whom, and how you get paid. Vague answers like 'consulting' or 'online business' slow approval or cause rejections.

5) During any step of this process, consult us in the chat if you need help. If you're not sure about something, don't continue — contact us first. This is an important step, so be patient if we don't reply right away. Let us know when you're going to apply so we can find a time that works for both of us.

Not sure which bank fits you best? Message us anytime here in the portal.`
    const title = language === 'it' ? 'EIN emesso — la tua azienda è costituita!' : 'EIN issued — your company is fully formed!'

    // ── Portal notification (push + digest email) ──
    createPortalNotification({
      account_id: sd.account_id,
      contact_id: contactId || undefined,
      type: 'formation',
      title,
      body: message,
      link: '/portal',
    }).catch(() => {})

    // ── Flow chat message (appears in the client's chat history) ──
    const topic = buildFlowTopic(sd.service_type, deriveFlowYear(sd)) || null
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id not in generated types
      await (supabaseAdmin as any).from('portal_messages').insert({
        account_id: sd.account_id,
        contact_id: contactId,
        service_delivery_id: sd.id,
        topic,
        sender_type: 'admin',
        sender_id: user?.id ?? null,
        message,
      })
      notifyClientOfAdminMessage({
        account_id: sd.account_id,
        contact_id: contactId,
        topic,
        messagePreview: message,
      }).catch(() => {})
    } catch {
      /* chat message is best-effort — the EIN is already saved + the portal notification sent */
    }

    // ── Complete the formation ──
    // Close the SD + spawn the recurring SDs (RA Renewal + Annual Report) + send
    // the review request via the EXISTING sd.mark_complete primitive (no
    // duplicated logic — we construct the minimal HandlerContext it reads), then
    // upgrade the portal tier formation → active (which removes the "we're
    // forming your LLC" banner). Best-effort + idempotent: the EIN is already
    // saved, sdMarkComplete no-ops if the SD is already completed, and syncTier
    // is safe to re-run. A failure here is logged, not fatal — staff can still
    // "Mark Formation Complete" from the task card.
    try {
      const { sdMarkComplete } = await import('@/lib/tasks/workflow-handlers/sd-mark-complete')
      const { defaultTaskAssignee } = await import('@/lib/tasks/default-assignee')
      await sdMarkComplete({
        task: { delivery_id: sd.id, account_id: sd.account_id },
        action: { handler_params: { spawn_next_sds: ['State RA Renewal', 'State Annual Report'], send_review_request: true } },
        workflow: { slug: 'formation_progress', default_assignee: defaultTaskAssignee() },
        mode: 'execute',
      } as unknown as HandlerContext)

      const { syncTier } = await import('@/lib/operations/sync-tier')
      await syncTier({
        accountId: sd.account_id,
        newTier: 'active',
        reason: 'Company formation complete — EIN received',
        actor: 'flow-save-ein',
      })
    } catch (e) {
      console.error('[save-ein] formation completion (mark_complete / syncTier) failed:', e instanceof Error ? e.message : String(e))
    }

    return NextResponse.json({ success: true, ein_number: ein })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
