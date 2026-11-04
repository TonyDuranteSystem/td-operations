/**
 * POST /api/storage-app/edit — a Mac renames, moves or trashes something that already exists (dev job 1992a087, 2026-11-03). Body:
 * { kind: "file" | "folder", id, action: "rename" | "move" | "trash", name?, toParentId? }. The CRM's own rules apply (fixed folders, taken names, locked
 * files are refused in plain words); Business and My files only; a trash goes to the CRM trash and can be restored. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { json, withDevice } from "@/lib/storage-app/guard"
import { editFromMac } from "@/lib/storage-app/edit"

export async function POST(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const r = await editFromMac({ user, deviceId, kind: body.kind, id: body.id, action: body.action, name: body.name, toParentId: body.toParentId })
    return json(r.body, r.status)
  })
}
