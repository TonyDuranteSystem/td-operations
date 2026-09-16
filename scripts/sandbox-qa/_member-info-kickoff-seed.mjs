import { config } from "dotenv"
config({ path: ".env.local" })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error("NOT SANDBOX — abort")
  process.exit(1)
}

// QA fixtures for live E2E verification of dev job ef529eaf (PR #497):
// the MMLLC member-info-kickoff fix. Two contacts, each with a real-shaped
// wizard_progress row (status='submitted') and a Company Formation SD sitting
// at "Filed with State" — i.e. name confirmed, ready for staff to click
// "Upload Articles of Organization" for real, exercising the actual shipped
// code path (advanceServiceDelivery -> materializeFormationCompany -> the new
// member-info kickoff step) rather than a simulated function call.
// Cleanup: _member-info-kickoff-cleanup.mjs

const { supabaseAdmin } = await import("../../lib/supabase-admin")
const stamp = Date.now()

async function makeContact({ label, first, last, email, language }) {
  const { data: contact, error } = await supabaseAdmin
    .from("contacts")
    .insert({
      first_name: first,
      last_name: last,
      full_name: `${first} ${last}`,
      email,
      language,
      phone: "5555550001",
    })
    .select("id")
    .single()
  if (error || !contact) throw new Error(`contact insert failed (${label}): ${error?.message}`)
  return contact.id
}

async function makeWizardAndSd({ label, contactId, entityType, llcName, members }) {
  const ownerData = {
    owner_first_name: "QA E2E",
    owner_last_name: `${label}Owner`,
    owner_email: `qa-e2e-${label.toLowerCase()}-owner-${stamp}@tdsandbox.test`,
    owner_phone: "5555550001",
    owner_dob: "1980-01-01",
    owner_nationality: "United States",
    owner_street: "123 Test St",
    owner_city: "Miami",
    owner_state_province: "FL",
    owner_zip: "33101",
    owner_country: "United States",
    owner_is_signer: true,
  }

  const memberData = {}
  members.forEach((m, i) => {
    memberData[`member_${i}_member_type`] = "individual"
    memberData[`member_${i}_member_first_name`] = m.first
    memberData[`member_${i}_member_last_name`] = m.last
    memberData[`member_${i}_member_email`] = m.email
    memberData[`member_${i}_member_ownership_pct`] = m.ownershipPct
    memberData[`member_${i}_member_dob`] = "1985-05-05"
    memberData[`member_${i}_member_nationality`] = "United States"
    memberData[`member_${i}_member_street`] = "456 Test Ave"
    memberData[`member_${i}_member_city`] = "Miami"
    memberData[`member_${i}_member_state_province`] = "FL"
    memberData[`member_${i}_member_zip`] = "33101"
    memberData[`member_${i}_member_country`] = "United States"
    memberData[`member_${i}_is_signer`] = false
  })

  const data = {
    ...ownerData,
    ...memberData,
    member_count: members.length,
    entity_type: entityType,
    llc_name_1: llcName,
    llc_name_2: `${llcName} Alt`,
    llc_name_3: `${llcName} Backup`,
    state_of_formation: "NM",
    business_purpose: "General consulting services for QA E2E testing.",
    disclaimer_accepted: true,
  }

  const { data: wp, error: wpErr } = await supabaseAdmin
    .from("wizard_progress")
    .insert({
      contact_id: contactId,
      wizard_type: "formation",
      current_step: 99,
      status: "submitted",
      data,
    })
    .select("id")
    .single()
  if (wpErr || !wp) throw new Error(`wizard_progress insert failed (${label}): ${wpErr?.message}`)

  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .insert({
      contact_id: contactId,
      service_type: "Company Formation",
      service_name: "Company Formation",
      service_type_entry_id: "580fbd2a-a112-4f19-9f22-dfbfc2192759",
      stage: "Filed with State",
      name_checks: [
        { name: llcName, source: "wizard", status: "filed", updated_at: new Date().toISOString() },
      ],
    })
    .select("id")
    .single()
  if (sdErr || !sd) throw new Error(`service_deliveries insert failed (${label}): ${sdErr?.message}`)

  return { wizardProgressId: wp.id, serviceDeliveryId: sd.id }
}

async function main() {
  const results = {}

  // Scenario A: clean Multi-Member LLC, English.
  const mmllcContactId = await makeContact({
    label: "MMLLC",
    first: "QA E2E",
    last: `MmllcOwner${stamp}`,
    email: `qa-e2e-mmllc-${stamp}@tdsandbox.test`,
    language: "English",
  })
  const mmllc = await makeWizardAndSd({
    label: "MMLLC",
    contactId: mmllcContactId,
    entityType: "MMLLC",
    llcName: `QA E2E MMLLC ${stamp} LLC`,
    members: [{ first: "QA E2E", last: "MemberTwo", email: `qa-e2e-mmllc-membertwo-${stamp}@tdsandbox.test`, ownershipPct: 50 }],
  })
  results.mmllc = { contactId: mmllcContactId, ...mmllc, llcName: `QA E2E MMLLC ${stamp} LLC` }

  // Scenario B: clean Single-Member LLC, English — must NOT get a member-info kickoff.
  const smllcContactId = await makeContact({
    label: "SMLLC",
    first: "QA E2E",
    last: `SmllcOwner${stamp}`,
    email: `qa-e2e-smllc-${stamp}@tdsandbox.test`,
    language: "English",
  })
  const smllc = await makeWizardAndSd({
    label: "SMLLC",
    contactId: smllcContactId,
    entityType: "SMLLC",
    llcName: `QA E2E SMLLC ${stamp} LLC`,
    members: [],
  })
  results.smllc = { contactId: smllcContactId, ...smllc, llcName: `QA E2E SMLLC ${stamp} LLC` }

  console.log(JSON.stringify(results, null, 2))
}

main()
