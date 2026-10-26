/**
 * Short payment address — /pay/s/<code> (TD Marketing). Finds the sale by the start of its id and sends the client to the Stripe page that was made for it.
 * Under /pay, which is already public (the client has no login). Nothing is created or changed here; a link that is paid, expired or unknown shows a plain page.
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { idRangeFor } from "@/lib/marketing/short-pay"
import { isExpiredLink } from "@/lib/marketing/sales"

export const dynamic = "force-dynamic"

const page = (title: string, text: string, status: number) =>
  new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>` +
    `<body style="font-family:Arial,Helvetica,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1e293b"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  )

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const range = idRangeFor(code)
  if (!range) return page("Link not found", "This payment link is not valid. Please ask the person who sent it for a new one.", 404)
  const { data } = await supabaseAdmin.from("marketing_sales").select("id, status, checkout_url, link_expires_at").gte("id", range.lo).lte("id", range.hi).limit(2)
  const rows = data ?? []
  if (rows.length !== 1) return page("Link not found", "This payment link is not valid. Please ask the person who sent it for a new one.", 404)
  const sale = rows[0]
  if (sale.status === "paid" || sale.status === "partly_refunded" || sale.status === "refunded") return page("Already paid", "This payment was already received. Thank you.", 200)
  if (sale.status !== "link_created" || !sale.checkout_url || isExpiredLink({ status: "link_created", link_expires_at: sale.link_expires_at ?? null })) {
    return page("This link has expired", "Payment links work for 23 hours. Please ask the person who sent it for a new one.", 410)
  }
  return NextResponse.redirect(sale.checkout_url, 302)
}
