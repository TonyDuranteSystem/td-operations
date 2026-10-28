export const dynamic = "force-dynamic"
export const maxDuration = 60
import { NextRequest } from "next/server"
import { docsGate, docsError, json, isUuid } from "@/lib/marketing/documents-route"
import { finishUpload, DocsError } from "@/lib/marketing/documents-server"

/** POST { folderId, path, fileName, mimeType, replaceFileId? } — the sent file becomes a document, or the next version of `replaceFileId`. */
export async function POST(req: NextRequest) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  const b = await req.json().catch(() => ({})) as { folderId?: unknown; path?: unknown; fileName?: unknown; mimeType?: unknown; replaceFileId?: unknown }
  if (!isUuid(b.folderId) || typeof b.path !== "string" || typeof b.fileName !== "string" || (b.replaceFileId != null && !isUuid(b.replaceFileId))) return docsError(new DocsError("Choose the file again."), "")
  try {
    return json(await finishUpload({ folderId: b.folderId, path: b.path, fileName: b.fileName, mimeType: typeof b.mimeType === "string" ? b.mimeType : null, replaceFileId: (b.replaceFileId as string | null | undefined) ?? null, actorId: g.ctx.user.id }))
  } catch (e) { return docsError(e, "The upload could not be saved. Please try again.") }
}
