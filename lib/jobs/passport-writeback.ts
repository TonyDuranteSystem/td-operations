/**
 * Passport OCR → contact writeback.
 *
 * Shared between onboarding-setup and formation-setup so every handler
 * that uploads a passport also extracts and stores passport_number /
 * passport_expiry_date / date_of_birth on the contact record.
 *
 * Before 2026-04-18 (dev_task 3274fdf6) only formation-setup did this —
 * onboarding-setup uploaded the passport to Drive, ran OCR in the
 * cross-check pass, and discarded the parsed data. Result: 96 contacts
 * with passport_on_file=true but no extracted passport fields.
 *
 * Exposed as one helper so callers only push a single step row and we
 * keep the OCR + parse + write logic in one place.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { ocrDriveFile } from "@/lib/docai"
import { parsePassportFromOcr } from "@/lib/passport-processing"

const OCR_SUPPORTED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/gif",
  "image/bmp",
  "image/webp",
])

export interface PassportWritebackResult {
  status: "ok" | "skipped" | "error"
  detail: string
  /** Field names that landed on the contact (empty if skipped/error). */
  extracted_fields: string[]
  /** True when the mime type is unsupported and we created a manual task
   *  instead. Callers that also want to log a `doc_copy` step should use
   *  this to avoid double-logging. */
  manual_task_created?: boolean
}

export interface PassportWritebackParams {
  contact_id: string
  drive_file_id: string
  mime_type: string
  /** If the wizard already captured DOB explicitly, skip overwriting it
   *  from MRZ (wizard is more authoritative — the client typed it). */
  skip_dob?: boolean
  /** For the manual-task description when mime isn't OCR-supported. */
  contact_name?: string
  account_id?: string | null
}

export async function extractAndStorePassportData(
  params: PassportWritebackParams,
): Promise<PassportWritebackResult> {
  const { contact_id, drive_file_id, mime_type, skip_dob, contact_name, account_id } = params

  // Unsupported format (HEIC, etc.) — create a task for manual entry.
  if (!OCR_SUPPORTED_MIMES.has(mime_type)) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await supabaseAdmin.from("tasks").insert({
        task_title: `Manual passport data entry: ${contact_name || contact_id}`,
        description: `Passport uploaded as ${mime_type} (not supported by OCR). Manually enter passport_number and passport_expiry_date on the contact record.`,
        assigned_to: "Luca",
        category: "Document",
        priority: "Normal",
        status: "To Do",
        ...(account_id ? { account_id } : {}),
        contact_id,
      })
    } catch {
      // Non-blocking
    }
    return {
      status: "skipped",
      detail: `Unsupported format for OCR: ${mime_type}. Manual data entry task created.`,
      extracted_fields: [],
      manual_task_created: true,
    }
  }

  try {
    const ocrResult = await ocrDriveFile(drive_file_id)
    if (!ocrResult.fullText) {
      return { status: "ok", detail: "OCR ran but returned no text", extracted_fields: [] }
    }

    const passportData = parsePassportFromOcr(ocrResult.fullText)

    const updates: Record<string, unknown> = {}
    if (passportData.passportNumber) updates.passport_number = passportData.passportNumber
    if (passportData.expiryDate) updates.passport_expiry_date = passportData.expiryDate
    if (passportData.dateOfBirth && !skip_dob) updates.date_of_birth = passportData.dateOfBirth

    if (Object.keys(updates).length === 0) {
      return { status: "ok", detail: "OCR ran but no MRZ / visual patterns matched", extracted_fields: [] }
    }

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error: upErr } = await supabaseAdmin
      .from("contacts")
      .update({ ...updates, passport_on_file: true, updated_at: new Date().toISOString() })
      .eq("id", contact_id)

    if (upErr) {
      return { status: "error", detail: upErr.message, extracted_fields: [] }
    }

    return {
      status: "ok",
      detail: `Extracted + stored: ${Object.keys(updates).join(", ")}`,
      extracted_fields: Object.keys(updates),
    }
  } catch (e) {
    return {
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
      extracted_fields: [],
    }
  }
}
