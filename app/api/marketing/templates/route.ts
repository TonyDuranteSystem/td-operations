import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireMarketing } from "@/lib/marketing/guard"
import { getMarketingSetting, readMarketingSettingStrict, setMarketingSetting } from "@/lib/marketing/settings"
import { applyTemplateEdit } from "@/lib/marketing/templates-edit"
import type { TeamTemplates } from "@/lib/marketing/templates"

const NO_STORE = { "Cache-Control": "no-store" }
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), key: z.string().regex(/^[a-z0-9_]{1,60}$/).optional(), label: z.string().max(200).optional(), it: z.string().max(4000).optional(), en: z.string().max(4000).optional() }),
  z.object({ action: z.literal("reset"), key: z.string().regex(/^[a-z0-9_]{1,60}$/) }),
  z.object({ action: z.literal("delete"), key: z.string().regex(/^[a-z0-9_]{1,60}$/) }),
])

/**
 * POST /api/marketing/templates — save / reset / delete a message template. ONLY the team owner (Antonio acting under "View as" is the owner too); everyone else may only USE the templates.
 * The team comes from the guard, never from the request.
 */
export async function POST(req: NextRequest) {
  const g = await requireMarketing()
  if (g.res) return g.res
  if (g.ctx.role !== "owner") return NextResponse.json({ error: "Only the team owner can create or change templates.", code: "NO_PERMISSION" }, { status: 403, headers: NO_STORE })
  const parsed = body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some(i => i.code === "too_big")
    return NextResponse.json({ error: tooLong ? "That text is too long (at most 4000 characters)." : "That request is not valid. Reload the page and try again." }, { status: 400, headers: NO_STORE })
  }
  const teamId = g.ctx.team.id
  // read STRICTLY: a change is written on top of what is stored, so a failed read (or a broken stored value) must stop here rather than be treated as "no templates" and erase them all
  const stored = await readMarketingSettingStrict("team_templates", teamId)
  if (stored.ok === false) return NextResponse.json({ error: "Could not read the saved templates, so nothing was changed. Please try again." }, { status: 503, headers: NO_STORE })
  const r = applyTemplateEdit(stored.value as TeamTemplates, parsed.data)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  const saved = await setMarketingSetting({ key: "team_templates", value: r.value, teamId, actor: g.ctx.user.email ?? g.ctx.user.id })
  if (saved.ok === false) return NextResponse.json({ error: "Could not save. Please try again." }, { status: 500, headers: NO_STORE })
  // "Reset to original" also clears an older single-text override of the same template, or the old wording would keep applying
  if (parsed.data.action === "reset") {
    const legacy = (await getMarketingSetting("message_templates", teamId)) as Record<string, string>
    if (legacy && parsed.data.key in legacy) {
      const rest = { ...legacy }
      delete rest[parsed.data.key]
      await setMarketingSetting({ key: "message_templates", value: rest, teamId, actor: g.ctx.user.email ?? g.ctx.user.id })
    }
  }
  return NextResponse.json({ ok: true, key: r.key }, { headers: NO_STORE })
}
