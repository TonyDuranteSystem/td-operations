/**
 * fileRenewal — atomic Mark Filed action invoked from the CRM Calendar.
 *
 * Flow per SOP RA Renewal v7.1 + State Annual Report v7.0:
 *   1. Resolve the account + Drive folder + primary contact.
 *   2. Ensure `Compliance/` subfolder exists under the account folder.
 *   3. Upload the receipt PDF as `RA Renewal {year}.pdf` or `Annual Report {year}.pdf`.
 *   4. Insert a `documents` row (portal-visible).
 *   5. Resolve / create the SD, then completeSD — the existing
 *      lib/service-delivery.ts:270-341 hook auto-rolls
 *      accounts.ra_renewal_date / annual_report_due_date by +1 year.
 *   6. Sync the legacy `deadlines` row to status='Filed'.
 *   7. Append a dated entry to `accounts.notes` (CRM Update Rule).
 *   8. Trigger the SOP-mandated portal notification (portal-active clients only).
 *
 * No confirmation_number, no bulk. Receipt is REQUIRED. Sandbox-only path
 * gracefully no-ops Drive writes (SANDBOX_MODE=1) per uploadBinaryToDrive.
 *
 * Dev task: 8efb34e5-dcf1-4a66-8b95-fe8c9a67addb
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { ensureDrivePath, uploadBinaryToDrive } from "@/lib/google-drive"
import { completeSD, createSD } from "@/lib/operations/service-delivery"
import { createPortalNotification } from "@/lib/portal/notifications"
import { safeAction, type ActionResult } from "@/lib/server-action"
import { PORTAL_BASE_URL } from "@/lib/config"

export type RenewalKind = "ra" | "ar"

export interface FileRenewalParams {
  account_id: string
  /** Existing active SD id to complete. If null, the function creates the SD then completes it. */
  delivery_id: string | null
  kind: RenewalKind
  /** ISO date string YYYY-MM-DD. */
  filed_date: string
  receipt: {
    /** Original upload name — used only for audit; written file uses SOP filename. */
    file_name: string
    mime_type: string
    data: Buffer
  }
}

export interface FileRenewalResult {
  delivery_id: string
  drive_file_id: string
  drive_link: string
  document_id: string
}

const SERVICE_TYPE_BY_KIND: Record<RenewalKind, "State RA Renewal" | "State Annual Report"> = {
  ra: "State RA Renewal",
  ar: "State Annual Report",
}

const DOC_TYPE_NAME_BY_KIND: Record<RenewalKind, string> = {
  ra: "RA Renewal Confirmation",
  ar: "Annual Report Confirmation",
}

const DEADLINE_TYPE_BY_KIND: Record<RenewalKind, "RA Renewal" | "Annual Report"> = {
  ra: "RA Renewal",
  ar: "Annual Report",
}

// ─── Pure helpers (unit-testable) ───────────────────────

/** Match contacts.language storing both 'it' (ISO) and 'Italian'. */
export function isItalianLang(lang: string | null | undefined): boolean {
  if (!lang) return false
  return ["it", "italian"].includes(lang.toLowerCase())
}

/** Drive filename per SOP v7.0 — flat under Compliance/, year in name. */
export function buildRenewalFilename(kind: RenewalKind, year: number): string {
  return kind === "ra" ? `RA Renewal ${year}.pdf` : `Annual Report ${year}.pdf`
}

/** Append a dated entry to accounts.notes (CRM Update Rule). */
export function buildAccountNoteEntry(
  kind: RenewalKind,
  year: number,
  filedDate: string,
  driveLink: string,
  currentNotes: string | null,
): string {
  const label = kind === "ra" ? "RA Renewal" : "Annual Report"
  const entry = `${filedDate}: ${label} ${year} filed → ${driveLink}`
  return currentNotes ? `${currentNotes}\n${entry}` : entry
}

/** Year derived from a YYYY-MM-DD filed_date. Throws on garbage. */
export function yearFromFiledDate(filedDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filedDate)) {
    throw new Error(`Invalid filed_date — expected YYYY-MM-DD, got "${filedDate}"`)
  }
  const year = parseInt(filedDate.slice(0, 4), 10)
  if (Number.isNaN(year)) throw new Error(`Invalid filed_date year: "${filedDate}"`)
  return year
}

/** Portal notification body per SOP v7.0 — bilingual EN/IT. */
export function buildNotificationContent(
  kind: RenewalKind,
  state: string,
  year: number,
  isItalian: boolean,
): { title: string; body: string } {
  const stateLabel = state || (isItalian ? "il tuo stato" : "your state")
  if (kind === "ra") {
    return isItalian
      ? {
          title: "Registered Agent rinnovato",
          body: "Il tuo Registered Agent è stato rinnovato per un altro anno.",
        }
      : {
          title: "Registered Agent Renewed",
          body: "Your Registered Agent has been renewed for another year.",
        }
  }
  // ar
  return isItalian
    ? {
        title: `Annual Report ${stateLabel} archiviato`,
        body: `Il tuo Annual Report per ${stateLabel} è stato archiviato per ${year}.`,
      }
    : {
        title: `Annual Report ${stateLabel} Filed`,
        body: `Your Annual Report for ${stateLabel} has been filed for ${year}.`,
      }
}

// ─── Main entry ───────────────────────────────────────────

