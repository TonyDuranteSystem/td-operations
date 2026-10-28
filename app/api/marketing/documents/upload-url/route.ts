export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { docsGate, docsError, json, isUuid } from "@/lib/marketing/documents-route"
import { startUpload, DocsError } from "@/lib/marketing/documents-server"

/** POST { folderId, fileName, size } — a signed link to send the file straight to storage. */
export async function POST(req: NextRequest) {
  const g = await docsGate(req, "manage")
  if (g.res) return g.res
  const b = await req.json().catch(() => ({})) as { folderId?: unknown; fileName?: unknown; size?: unknown }
  if (!isUuid(b.folderId) || typeof b.fileName !== "string" || typeof b.size !== "number") return docsError(new DocsError("Choose a file."), "")
  try { return json(await startUpload(b.folderId, b.fileName, b.size)) } catch (e) { return docsError(e, "Could not start the upload. Please try again.") }
}
