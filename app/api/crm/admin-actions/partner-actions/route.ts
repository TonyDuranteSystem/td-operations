/**
 * Partner Management API
 *
 * POST { action, params }
 *
 * Actions:
 *   create_partner      — Create new partner from existing contact
 *   update_partner      — Edit partner info (name, email, model, services, notes)
 *   send_portal         — Create partner portal user + send login email
 *   add_client          — Link an account to this partner (set partner_id)
 *   remove_client       — Unlink an account from partner (clear partner_id)
 *   create_invoice      — Create TD invoice addressed to partner for a client
 *   update_status       — Change partner status (active/suspended/inactive)
 *   approve_payout      — Phase 3C: approve a pending partner payout
 *   mark_payout_paid    — Phase 3C: mark an approved partner payout as paid
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/portal-auth'

export async function POST(req: NextRequest) {
  try {
    // Resolve caller. For Phase 3C admin actions we explicitly require a
    // non-client (dashboard) user so partners cannot self-approve payouts via
    // a crafted request. Existing actions are unchanged for back-compat.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const isAdmin = !!user && !isClient(user)

    const { action, params } = await req.json()

    if (!action) {
      return NextResponse.json({ success: false, detail: 'Missing action' }, { status: 400 })
    }

    let result: { success: boolean; detail: string; data?: unknown }

    switch (action) {
      // ─── LIST PARTNERS (for the offer-creation deal picker) ───
      case 'list': {
        const { data: partners } = await supabaseAdmin
          .from('client_partners')
          .select('id, partner_name, default_payout_model, default_payout_rate, status')
          .order('partner_name', { ascending: true })
        result = { success: true, detail: 'ok', data: { partners: (partners ?? []).filter(p => p.status !== 'inactive') } }
        break
      }

      // ─── CREATE PARTNER ───
      case 'create_partner': {
        const { contact_id, partner_name, partner_email, commission_model, agreed_services, price_list, notes } = params || {}
        if (!contact_id || !partner_name) {
          result = { success: false, detail: 'Missing contact_id or partner_name' }
          break
        }

        // Check for duplicate
        const { data: existing } = await supabaseAdmin
          .from('client_partners')
          .select('id')
          .eq('contact_id', contact_id)
          .limit(1)

        if (existing && existing.length > 0) {
          result = { success: false, detail: 'This contact already has a partner record' }
          break
        }

        const { data: newPartner, error: createErr } = await supabaseAdmin
          .from('client_partners')
          .insert({
            contact_id,
            partner_name,
            partner_email: partner_email || null,
            commission_model: commission_model || null,
            agreed_services: agreed_services || [],
            price_list: price_list || {},
            notes: notes || null,
          })
          .select('id, partner_name')
          .single()

        if (createErr) {
          result = { success: false, detail: createErr.message }
          break
        }

        // Update contact referrer_type
        // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.update; extract to lib/operations/ per dev_task fda76fd3
        await supabaseAdmin
          .from('contacts')
          .update({ referrer_type: 'partner', updated_at: new Date().toISOString() })
          .eq('id', contact_id)

        await supabaseAdmin.from('action_log').insert({
          actor: 'crm-admin',
          action_type: 'create_partner',
          table_name: 'client_partners',
          record_id: newPartner.id,
          summary: `Partner created: ${partner_name}`,
          details: params,
        })

        result = { success: true, detail: `Partner "${partner_name}" created`, data: newPartner }
        break
      }

      // ─── UPDATE PARTNER ───
      case 'update_partner': {
        const { partner_id, updates } = params || {}
        if (!partner_id || !updates) {
          result = { success: false, detail: 'Missing partner_id or updates' }
          break
        }

        const { error: upErr } = await supabaseAdmin
          .from('client_partners')
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq('id', partner_id)

        if (upErr) {
          result = { success: false, detail: upErr.message }
          break
        }

        result = { success: true, detail: 'Partner updated' }
        break
      }

      // ─── SEND PARTNER PORTAL ───
      case 'send_portal': {
        const { partner_id } = params || {}
        if (!partner_id) {
          result = { success: false, detail: 'Missing partner_id' }
          break
        }

        const { data: partner } = await supabaseAdmin
          .from('client_partners')
          .select('id, partner_name, partner_email, contact_id, contact:contacts!client_partners_contact_id_fkey(full_name, email, language)')
          .eq('id', partner_id)
          .single()

        if (!partner) {
          result = { success: false, detail: 'Partner not found' }
          break
        }

        const contact = partner.contact as unknown as { full_name: string; email: string; language: string } | null
        const email = partner.partner_email || contact?.email
        if (!email) {
          result = { success: false, detail: 'No email address for this partner' }
          break
        }

        // Check if portal user already exists (paginated — P1.9)
        const existingUser = await findAuthUserByEmail(email)

        if (existingUser) {
          // Update to partner role
          await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
            app_metadata: { ...existingUser.app_metadata, portal_tier: 'active' },
          })
          /* eslint-disable no-restricted-syntax -- pre-P2.4 raw contacts.update + Phase D1 portal_tier; extract to lib/operations/portal.ts reconcileTier() per dev_task fda76fd3 */
          await supabaseAdmin.from('contacts').update({
            portal_role: 'partner',
            portal_tier: 'active',
            referrer_type: 'partner',
            updated_at: new Date().toISOString(),
          }).eq('id', partner.contact_id)
          /* eslint-enable no-restricted-syntax */

          result = { success: true, detail: `Portal user already exists for ${email}. Updated to partner role.` }
          break
        }

        // Create new portal user
        const tempPassword = `TDp${Math.random().toString(36).slice(2, 8)}!`
        const { error: authErr } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: tempPassword,
          email_confirm: true,
          app_metadata: {
            role: 'client',
            contact_id: partner.contact_id,
            portal_tier: 'active',
          },
        })

        if (authErr) {
          result = { success: false, detail: `Auth error: ${authErr.message}` }
          break
        }

        // Update contact
        /* eslint-disable no-restricted-syntax -- pre-P2.4 raw contacts.update + Phase D1 portal_tier; extract to lib/operations/portal.ts reconcileTier() per dev_task fda76fd3 */
        await supabaseAdmin.from('contacts').update({
          portal_role: 'partner',
          portal_tier: 'active',
          referrer_type: 'partner',
          portal_email_sent_at: new Date().toISOString(),
          portal_email_template: 'partner-welcome',
          updated_at: new Date().toISOString(),
        }).eq('id', partner.contact_id)
        /* eslint-enable no-restricted-syntax */

        // Generate referral code
        const code = partner.partner_name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) + '-2026'
        // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.update; extract to lib/operations/ per dev_task fda76fd3
        await supabaseAdmin.from('contacts').update({ referral_code: code }).eq('id', partner.contact_id)

        // Send welcome email
        const { gmailPost } = await import('@/lib/gmail')
        const clientName = contact?.full_name?.split(' ')[0] || 'Partner'
        const isItalian = contact?.language === 'Italian'

        const subject = isItalian
          ? `Il tuo portale partner è pronto — Tony Durante LLC`
          : `Your partner portal is ready — Tony Durante LLC`
        const body = isItalian
          ? `Ciao ${clientName},\n\nIl tuo portale partner è pronto.\n\nPortale: https://portal.tonydurante.us/portal/login\nEmail: ${email}\nPassword: ${tempPassword}\n\nAl primo accesso ti verrà chiesto di cambiare la password.\n\nDal portale puoi vedere i tuoi clienti, le fatture e comunicare con il nostro team.\n\nCordiali saluti,\nTony Durante LLC`
          : `Hi ${clientName},\n\nYour partner portal is ready.\n\nPortal: https://portal.tonydurante.us/portal/login\nEmail: ${email}\nPassword: ${tempPassword}\n\nYou'll be asked to change your password on first login.\n\nFrom the portal you can see your clients, invoices, and communicate with our team.\n\nBest regards,\nTony Durante LLC`

        const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
        const rawEmail = [
          'From: Tony Durante LLC <support@tonydurante.us>',
          `To: ${email}`,
          `Subject: ${encodedSubject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(body).toString('base64'),
        ].join('\r\n')

        await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })

        await supabaseAdmin.from('action_log').insert({
          actor: 'crm-admin',
          action_type: 'send_partner_portal',
          table_name: 'client_partners',
          record_id: partner_id,
          summary: `Partner portal sent to ${email} (${partner.partner_name})`,
        })

        result = { success: true, detail: `Portal login sent to ${email}. Password: ${tempPassword}` }
        break
      }

      // ─── ADD CLIENT TO PARTNER ───
      case 'add_client': {
        const { partner_id, account_id } = params || {}
        if (!partner_id || !account_id) {
          result = { success: false, detail: 'Missing partner_id or account_id' }
          break
        }

        // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update; extract to lib/operations/ per dev_task fda76fd3
        const { error: linkErr } = await supabaseAdmin
          .from('accounts')
          .update({ partner_id, updated_at: new Date().toISOString() })
          .eq('id', account_id)

        if (linkErr) {
          result = { success: false, detail: linkErr.message }
          break
        }

        const { data: acct } = await supabaseAdmin.from('accounts').select('company_name').eq('id', account_id).single()

        await supabaseAdmin.from('action_log').insert({
          actor: 'crm-admin',
          action_type: 'add_partner_client',
          table_name: 'accounts',
          record_id: account_id,
          summary: `Linked ${acct?.company_name ?? account_id} to partner ${partner_id}`,
        })

        result = { success: true, detail: `${acct?.company_name ?? 'Account'} linked to partner` }
        break
      }

      // ─── REMOVE CLIENT FROM PARTNER ───
      case 'remove_client': {
        const { account_id: removeAcctId } = params || {}
        if (!removeAcctId) {
          result = { success: false, detail: 'Missing account_id' }
          break
        }

        // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update; extract to lib/operations/ per dev_task fda76fd3
        await supabaseAdmin
          .from('accounts')
          .update({ partner_id: null, updated_at: new Date().toISOString() })
          .eq('id', removeAcctId)

        result = { success: true, detail: 'Client removed from partner' }
        break
      }

      // ─── CREATE INVOICE FOR PARTNER ───
      case 'create_invoice': {
        const { partner_id, account_id: invoiceAcctId, description: invoiceDesc, amount: invoiceAmount, currency: invoiceCurrency } = params || {}
        if (!partner_id || !invoiceAmount) {
          result = { success: false, detail: 'Missing partner_id or amount' }
          break
        }

        const { data: partnerForInv } = await supabaseAdmin
          .from('client_partners')
          .select('contact_id, partner_name')
          .eq('id', partner_id)
          .single()

        if (!partnerForInv) {
          result = { success: false, detail: 'Partner not found' }
          break
        }

        const { createTDInvoice } = await import('@/lib/portal/td-invoice')
        const invResult = await createTDInvoice({
          contact_id: partnerForInv.contact_id,
          account_id: invoiceAcctId || undefined,
          line_items: [{
            description: invoiceDesc || `Partner service — ${partnerForInv.partner_name}`,
            unit_price: Number(invoiceAmount),
            quantity: 1,
          }],
          currency: (invoiceCurrency || 'EUR') as 'USD' | 'EUR',
          mark_as_paid: false,
        })

        await supabaseAdmin.from('action_log').insert({
          actor: 'crm-admin',
          action_type: 'create_partner_invoice',
          table_name: 'payments',
          record_id: invResult.paymentId,
          summary: `Invoice ${invResult.invoiceNumber} created for partner ${partnerForInv.partner_name}: ${invoiceCurrency || 'EUR'} ${invoiceAmount}`,
        })

        result = { success: true, detail: `Invoice ${invResult.invoiceNumber} created: ${invoiceCurrency || 'EUR'} ${invoiceAmount}` }
        break
      }

      // ─── APPROVE PARTNER PAYOUT (Phase 3C) ───
      case 'approve_payout': {
        if (!isAdmin) {
          result = { success: false, detail: 'Admin access required' }
          break
        }
        const { payout_id } = params || {}
        if (!payout_id) {
          result = { success: false, detail: 'Missing payout_id' }
          break
        }

        const { data: existing } = await supabaseAdmin
          .from('referral_payouts')
          .select('id, status, partner_id, amount, currency')
          .eq('id', payout_id)
          .single()

        if (!existing) {
          result = { success: false, detail: 'Payout not found' }
          break
        }
        if (existing.status !== 'pending' && existing.status !== 'manual_review' && existing.status !== 'requested') {
          result = { success: false, detail: `Payout already ${existing.status} — cannot approve` }
          break
        }

        const { error: upErr } = await supabaseAdmin
          .from('referral_payouts')
          .update({
            status: 'approved',
            approved_by: user!.id,
            approved_at: new Date().toISOString(),
          })
          .eq('id', payout_id)

        if (upErr) {
          result = { success: false, detail: upErr.message }
          break
        }

        await supabaseAdmin.from('action_log').insert({
          actor: user!.email || 'crm-admin',
          action_type: 'approve_partner_payout',
          table_name: 'referral_payouts',
          record_id: payout_id,
          summary: `Payout approved: ${existing.amount} ${existing.currency || 'EUR'}`,
          details: { partner_id: existing.partner_id, prev_status: existing.status },
        })

        result = { success: true, detail: 'Payout approved' }
        break
      }

      // ─── MARK PARTNER PAYOUT PAID (Phase 3C) ───
      case 'mark_payout_paid': {
        if (!isAdmin) {
          result = { success: false, detail: 'Admin access required' }
          break
        }
        const { payout_id, payout_method } = params || {}
        if (!payout_id || !payout_method) {
          result = { success: false, detail: 'Missing payout_id or payout_method' }
          break
        }
        const ALLOWED_METHODS = ['bank_transfer', 'credit_note', 'invoice_deduction'] as const
        if (!(ALLOWED_METHODS as readonly string[]).includes(payout_method)) {
          result = { success: false, detail: `Invalid payout_method. Must be one of: ${ALLOWED_METHODS.join(', ')}` }
          break
        }

        const { data: existing } = await supabaseAdmin
          .from('referral_payouts')
          .select('id, status, partner_id, amount, currency')
          .eq('id', payout_id)
          .single()

        if (!existing) {
          result = { success: false, detail: 'Payout not found' }
          break
        }
        if (existing.status !== 'approved') {
          result = { success: false, detail: `Payout must be 'approved' first (current: ${existing.status})` }
          break
        }

        const { error: upErr } = await supabaseAdmin
          .from('referral_payouts')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payout_method,
          })
          .eq('id', payout_id)

        if (upErr) {
          result = { success: false, detail: upErr.message }
          break
        }

        await supabaseAdmin.from('action_log').insert({
          actor: user!.email || 'crm-admin',
          action_type: 'mark_partner_payout_paid',
          table_name: 'referral_payouts',
          record_id: payout_id,
          summary: `Payout marked paid via ${payout_method}: ${existing.amount} ${existing.currency || 'EUR'}`,
          details: { partner_id: existing.partner_id, payout_method },
        })

        result = { success: true, detail: `Payout marked paid via ${payout_method}` }
        break
      }

      // ─── UPDATE STATUS ───
      case 'update_status': {
        const { partner_id: statusPartnerId, status: newStatus } = params || {}
        if (!statusPartnerId || !newStatus) {
          result = { success: false, detail: 'Missing partner_id or status' }
          break
        }

        await supabaseAdmin
          .from('client_partners')
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', statusPartnerId)

        result = { success: true, detail: `Partner status updated to ${newStatus}` }
        break
      }

      default:
        result = { success: false, detail: `Unknown action: ${action}` }
    }

    return NextResponse.json(result)
  } catch (e) {
    console.error('[partner-actions] Error:', e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
