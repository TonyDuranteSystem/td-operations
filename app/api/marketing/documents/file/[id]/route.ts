export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { docsGate, docsError, json, isUuid } from "@/lib/marketing/documents-route"
import { readDoc, renameDoc, trashDoc, DocsError } from "@/lib/marketing/documents-server"
import { staffFileHeaders } from "@/lib/crm-store/serve"

/** GET — download the document (always as a download, never shown inside the site). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await docsGate(req, "read")
  if (g.res) return g.res
  if (!isUuid(params.id)) return docsError(new DocsError("That document was not found.", 404), "")
  try {
    const f = await readDoc(params.id)
    const h = staffFileHeaders(f.mimeType, f.name)
    return new NextResponse(new Uint8Array(f.bytes), { headers: { ...h, "Content-Disposition": h["Content-Disposition"].replace(/^inline/, "attachment") } })
  } catch (e) { return docsError(e, "That document could not be downloaded. Please try again.") }
}

/** PATCH { name } — rename. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  const b = await req.json().catch(() => ({})) as { name?: unknown }
  if (!isUuid(params.id) || typeof b.name !== "string" || !b.name.trim()) return docsError(new DocsError("Type a new name."), "")
  try { return json(await renameDoc(params.id, b.name, g.ctx.user.id)) } catch (e) { return docsError(e, "The document could not be renamed. Please try again.") }
}

/** DELETE — to the storage's trash (the Storage page can bring it back). */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  if (!isUuid(params.id)) return docsError(new DocsError("That document was not found.", 404), "")
  try { await trashDoc(params.id, g.ctx.user.id); return json({ ok: true }) } catch (e) { return docsError(e, "The document could not be deleted. Please try again.") }
}
