/**
 * itin.approve_and_send — Service-specific handler for the ITIN review
 * "Approve & Send to Client" action.
 *
 * Composes three primitives (same outcome as chain.send_email +
 * chain.send_client_message + chain.advance_sd_stage) but directly invokes
 * the underlying helpers (sendEmail, supabase ops, advanceStage) so the
 * side-effect tracking is honest about what actually happened.
 *
 * task_meta MUST match WORKFLOW_SCHEMAS.itin_review_v1 (validated by the
 * dispatcher before this handler runs).
 *
 * On success:
 *   - Email sent to client.client_email with 3 Drive PDF attachments + signing
 *     instructions in the client's language (en/it).
 *   - Portal chat message posted (bilingual) so the client sees a notice in
 *     the portal in addition to the email.
 *   - Service Delivery stage advanced Document Preparation → Client Signing.
 *   - itin_submissions.status updated to 'sent_to_client' (best-effort, not
 *     a tracked side-effect — purely a status flag for analytics).
 *
 * Rollbacks (in reverse):
 *   - SD stage reverted to Document Preparation.
 *   - Portal message soft-deleted (R100).
 *   - Email is NOT rollback-able. Documented in the side_effect for ops
 *     visibility; the recall handler (itin.recall_and_recorrect) is the
 *     correct path for retracting an already-sent ITIN package.
 */

import { sendEmail } from "@/lib/operations/email"
import { advanceStage } from "@/lib/operations/service-delivery"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"
import type { ItinReviewV1Meta } from "@/lib/tasks/workflow-schemas"

const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"
const TARGET_SD_STAGE = "Client Signing"

