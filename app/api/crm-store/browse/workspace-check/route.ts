/**
 * POST /api/crm-store/browse/workspace-check — "is a workspace step waiting for this file?" (dev job e3215801). Read-only, staff only.
 * Body: { ownerId, folderId, documentType, personContactId? } -> { hits: WaitingWorkspaceStep[] }.
 * The Storage page asks it BEFORE a file is saved; a hit makes it show the pop-up (Open the workspace / Save in Storage only).
 * A check that cannot be completed answers 503 and the page saves nothing — it never lets the file through unchecked.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const ownerId = typeof body.ownerId === "string" ? body.ownerId : ""
  const folderId = typeof body.folderId === "string" && body.folderId ? body.folderId : null
  const documentType = typeof body.documentType === "string" && body.documentType ? body.documentType : null
  const personContactId = typeof body.personContactId === "string" && body.personContactId ? body.personContactId : null
  if (!ownerId) return NextResponse.json({ error: "Choose a folder first." }, { status: 400 })
  try {
    const { findWaitingWorkspaceSteps } = await import("@/lib/flows/storage-step-hints")
    const hits = await findWaitingWorkspaceSteps({ ownerId, folderId, documentType, personContactId })
    return NextResponse.json({ hits }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Could not check whether a workspace is waiting for this file — nothing was saved. Please try again." }, { status: 503 })
  }
}
