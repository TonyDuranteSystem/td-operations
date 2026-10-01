/**
 * POST /api/crm-store/mydrive/copy — copy ONE file from the owner's own Google Drive into a folder of the firm's own storage
 * (Business, or the owner's My files). Body: { driveFileId, ownerId, folderId }. Google Docs / Sheets / Slides become Word / Excel /
 * PowerPoint files. No document type, never shown to a client. Owners only; the Drive file is never changed.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

import { NextRequest, NextResponse } from "next/server"
import { mydriveGate } from "../_gate"
import { denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../browse/_auth"

export async function POST(req: NextRequest) {
  const g = await mydriveGate()
  if (g instanceof NextResponse) return g
  const { driveFileId, ownerId, folderId } = (await req.json().catch(() => ({}))) as Record<string, string | undefined>
  if (!driveFileId || !ownerId || !folderId) return NextResponse.json({ error: "Choose a file and a folder." }, { status: 400 })
  const noEnv = await denyUnlessStorePilotEnv({ ownerId, folderId })
  if (noEnv) return noEnv
  const noAccess = await denyUnlessAreaAccess({ ownerId, folderId })
  if (noAccess) return noAccess
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
    const { data: o } = await (supabaseAdmin as any).from("store_owners").select("kind").eq("id", ownerId).maybeSingle()
    const { isInternalOwnerKind } = await import("@/lib/crm-store/plain-drop")
    if (!isInternalOwnerKind(o?.kind)) return NextResponse.json({ error: "Google Drive files can only be copied into Business or My files." }, { status: 400 })

    const { getOwnerDriveFile, downloadOwnerDriveFile } = await import("@/lib/google-drive")
    const { planDriveEntry, MY_DRIVE_MAX_FILE_BYTES } = await import("@/lib/crm-store/my-drive")
    const meta = await getOwnerDriveFile(driveFileId)
    const plan = planDriveEntry(meta.mimeType, meta.name)
    if (plan.kind === "folder") return NextResponse.json({ error: "That is a folder, not a file." }, { status: 400 })
    if (plan.kind === "skip") return NextResponse.json({ outcome: "skipped", message: plan.why })
    if (meta.size != null && meta.size > MY_DRIVE_MAX_FILE_BYTES) return NextResponse.json({ outcome: "failed", message: `Too big to copy in one go (${Math.round(meta.size / 1048576)} MB; the most is ${MY_DRIVE_MAX_FILE_BYTES / 1048576} MB).` })
    const bytes = await downloadOwnerDriveFile(driveFileId, plan.kind === "export" ? plan.exportMime : undefined)
    if (bytes.length > MY_DRIVE_MAX_FILE_BYTES) return NextResponse.json({ outcome: "failed", message: `Too big to copy in one go (${Math.round(bytes.length / 1048576)} MB).` })

    const { STAFF_STORE_UPLOAD_PREFIX, staffUploadToStore } = await import("@/lib/crm-store/browse")
    const safe = plan.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120)
    const storagePath = `${STAFF_STORE_UPLOAD_PREFIX}${ownerId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`
    const mime = plan.kind === "export" ? plan.exportMime : meta.mimeType
    const { error: upErr } = await supabaseAdmin.storage.from("onboarding-uploads").upload(storagePath, bytes, { contentType: mime, upsert: false })
    if (upErr) return NextResponse.json({ outcome: "failed", message: `Could not stage the file (${upErr.message}).` })
    const r = await staffUploadToStore({ ownerId, folderId, storagePath, fileName: plan.name, mimeType: mime, documentType: null, actorId: g.actor })
    return NextResponse.json({ outcome: r.write === "unchanged" ? "unchanged" : "saved", write: r.write })
  } catch (e) {
    return NextResponse.json({ outcome: "failed", message: e instanceof Error ? e.message : "The file could not be copied." })
  }
}
