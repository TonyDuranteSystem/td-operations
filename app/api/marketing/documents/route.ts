export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { docsGate, docsError, json, isUuid } from "@/lib/marketing/documents-route"
import { listDocs, DocsError } from "@/lib/marketing/documents-server"

/** GET /api/marketing/documents?folder=<id> — the folders and files of the Marketing folder (or a folder inside it). */
export async function GET(req: NextRequest) {
  const g = await docsGate(req, "read")
  if (g.res) return g.res
  const folder = req.nextUrl.searchParams.get("folder")
  if (folder && !isUuid(folder)) return docsError(new DocsError("That folder was not found.", 404), "")
  try { return json(await listDocs(folder)) } catch (e) { return docsError(e, "The documents could not be loaded. Please try again.") }
}
