import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  upsertCompany,
  upsertContact,
  associateContactToCompany,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 min for large syncs

interface SyncResult {
  companiesSynced: number
  companiesFailed: number
  contactsSynced: number
  contactsFailed: number
  associationsCreated: number
  errors: string[]
}

export async function POST(req: NextRequest) {
  try {
    // Optional: limit to specific accounts
    const body = await req.json().catch(() => ({}))
    const { accountIds, dryRun } = body as {
      accountIds?: string[]
      dryRun?: boolean
    }

    // 1) Fetch active accounts from Supabase
    let query = supabaseAdmin
      .from("accounts")
      .select(
        "id, company_name, entity_type, ein_number, state_of_formation, formation_date, physical_address, status"
      )
      .eq("status", "Active")
      .order("company_name")

    if (accountIds?.length) {
      query = query.in("id", accountIds)
    }

    const { data: accounts, error: aErr } = await query
    if (aErr) throw aErr
    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ message: "No active accounts to sync" })
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        accountsToSync: accounts.length,
        accounts: accounts.map((a) => a.company_name),
      })
    }

    const result: SyncResult = {
      companiesSynced: 0,
      companiesFailed: 0,
      contactsSynced: 0,
      contactsFailed: 0,
      associationsCreated: 0,
      errors: [],
    }

    // Process sequentially — HubSpot free tier has 4 API calls/second limit
    // Each company = 1 search + 1 upsert + N contact ops, so we process one at a time with delays
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    for (const account of accounts) {
      try {
        // 2) Upsert company in HubSpot
        const companyId = await upsertCompany(account)
        result.companiesSynced++
        await delay(350) // respect rate limit

        // 3) Fetch contacts for this account
        const { data: junctions } = await supabaseAdmin
          .from("account_contacts")
          .select(
            "contact:contacts(id, full_name, first_name, last_name, email, email_2, phone, citizenship, itin_number, language)"
          )
          .eq("account_id", account.id)

        if (!junctions) continue

        for (const j of junctions) {
          const contact = j.contact as unknown as {
            id: string
            full_name: string
            first_name: string | null
            last_name: string | null
            email: string | null
            email_2: string | null
            phone: string | null
            citizenship: string | null
            itin_number: string | null
            language: string | null
          }

          if (!contact?.email) continue

          try {
            // 4) Upsert contact
            const contactId = await upsertContact(contact)
            if (contactId) {
              result.contactsSynced++
              await delay(350)

              // 5) Associate contact → company
              try {
                await associateContactToCompany(contactId, companyId)
                result.associationsCreated++
                await delay(200)
              } catch (assocErr) {
                // Non-fatal
                console.warn("Association error:", assocErr)
              }
            }
          } catch (cErr) {
            result.contactsFailed++
            result.errors.push(
              `Contact ${contact.full_name} (${contact.email}): ${cErr instanceof Error ? cErr.message : String(cErr)}`
            )
          }
        }
      } catch (err) {
        result.companiesFailed++
        result.errors.push(
          `Company ${account.company_name}: ${err instanceof Error ? err.message : String(err)}`
        )
        await delay(1000) // longer delay after error (might be rate limit)
      }
    }

    // Trim errors to keep response manageable
    if (result.errors.length > 50) {
      result.errors = [
        ...result.errors.slice(0, 50),
        `... and ${result.errors.length - 50} more errors`,
      ]
    }

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (error) {
    console.error("HubSpot sync error:", error)
    return NextResponse.json(
      { error: "Sync failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
