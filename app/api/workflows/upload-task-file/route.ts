/**
 * POST /api/workflows/upload-task-file
 *
 * Multipart-form upload endpoint used by ActionConfirmModal when a workflow
 * action declares an input field of type='file'. Uploads the file to the
 * parent task's company storage (under an optional subfolder), returns
 * the resulting storage pointer + display name. The modal then stores that
 * file_id as the param value and the workflow handler consumes it like any
 * other string param.
 *
 * Admin-only (same role gate as the dispatcher route — workflow actions are
 * staff-driven). A company with no storage gets one plain sentence back (409).
 *
 * Request: multipart/form-data
 *   file:      (File)  the binary to upload — required
 *   task_id:   (UUID)  parent task — required (used to resolve the Drive folder)
 *   subfolder: (str)   optional subfolder name (e.g. 'ITIN/IRS Letters')
 *
 * Response 200: { file_id, file_name, mime_type, drive_url: null }
 * Response 4xx/5xx: { error: '<message>' }
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { NO_STORAGE_SENTENCE, NO_STORAGE_STATUS } from "@/lib/crm-store/no-storage"

export const maxDuration = 60

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status })
}

export async function POST(request: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return json({ error: "Unauthenticated" }, 401)
  if (!isDashboardUser(user)) return json({ error: "Dashboard access required" }, 403)

  // ── Parse multipart form ────────────────────────────────────────────
  let form: FormData
  try {
    form = await request.formData()
  } catch (err) {
    return json(
      { error: `Failed to parse multipart body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    )
  }
  const file = form.get("file")
  const taskId = form.get("task_id")
  const subfolderRaw = form.get("subfolder")

  if (!file || typeof file === "string") {
    return json({ error: "Missing 'file' part in form" }, 400)
  }
  if (typeof taskId !== "string" || !taskId) {
    return json({ error: "Missing 'task_id'" }, 400)
  }

  // ── Resolve the parent task → account_id ──────────
  const { data: task, error: taskErr } = await supabaseAdmin
    .from("tasks")
    .select("id, account_id, contact_id")
    .eq("id", taskId)
    .maybeSingle()
  if (taskErr || !task) {
    return json({ error: `Task ${taskId} not found` }, 404)
  }
  if (!task.account_id) {
    return json({ error: "Task has no account_id — cannot determine the company storage" }, 400)
  }
  const { data: account, error: acctErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name")
    .eq("id", task.account_id)
    .maybeSingle()
  if (acctErr || !account) {
    return json({ error: `Account ${task.account_id} not found` }, 404)
  }
  const fileName = (file as File).name || `upload-${Date.now()}.bin`
  const mimeType = (file as File).type || "application/octet-stream"
  const arrayBuffer = await (file as File).arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // ── The file is kept in the company's storage (same sub-folder path); the value handed back is a storage pointer that
  // email, documents and OCR open through the standard reader. A company with no storage gets one plain sentence. ──
  try {
    const { saveTaskFileForAccount } = await import("@/lib/crm-store/save-form")
    const { CompanyMovingError } = await import("@/lib/crm-store/save-for-account")
    const { createHash } = await import("crypto")
    try {
      const routed = await saveTaskFileForAccount({
        accountId: account.id as string,
        subfolder: typeof subfolderRaw === "string" && subfolderRaw.trim() ? subfolderRaw : "Workflow Uploads",
        name: fileName, bytes: buffer, mimeType,
        callerKey: `task-file:${taskId}:${createHash("sha256").update(buffer).digest("hex")}`,
      })
      if (routed.route === "store") {
        return json({ file_id: routed.pointer, file_name: fileName, mime_type: mimeType, drive_url: null })
      }
      return json({ error: NO_STORAGE_SENTENCE }, NO_STORAGE_STATUS)
    } catch (err) {
      if (err instanceof CompanyMovingError) return json({ error: err.message }, 409)
      throw err
    }
  } catch (err) {
    return json({ error: `Saving the file failed: ${err instanceof Error ? err.message : String(err)}` }, 500)
  }
}
