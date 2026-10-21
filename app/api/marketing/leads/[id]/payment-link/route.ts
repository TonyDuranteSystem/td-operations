import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireMarketing } from "@/lib/marketing/guard"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { createSaleLink, saleMetadata, type CreateSession } from "@/lib/marketing/sales-server"
import { createMarketingCheckoutSession } from "@/lib/stripe-checkout"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

const body = z.object({
  kind: z.string().trim().min(1).max(40),
  amount: z.union([z.string().trim().min(1).max(20), z.number()]),
  currency: z.string().trim().length(3),
  note: z.string().max(300).nullish(),
  confirmed: z.boolean().optional(),
})

const liveSession: CreateSession = async p => createMarketingCheckoutSession({
  amountCents: p.amountCents, currency: p.currency, productName: p.kindLabel, clientEmail: p.email, metadata: saleMetadata(p),
})

/** POST /api/marketing/leads/[id]/payment-link — make a card payment link for this lead. The team comes from the guard; needs the payment-link permission. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing("payment_links.create")
  if (g.res) return g.res
  const parsed = body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "That request is not valid. Reload the page and try again." }, { status: 400, headers: NO_STORE })
  const { id } = await params
  const r = await createSaleLink(leadDb(), { teamId: g.ctx.team.id, userId: g.ctx.user.id, email: g.ctx.user.email }, id, { ...parsed.data, amount: parsed.data.amount ?? "" }, liveSession)
  if (r.ok === false) return NextResponse.json({ error: r.error, needsConfirm: r.needsConfirm === true }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, saleId: r.saleId, url: r.url }, { headers: NO_STORE })
}
