export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { docsGate, docsError, json, isUuid } from "@/lib/marketing/documents-route"
import { makeFolder, trashFolderDoc, DocsError } from "@/lib/marketing/documents-server"

/** POST { parentId, name } — a new folder inside Marketing. DELETE { folderId } — a folder (and what is in it) to the storage's trash. */
export async function POST(req: NextRequest) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  const b = await req.json().catch(() => ({})) as { parentId?: unknown; name?: unknown }
  if (!isUuid(b.parentId) || typeof b.name !== "string") return docsError(new DocsError("Type a name for the folder."), "")
  try { return json(await makeFolder(b.parentId, b.name, g.ctx.user.id)) } catch (e) { return docsError(e, "The folder could not be made. Please try again.") }
}

export async function DELETE(req: NextRequest) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  const b = await req.json().catch(() => ({})) as { folderId?: unknown }
  if (!isUuid(b.folderId)) return docsError(new DocsError("That folder was not found.", 404), "")
  try { await trashFolderDoc(b.folderId, g.ctx.user.id); return json({ ok: true }) } catch (e) { return docsError(e, "The folder could not be deleted. Please try again.") }
}
