/**
 * HubSpot API Helper
 * Uses REST API v3 with PAT authentication
 * Syncs CRM accounts + contacts from Supabase → HubSpot
 */

const HUBSPOT_API = "https://api.hubapi.com"

function getToken(): string {
  const pat = process.env.HUBSPOT_PAT
  if (!pat) throw new Error("HUBSPOT_PAT not configured")
  return pat
}

async function hubspotRequest(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
) {
  const token = getToken()
  const res = await fetch(`${HUBSPOT_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body && { body: JSON.stringify(body) }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `HubSpot ${res.status}: ${JSON.stringify(err)}`
    )
  }

  return res.json()
}

// ─── Company Sync ────────────────────────────────────

interface SupabaseAccount {
  id: string
  company_name: string
  entity_type: string | null
  ein_number: string | null
  state_of_formation: string | null
  formation_date: string | null
  physical_address: string | null
  status: string | null
}

export async function upsertCompany(account: SupabaseAccount): Promise<string> {
  // Search by company name first
  const searchResult = await hubspotRequest("POST", "/crm/v3/objects/companies/search", {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "name",
            operator: "EQ",
            value: account.company_name,
          },
        ],
      },
    ],
    properties: ["name", "ein_number"],
    limit: 1,
  })

  const properties: Record<string, string> = {
    name: account.company_name,
  }

  if (account.ein_number) properties.ein_number = account.ein_number
  if (account.state_of_formation) properties.state_of_formation = account.state_of_formation
  if (account.formation_date) properties.incorporation_date = account.formation_date
  if (account.physical_address) properties.business_address = account.physical_address
  if (account.entity_type) properties.industry = account.entity_type

  if (searchResult.total > 0) {
    // Update existing
    const companyId = searchResult.results[0].id
    await hubspotRequest("PATCH", `/crm/v3/objects/companies/${companyId}`, {
      properties,
    })
    return companyId
  } else {
    // Create new
    const result = await hubspotRequest("POST", "/crm/v3/objects/companies", {
      properties,
    })
    return result.id
  }
}

// ─── Contact Sync ────────────────────────────────────

interface SupabaseContact {
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

export async function upsertContact(contact: SupabaseContact): Promise<string | null> {
  if (!contact.email) return null // Can't create HubSpot contact without email

  // Search by email
  const searchResult = await hubspotRequest("POST", "/crm/v3/objects/contacts/search", {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "email",
            operator: "EQ",
            value: contact.email,
          },
        ],
      },
    ],
    properties: ["email", "firstname", "lastname"],
    limit: 1,
  })

  const properties: Record<string, string> = {
    email: contact.email,
  }

  if (contact.first_name) properties.firstname = contact.first_name
  if (contact.last_name) properties.lastname = contact.last_name
  if (contact.phone) properties.phone = contact.phone
  if (contact.citizenship) properties.citizenship = contact.citizenship
  if (contact.itin_number) properties.itin_number = contact.itin_number

  if (searchResult.total > 0) {
    // Update existing
    const contactId = searchResult.results[0].id
    await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${contactId}`, {
      properties,
    })
    return contactId
  } else {
    // Create new
    const result = await hubspotRequest("POST", "/crm/v3/objects/contacts", {
      properties,
    })
    return result.id
  }
}

// ─── Association ────────────────────────────────────

export async function associateContactToCompany(
  contactId: string,
  companyId: string
): Promise<void> {
  try {
    await hubspotRequest(
      "PUT",
      `/crm/v4/objects/contacts/${contactId}/associations/companies/${companyId}`,
      [
        {
          associationCategory: "HUBSPOT_DEFINED",
          associationTypeId: 1, // Contact → Company (primary)
        },
      ] as unknown as Record<string, unknown>
    )
  } catch (err) {
    // Association may already exist — that's OK
    console.warn(`Association warning (contact ${contactId} → company ${companyId}):`, err)
  }
}
