import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"

// Canonical KB article holding TD's Mercury ACH details.
// Content format: one "Field: Value" per line.
const MERCURY_ACH_KB_ID = "3769a9d0-ab29-4c59-84a7-690f8936e386"

interface BankDetails {
  beneficiary: string | null
  bank: string | null
  account: string | null
  routing: string | null
  type: string | null
}

function parseKbContent(content: string): BankDetails {
  const details: BankDetails = {
    beneficiary: null,
    bank: null,
    account: null,
    routing: null,
    type: null,
  }

  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^([A-Za-z ]+):\s*(.+)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    const value = match[2].trim()
    if (key === "beneficiary") details.beneficiary = value
    else if (key === "bank") details.bank = value
    else if (key === "account") details.account = value
    else if (key === "routing") details.routing = value
    else if (key === "type") details.type = value
  }

  return details
}

/**
 * GET /api/workflows/td-bank-details
 *
 * Returns the current TD LLC banking details (Mercury ACH) for display in the
 * client portal Pay modal. Sourced from knowledge_articles so details can be
 * updated via kb_update without code changes or redeploys.
 *
 * Response: { method: 'ach', details: { beneficiary, bank, account, routing, type } }
 *
 * Auth: public (under /api/workflows/ per middleware.ts PUBLIC_PREFIXES). The
 * fields returned are the same details TD prints on paper invoices, so they
 * are not treated as sensitive.
 */
export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: article, error } = await supabase
      .from("knowledge_articles")
      .select("content")
      .eq("id", MERCURY_ACH_KB_ID)
      .single()

    if (error || !article?.content) {
      return NextResponse.json(
        { error: "Bank details KB article not found" },
        { status: 500 }
      )
    }

    const details = parseKbContent(article.content)

    // Minimum required fields to render the tile
    if (!details.beneficiary || !details.account || !details.routing) {
      return NextResponse.json(
        { error: "Bank details KB article is missing required fields" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      method: "ach",
      details,
    })
  } catch (err) {
    console.error("[td-bank-details] Error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    )
  }
}
