/**
 * POST /api/crm-store/browse/upload — a staff upload into a NEW-store folder (company page / Storage tab).
 * Body: { ownerId, folderId, storagePath (onboarding-uploads), fileName, mimeType, documentType }.
 * Saves into the store + the CRM documents row (hidden from the client until staff share it).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../_auth"

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const { ownerId, folderId, storagePath, fileName, mimeType, documentType, personContactId, displayName, viaCompanyOwnerId } = body as Record<string, string | undefined>
  const visible = (body as { visible?: unknown }).visible === false ? false : true
  const extra = body as { periodYear?: unknown; filingAnswer?: unknown; needsReview?: unknown }
  const periodYear = typeof extra.periodYear === "number" && Number.isInteger(extra.periodYear) && extra.periodYear >= 1990 && extra.periodYear <= 2100 ? extra.periodYear : null
  const filingAnswer = extra.filingAnswer === "filed" || extra.filingAnswer === "draft" ? extra.filingAnswer : null
  const needsReview = typeof extra.needsReview === "string" && extra.needsReview.trim() ? extra.needsReview.trim().slice(0, 200) : null
  if (!ownerId || !folderId || !storagePath || !fileName) {
    return NextResponse.json({ error: "Choose a folder and a file." }, { status: 400 })
  }
  if (!documentType) {
    // only the firm's own areas (Business, My files) take a file without a document type; client storage needs one
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
    const { data: o } = await (supabaseAdmin as any).from("store_owners").select("kind").eq("id", ownerId).maybeSingle()
    const { isInternalOwnerKind } = await import("@/lib/crm-store/plain-drop")
    if (!isInternalOwnerKind(o?.kind)) return NextResponse.json({ error: "Choose a folder, a file and its document type." }, { status: 400 })
  }
  const noEnv = await denyUnlessStorePilotEnv({ ownerId, folderId })        // the pilot, or the firm's own areas anywhere
  if (noEnv) return noEnv
  const noAccess = (await denyUnlessAreaAccess({ ownerId, folderId })) ?? (viaCompanyOwnerId ? await denyUnlessAreaAccess({ ownerId: viaCompanyOwnerId }) : null)
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { staffUploadToStore } = await import("@/lib/crm-store/browse")
    const r = await staffUploadToStore({ ownerId, folderId, storagePath, fileName, mimeType: mimeType ?? null, documentType: documentType ?? null, actorId: user?.id ?? null, personContactId: personContactId ?? null, displayName: displayName ?? null, visible, periodYear, filingAnswer, needsReview, viaCompanyOwnerId: viaCompanyOwnerId ?? null })
    return NextResponse.json(r)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The upload could not be saved." }, { status: 400 })
  }
}