export async function fileRenewal(
  params: FileRenewalParams,
): Promise<ActionResult<FileRenewalResult>> {
  return safeAction<FileRenewalResult>(
    async () => {
      const year = yearFromFiledDate(params.filed_date)

      // 1. Load account
      const { data: account, error: acctErr } = await supabaseAdmin
        .from("accounts")
        .select("id, company_name, state_of_formation, drive_folder_id, portal_tier, notes")
        .eq("id", params.account_id)
        .maybeSingle()
      if (acctErr || !account) {
        throw new Error(
          `Account ${params.account_id} not found: ${acctErr?.message ?? "unknown"}`,
        )
      }
      if (!account.drive_folder_id) {
        throw new Error(
          `Account "${account.company_name}" has no Drive folder — cannot save receipt.`,
        )
      }

      // 2. Ensure Compliance/ subfolder under the account folder (per SOP v7.0)
      const complianceFolderId = await ensureDrivePath(account.drive_folder_id, [
        "Compliance",
      ])

      // 3. Upload receipt with SOP filename
      const targetFilename = buildRenewalFilename(params.kind, year)
      const upload = (await uploadBinaryToDrive(
        targetFilename,
        params.receipt.data,
        params.receipt.mime_type || "application/pdf",
        complianceFolderId,
      )) as { id: string; name: string }
      const driveLink = `https://drive.google.com/file/d/${upload.id}/view`

      // 4. Insert documents row (audit + portal sync)
      const { data: docRow, error: docErr } = await supabaseAdmin
        .from("documents")
        .insert({
          drive_file_id: upload.id,
          file_name: targetFilename,
          mime_type: params.receipt.mime_type || "application/pdf",
          drive_link: driveLink,
          drive_parent_folder_id: complianceFolderId,
          document_type_name: DOC_TYPE_NAME_BY_KIND[params.kind],
          category_name: "Compliance",
          account_id: account.id,
          portal_visible: true,
          status: "processed",
          processed_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      if (docErr || !docRow) {
        throw new Error(`Failed to insert documents row: ${docErr?.message ?? "unknown"}`)
      }

      // 5. Resolve / create the SD, then complete it.
      // completeSD → advanceServiceDelivery → triggers +1y rollover on
      // accounts.ra_renewal_date / annual_report_due_date
      // (lib/service-delivery.ts:270-341).
      let deliveryId = params.delivery_id
      if (!deliveryId) {
        const sd = await createSD({
          service_type: SERVICE_TYPE_BY_KIND[params.kind],
          account_id: account.id,
          assigned_to: "Antonio",
          notes: `Filed via Calendar Mark Filed on ${params.filed_date}`,
          status: "active",
        })
        deliveryId = sd.id
      }

      const completion = await completeSD({
        delivery_id: deliveryId,
        actor: "dashboard:calendar",
        notes: `Filed ${params.filed_date} — receipt: ${driveLink}`,
      })
      if (!completion.success) {
        throw new Error(`completeSD failed: ${completion.error ?? "unknown"}`)
      }

      // 6. Sync legacy deadlines row → Filed (best-effort, no-op if no row)
      await supabaseAdmin
        .from("deadlines")
        .update({
          status: "Filed",
          filed_date: params.filed_date,
          deadline_record: driveLink,
          updated_at: new Date().toISOString(),
        })
        .eq("account_id", account.id)
        .eq("deadline_type", DEADLINE_TYPE_BY_KIND[params.kind])
        .eq("year", year)

      // 7. Append accounts.notes entry (CRM Update Rule)
      const newNotes = buildAccountNoteEntry(
        params.kind,
        year,
        params.filed_date,
        driveLink,
        account.notes,
      )
      // eslint-disable-next-line no-restricted-syntax -- per-feature dashboard write; safeAction wraps audit
      await supabaseAdmin
        .from("accounts")
        .update({ notes: newNotes, updated_at: new Date().toISOString() })
        .eq("id", account.id)

      // 8. Portal notification per SOP — only for portal-active clients
      if (account.portal_tier === "active") {
        const { data: links } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id")
          .eq("account_id", account.id)
          .limit(1)
        const primaryContactId = links?.[0]?.contact_id ?? null

        let lang: string | null = null
        if (primaryContactId) {
          const { data: c } = await supabaseAdmin
            .from("contacts")
            .select("language")
            .eq("id", primaryContactId)
            .maybeSingle()
          lang = c?.language ?? null
        }

        const { title, body } = buildNotificationContent(
          params.kind,
          account.state_of_formation || "",
          year,
          isItalianLang(lang),
        )

        await createPortalNotification({
          account_id: account.id,
          contact_id: primaryContactId ?? undefined,
          type: params.kind === "ra" ? "ra_renewed" : "annual_report_filed",
          title,
          body,
          link: `${PORTAL_BASE_URL}/portal`,
        })
      }

      return {
        delivery_id: deliveryId,
        drive_file_id: upload.id,
        drive_link: driveLink,
        document_id: docRow.id as string,
      }
    },
    {
      action_type: "update",
      table_name: "service_deliveries",
      record_id: params.delivery_id ?? undefined,
      account_id: params.account_id,
      summary: `${params.kind === "ra" ? "RA Renewal" : "Annual Report"} filed via calendar (${params.filed_date})`,
      details: {
        kind: params.kind,
        filed_date: params.filed_date,
        receipt_file_name: params.receipt.file_name,
      },
    },
  )
}