function buildEmailBody(meta: ItinReviewV1Meta): { subject: string; html: string } {
  const firstName = meta.client_first_name
  if (meta.client_language === "it") {
    return {
      subject: `I tuoi documenti ITIN sono pronti per la firma`,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<p>Ciao ${firstName},</p>
<p>I documenti per la tua richiesta ITIN sono pronti per la firma.</p>
<p>In allegato trovi:</p>
<ol>
  <li><strong>Form W-7</strong> — Application for IRS Individual Taxpayer Identification Number</li>
  <li><strong>Form 1040-NR</strong> — U.S. Nonresident Alien Income Tax Return</li>
  <li><strong>Schedule OI</strong> — Other Information</li>
</ol>
<h3>Istruzioni</h3>
<ol>
  <li>Stampa tutti e tre i documenti.</li>
  <li>Firma il W-7 nella riga "Signature of applicant" (firma a inchiostro obbligatoria).</li>
  <li>Firma il 1040-NR a pagina 2, riga "Your signature" (firma a inchiostro obbligatoria).</li>
  <li>Includi una <strong>copia del passaporto</strong> (faremo noi la certificazione CAA).</li>
  <li>Spedisci tutto a:<br/>
    <pre style="background:#f4f6f8;padding:10px;border-radius:6px;display:inline-block">Tony Durante LLC
10225 Ulmerton Rd, Suite 3D
Largo, FL 33771
United States</pre>
  </li>
</ol>
<p>Usa un corriere tracciabile (FedEx, DHL, UPS) e condividi il numero di tracking con noi.</p>
<p>Una volta ricevuti i documenti, certificheremo il tuo passaporto (procedura CAA) e invieremo il pacchetto completo all'IRS via raccomandata. L'IRS impiega tipicamente 7–11 settimane per processare le richieste ITIN.</p>
<p>Per qualsiasi domanda, rispondi a questa email.</p>
<p>A presto,<br/>Tony Durante LLC<br/>+1 (727) 452-1093<br/>support@tonydurante.us</p>
</div>`,
    }
  }
  return {
    subject: `Your ITIN Application Documents — Ready for Signature`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<p>Hi ${firstName},</p>
<p>Your ITIN application documents are ready for your signature.</p>
<p>Attached you will find:</p>
<ol>
  <li><strong>Form W-7</strong> — Application for IRS Individual Taxpayer Identification Number</li>
  <li><strong>Form 1040-NR</strong> — U.S. Nonresident Alien Income Tax Return</li>
  <li><strong>Schedule OI</strong> — Other Information</li>
</ol>
<h3>Instructions</h3>
<ol>
  <li>Print all three documents.</li>
  <li>Sign the W-7 on the "Signature of applicant" line (wet-ink signature required).</li>
  <li>Sign the 1040-NR on page 2, "Your signature" line (wet-ink signature required).</li>
  <li>Include a <strong>passport copy</strong> (we'll handle the CAA certification).</li>
  <li>Mail everything to:<br/>
    <pre style="background:#f4f6f8;padding:10px;border-radius:6px;display:inline-block">Tony Durante LLC
10225 Ulmerton Rd, Suite 3D
Largo, FL 33771
United States</pre>
  </li>
</ol>
<p>Please use a trackable shipping method (FedEx, DHL, UPS) and share the tracking number with us.</p>
<p>Once we receive your documents we'll CAA-certify your passport copy and submit the complete ITIN application to the IRS via certified mail. The IRS typically processes ITIN applications within 7–11 weeks.</p>
<p>Reply to this email with any questions.</p>
<p>Best regards,<br/>Tony Durante LLC<br/>+1 (727) 452-1093<br/>support@tonydurante.us</p>
</div>`,
  }
}

function buildPortalMessage(meta: ItinReviewV1Meta): string {
  if (meta.client_language === "it") {
    return `Ciao ${meta.client_first_name}, ti abbiamo appena inviato via email i tre moduli ITIN pronti per la firma (W-7, 1040-NR, Schedule OI). Stampa, firma a inchiostro, allega una copia del passaporto, e spedisci a Tony Durante LLC, 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771. Usa un corriere tracciabile e condividi con noi il numero di tracking. Grazie!`
  }
  return `Hi ${meta.client_first_name}, we just emailed you the three ITIN forms ready for signature (W-7, 1040-NR, Schedule OI). Print them, sign in wet ink, include a passport copy, and mail to Tony Durante LLC, 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771. Please use a trackable shipping method and share the tracking number with us. Thanks!`
}

export const itinApproveAndSend: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  // task_meta is already validated by the dispatcher against itin_review_v1.
  const meta = ctx.task.task_meta as unknown as ItinReviewV1Meta

  const driveFileIds = meta.attachments.filter((a) => a.kind !== "passport_copy").map((a) => a.file_id)
  const { subject, html } = buildEmailBody(meta)

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        { kind: "email.preview", detail: `Would email ${meta.client_email} with ${driveFileIds.length} PDFs` },
        { kind: "portal_message.preview", detail: `Would post bilingual portal chat` },
        { kind: "sd.advance.preview", detail: `Document Preparation → ${TARGET_SD_STAGE}` },
      ],
      preview: {
        email_html: html,
        portal_message: buildPortalMessage(meta),
        sd_stage_change: `Document Preparation → ${TARGET_SD_STAGE}`,
      },
    }
  }

  const sideEffects: SideEffect[] = []

  // ── 1. Send email to client ─────────────────────────────────────────
  const emailResult = await sendEmail({
    to: meta.client_email,
    subject,
    body_html: html,
    drive_file_ids: driveFileIds,
    account_id: ctx.task.account_id ?? undefined,
    contact_id: ctx.task.contact_id ?? undefined,
    tag: "workflow:itin_review:approve_and_send",
  })
  if (emailResult.outcome === "duplicate_blocked") {
    return {
      success: false,
      error: {
        code: "EMAIL_DUPLICATE_BLOCKED",
        message: `Same subject already sent to ${meta.client_email} within 7 days. If this is a legitimate resend, use the recall handler.`,
      },
      side_effects: [],
    }
  }
  if (!emailResult.success) {
    return {
      success: false,
      error: { code: "EMAIL_SEND_FAILED", message: emailResult.error ?? "sendEmail returned success=false" },
      side_effects: [],
    }
  }
  sideEffects.push({
    kind: "email.sent",
    detail: `To ${meta.client_email} with ${driveFileIds.length} Drive attachments`,
    ref_id: emailResult.gmail_message_id ?? undefined,
    // No rollback — emails can't be unsent. itin.recall_and_recorrect is the
    // correct path for retracting a sent ITIN package.
  })

  // ── 2. Post portal chat message ─────────────────────────────────────
  const portalBody = buildPortalMessage(meta)
  let resolvedContactId = ctx.task.contact_id ?? null
  if (!resolvedContactId && ctx.task.account_id) {
    const { data: primary } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", ctx.task.account_id)
      .eq("is_primary", true)
      .maybeSingle()
    resolvedContactId = primary?.contact_id ?? null
  }

  const { data: portalMsg, error: portalErr } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      account_id: ctx.task.account_id ?? null,
      contact_id: resolvedContactId,
      sender_type: "admin",
      sender_id: ADMIN_SENDER_ID,
      message: portalBody,
      topic: ctx.workflow.auto_topic ?? "ITIN",
      attachments: [],
    })
    .select("id, created_at")
    .single()

  if (portalErr || !portalMsg) {
    return {
      success: false,
      error: {
        code: "PORTAL_MESSAGE_INSERT_FAILED",
        message: portalErr?.message ?? "portal_messages.insert returned no row",
      },
      side_effects: sideEffects,
    }
  }
  sideEffects.push({
    kind: "portal_message.sent",
    detail: `Bilingual notice in ${meta.client_language}`,
    ref_id: portalMsg.id,
    rollback: async () => {
      await supabaseAdmin
        .from("portal_messages")
        .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.actor.id })
        .eq("id", portalMsg.id)
    },
  })

  // Notify (fire-and-forget; R103-throttled).
  void (async () => {
    try {
      const { createPortalNotification, notifyClientOfAdminMessage } = await import(
        "@/lib/portal/notifications"
      )
      await createPortalNotification({
        account_id: ctx.task.account_id ?? undefined,
        contact_id: ctx.task.contact_id ?? undefined,
        type: "chat",
        title: "ITIN documents ready for signature",
        body: portalBody.slice(0, 100),
        link: "/portal/chat",
      })
      await notifyClientOfAdminMessage({
        account_id: ctx.task.account_id ?? null,
        contact_id: ctx.task.contact_id ?? null,
        messagePreview: portalBody,
      })
    } catch (err) {
      console.warn("[itin.approve_and_send] portal notification failed:", err)
    }
  })()

  // ── 3. Advance SD stage ────────────────────────────────────────────
  if (!ctx.task.delivery_id) {
    // Don't fail the whole action — the SD might already be advanced manually,
    // or this is a contact-only ITIN with no SD yet. Surface as a warning.
    sideEffects.push({
      kind: "sd.advance.skipped",
      detail: "No delivery_id on task — SD advance skipped",
    })
  } else {
    const { data: sd } = await supabaseAdmin
      .from("service_deliveries")
      .select("stage")
      .eq("id", ctx.task.delivery_id)
      .maybeSingle()
    const fromStage = sd?.stage ?? ""
    if (fromStage === TARGET_SD_STAGE) {
      sideEffects.push({
        kind: "sd.advance.no_op",
        detail: `SD already at ${TARGET_SD_STAGE}`,
      })
    } else {
      const advance = await advanceStage({
        delivery_id: ctx.task.delivery_id,
        target_stage: TARGET_SD_STAGE,
        actor: "workflow:itin.approve_and_send",
        notes: `ITIN docs sent to ${meta.client_email}; awaiting client to mail signed package`,
      })
      if (!advance.success) {
        return {
          success: false,
          error: {
            code: "SD_ADVANCE_FAILED",
            message: advance.error ?? "advanceStage returned success=false",
            partial_state: {
              email_sent_to: meta.client_email,
              portal_message_id: portalMsg.id,
            },
          },
          side_effects: sideEffects,
        }
      }
      sideEffects.push({
        kind: "sd.stage_advanced",
        detail: `${advance.from_stage} → ${advance.to_stage}`,
        ref_id: ctx.task.delivery_id,
        rollback: async () => {
          await advanceStage({
            delivery_id: ctx.task.delivery_id as string,
            target_stage: fromStage,
            actor: "workflow:itin.approve_and_send:rollback",
            notes: `Rollback from ${TARGET_SD_STAGE}`,
          })
        },
      })
    }
  }

  // ── 4. Best-effort itin_submissions status flag (not a tracked side-effect) ─
  try {
    await supabaseAdmin
      .from("itin_submissions")
      .update({
        status: "sent_to_client",
        updated_at: new Date().toISOString(),
      })
      .eq("id", meta.submission_id)
  } catch (err) {
    console.warn("[itin.approve_and_send] itin_submissions status update failed:", err)
  }

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      email_sent_at: new Date().toISOString(),
      email_message_id: emailResult.gmail_message_id,
      portal_message_id: portalMsg.id,
    },
    result: {
      email_message_id: emailResult.gmail_message_id,
      portal_message_id: portalMsg.id,
      sd_stage_advanced_to: ctx.task.delivery_id ? TARGET_SD_STAGE : null,
    },
  }
}
