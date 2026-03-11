import { createClient } from "@supabase/supabase-js"
import fs from "fs"
import path from "path"

// Load .env.local
const envPath = path.join(process.cwd(), ".env.local")
const envContent = fs.readFileSync(envPath, "utf-8")
const envVars: Record<string, string> = {}
for (const line of envContent.split("\n")) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (match) envVars[match[1]] = match[2].replace(/^["']|["']$/g, "")
}
Object.assign(process.env, envVars)

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
)

const realm = "13845050572680403"

async function run() {
  const { data: tokenRow } = await sb.from("qb_tokens").select("*").limit(1).single()
  if (!tokenRow) throw new Error("No QB token found")

  const base = `https://quickbooks.api.intuit.com/v3/company/${realm}`
  const headers = {
    Authorization: `Bearer ${tokenRow.access_token}`,
    Accept: "application/json",
  }

  // 1. Get all open invoices
  const query = `SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 200`
  const url = `${base}/query?query=${encodeURIComponent(query)}&minorversion=73`
  const res = await fetch(url, { headers })
  const data = await res.json()
  const invoices = data.QueryResponse?.Invoice || []

  // 2. Get unique customers
  const customerMap = new Map<string, { name: string; invoices: any[]; qbEmail: string | null }>()
  for (const inv of invoices) {
    const custId = inv.CustomerRef?.value
    const custName = inv.CustomerRef?.name
    if (!customerMap.has(custId)) {
      customerMap.set(custId, { name: custName, invoices: [], qbEmail: null })
    }
    customerMap.get(custId)!.invoices.push(inv)
  }

  console.log(`=== ${invoices.length} open invoices across ${customerMap.size} unique customers ===\n`)

  // 3. Get QB customer details (check if they already have email)
  const custIds = Array.from(customerMap.keys())
  const custQuery = `SELECT * FROM Customer WHERE Id IN ('${custIds.join("','")}') MAXRESULTS 200`
  const custRes = await fetch(`${base}/query?query=${encodeURIComponent(custQuery)}&minorversion=73`, { headers })
  const custData = await custRes.json()
  const qbCustomers = custData.QueryResponse?.Customer || []

  for (const cust of qbCustomers) {
    const entry = customerMap.get(cust.Id)
    if (entry) {
      entry.qbEmail = cust.PrimaryEmailAddr?.Address || null
    }
  }

  // 4. Get ALL CRM accounts with qb_customer_id
  const { data: accounts } = await sb
    .from("accounts")
    .select("id, company_name, qb_customer_id")
    .not("qb_customer_id", "is", null)

  // 5. Get ALL CRM contacts with emails (via account_contacts join)
  const { data: allContacts } = await sb
    .from("account_contacts")
    .select("account_id, contacts(id, full_name, email, email_2)")

  // Build account -> emails map
  const accountEmailMap = new Map<string, string[]>()
  for (const ac of (allContacts || [])) {
    const contact = (ac as any).contacts
    if (contact?.email) {
      const emails = accountEmailMap.get(ac.account_id) || []
      emails.push(contact.email)
      if (contact.email_2) emails.push(contact.email_2)
      accountEmailMap.set(ac.account_id, emails)
    }
  }

  // Build qb_customer_id -> emails map
  const qbIdToEmails = new Map<string, { accountName: string; emails: string[] }>()
  for (const acc of (accounts || [])) {
    const emails = accountEmailMap.get(acc.id) || []
    if (acc.qb_customer_id) {
      qbIdToEmails.set(acc.qb_customer_id, { accountName: acc.company_name, emails })
    }
  }

  // 6. Also try to match by company name for those without qb_customer_id
  const { data: allAccounts } = await sb
    .from("accounts")
    .select("id, company_name, qb_customer_id")

  const nameToAccount = new Map<string, string>()
  for (const acc of (allAccounts || [])) {
    nameToAccount.set(acc.company_name.toLowerCase().trim(), acc.id)
  }

  // 7. Match and report
  const results: { custId: string; custName: string; totalDue: number; invoiceCount: number; email: string | null; source: string; qbEmail: string | null }[] = []

  for (const [custId, entry] of Array.from(customerMap)) {
    const totalDue = entry.invoices.reduce((s: number, i: any) => s + i.Balance, 0)
    let email: string | null = null
    let source = "❌ NOT FOUND"

    // Try QB email first
    if (entry.qbEmail) {
      email = entry.qbEmail
      source = "QB (already set)"
    }

    // Try CRM by qb_customer_id
    if (!email) {
      const crmMatch = qbIdToEmails.get(custId)
      if (crmMatch && crmMatch.emails.length > 0) {
        email = crmMatch.emails[0]
        source = "CRM (qb_id match)"
      }
    }

    // Try CRM by name match
    if (!email) {
      const cleanName = entry.name.toLowerCase().trim()
      const accountId = nameToAccount.get(cleanName)
      if (accountId) {
        const emails = accountEmailMap.get(accountId) || []
        if (emails.length > 0) {
          email = emails[0]
          source = "CRM (name match)"
        } else {
          source = "⚠️ CRM found, NO email on contacts"
        }
      }
    }

    // Try partial name match (without LLC, EUR suffix, etc.)
    if (!email) {
      const baseName = entry.name.toLowerCase().replace(/\s*(llc|inc|ltd|s\.r\.l\.s|srl|\(eur\))\s*/gi, "").trim()
      for (const [accName, accId] of Array.from(nameToAccount)) {
        const accBase = accName.replace(/\s*(llc|inc|ltd|s\.r\.l\.s|srl)\s*/gi, "").trim()
        if (accBase === baseName) {
          const emails = accountEmailMap.get(accId) || []
          if (emails.length > 0) {
            email = emails[0]
            source = "CRM (fuzzy match)"
            break
          }
        }
      }
    }

    results.push({
      custId,
      custName: entry.name,
      totalDue,
      invoiceCount: entry.invoices.length,
      email,
      source,
      qbEmail: entry.qbEmail,
    })
  }

  // Sort: found emails first, then by amount
  results.sort((a, b) => {
    if (a.email && !b.email) return -1
    if (!a.email && b.email) return 1
    return b.totalDue - a.totalDue
  })

  let foundCount = 0
  let missingCount = 0
  let foundTotal = 0
  let missingTotal = 0

  console.log("=== CUSTOMERS WITH EMAIL FOUND ===")
  for (const r of results) {
    if (r.email) {
      foundCount++
      foundTotal += r.totalDue
      const needsUpdate = r.source !== "QB (already set)" ? " → NEEDS QB UPDATE" : ""
      console.log(`✅ ${r.custName} (QB#${r.custId}) | $${r.totalDue.toLocaleString()} | ${r.invoiceCount} inv | ${r.email} [${r.source}]${needsUpdate}`)
    }
  }

  console.log(`\n=== CUSTOMERS WITHOUT EMAIL ===`)
  for (const r of results) {
    if (!r.email) {
      missingCount++
      missingTotal += r.totalDue
      console.log(`❌ ${r.custName} (QB#${r.custId}) | $${r.totalDue.toLocaleString()} | ${r.invoiceCount} inv | ${r.source}`)
    }
  }

  console.log(`\n=== SUMMARY ===`)
  console.log(`Email found: ${foundCount} customers ($${foundTotal.toLocaleString()})`)
  console.log(`Email missing: ${missingCount} customers ($${missingTotal.toLocaleString()})`)
  console.log(`Total: ${results.length} customers ($${(foundTotal + missingTotal).toLocaleString()})`)

  // Output JSON for next step (QB update script)
  const toUpdate = results.filter(r => r.email && r.source !== "QB (already set)")
  fs.writeFileSync(
    path.join(process.cwd(), "scripts", "qb-email-updates.json"),
    JSON.stringify(toUpdate.map(r => ({ custId: r.custId, custName: r.custName, email: r.email })), null, 2)
  )
  console.log(`\nSaved ${toUpdate.length} customers to qb-email-updates.json for QB update`)
}

run().catch(e => console.error("FATAL:", e.message))
