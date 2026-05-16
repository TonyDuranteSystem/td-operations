/**
 * POST /api/workflows/upload-task-file
 *
 * Multipart-form upload endpoint used by ActionConfirmModal when a workflow
 * action declares an input field of type='file'. Uploads the file to the
 * parent task's account Drive folder (under an optional subfolder), returns
 * the resulting Drive file_id + display name. The modal then stores that
 * file_id as the param value and the workflow handler consumes it like any
 * other string param.
 *
 * Admin-only (same role gate as the dispatcher route — workflow actions are
 * staff-driven). In sandbox (SANDBOX_MODE=1), the Drive upload is mocked
 * by lib/google-drive.ts and returns id='sandbox-mock' — the workflow path
 * still completes cleanly without writing to real Drive.
 *
 * Request: multipart/form-data
 *   file:      (File)  the binary to upload — required
 *   task_id:   (UUID)  parent task — required (used to resolve the Drive folder)
 *   subfolder: (str)   optional subfolder name (e.g. 'ITIN/IRS Letters')
 *
 * Response 200: { file_id, file_name, mime_type, drive_url }
 * Response 4xx/5xx: { error: '<message>' }
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { listFolder, createFolder, uploadBinaryToDrive } from "@/lib/google-drive"

export const maxDuration = 60

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status })
}

/** Get-or-create a subfolder under a parent. Drive subfolder names are exact match. */
async function ensureSubfolder(parentId: string, name: string): Promise<string> {
  const contents = (await listFolder(parentId)) as {
    files?: Array<{ id: string; name: string; mimeType: string }>
  }
  const existing = contents?.files?.find(
    (f) => f.name === name && f.mimeType === "application/vnd.google-apps.folder",
  )
  if (existing) return existing.id
  const created = (await createFolder(parentId, name)) as { id: string }
  return created.id
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

  // ── Resolve the parent task → account_id → drive_folder_id ──────────
  const { data: task, error: taskErr } = await supabaseAdmin
    .from("tasks")
    .select("id, account_id, contact_id")
    .eq("id", taskId)
    .maybeSingle()
  if (taskErr || !task) {
    return json({ error: `Task ${taskId} not found` }, 404)
  }
  if (!task.account_id) {
    return json({ error: "Task has no account_id — cannot determine destination Drive folder" }, 400)
  }
  const { data: account, error: acctErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, drive_folder_id")
    .eq("id", task.account_id)
    .maybeSingle()
  if (acctErr || !account) {
    return json({ error: `Account ${task.account_id} not found` }, 404)
  }
  if (!account.drive_folder_id) {
    return json(
      {
        error:
          "Account has no drive_folder_id — provision a Drive folder for the account before using file-upload workflow actions",
      },
      400,
    )
  }

  // ── Upload to Drive ─────────────────────────────────────────────────
  const fileName = (file as File).name || `upload-${Date.now()}.bin`
  const mimeType = (file as File).type || "application/octet-stream"
  const arrayBuffer = await (file as File).arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  let destinationFolderId = account.drive_folder_id
  if (typeof subfolderRaw === "string" && subfolderRaw.trim()) {
    try {
      // Allow nested 'A/B/C' by walking the chain.
      const parts = subfolderRaw.split("/").map((p) => p.trim()).filter(Boolean)
      for (const part of parts) {
        destinationFolderId = await ensureSubfolder(destinationFolderId, part)
      }
    } catch (err) {
      console.warn(
        `[upload-task-file] subfolder resolution failed for '${subfolderRaw}' under ${account.drive_folder_id}:`,
        err,
      )
      // Fall through to root drive_folder_id; the upload still succeeds.
    }
  }

  let upload: { id?: string; name?: string }
  try {
    upload = (await uploadBinaryToDrive(fileName, buffer, mimeType, destinationFolderId)) as {
      id?: string
      name?: string
    }
  } catch (err) {
    return json(
      {
        error: `Drive upload failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    )
  }
  if (!upload.id) {
    return json({ error: "Drive upload returned no file id" }, 500)
  }

  return json({
    file_id: upload.id,
    file_name: upload.name ?? fileName,
    mime_type: mimeType,
    drive_url: `https://drive.google.com/file/d/${upload.id}/view`,
  })
}
