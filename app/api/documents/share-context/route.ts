/**
 * GET /api/documents/share-context?documentId=<documents.id> | ?accountId=<accounts.id>
 *
 * Who a chat message about a newly visible document may go to, for the staff "eye" pop-up on the contact page and the
 * account file manager (the storage browser has its own, keyed by store file: crm-store/browse/file/<id>/share-context).
 * Staff only (a portal client has a login too — this reads with the service role). Read-only.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const documentId = req.nextUrl.searchParams.get("documentId")
  const accountId = req.nextUrl.searchParams.get("accountId")
  if (!(documentId ? UUID_RE.test(documentId) : accountId ? UUID_RE.test(accountId) : false)) {
    return NextResponse.json({ error: "documentId or accountId (a valid id) is required" }, { status: 400 })
  }
  try {
    const m = await import("@/lib/portal/document-share-message")
    return NextResponse.json(documentId ? await m.getShareContextForDocument(documentId) : await m.getShareContextForAccount(accountId as string))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not work out who the message can go to." }, { status: 400 })
  }
}
