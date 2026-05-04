/**
 * Formation materialization — turn a contact's formation submission into a
 * real CRM company when the Articles of Organization arrive.
 *
 * Antonio's architectural model (2026-05-03/04):
 * Until the state has formed the LLC, there is no account. The contact carries
 * the wizard data, the service delivery, the contact-level Drive folder, and
 * the offer-signing invoice. This helper is invoked at the moment the
 * Articles of Organization land in Drive (Upload Articles button or the
 * detection cron) and:
 *
 *   1. Reads the latest completed formation_submissions for the contact.
 *   2. Reads wizard_progress.data.chosen_name_final for the picked LLC name.
 *   3. Idempotency: returns already_materialized if a real (non-Pending
 *      Formation, non-Cancelled) account is already linked to the contact.
 *   4. Creates the account (status='Active', account_type='Client',
 *      entity_type from submission, state_of_formation from submission state,
 *      formation_date / filing_id / registered_agent_id from caller params).
 *   5. Links the owner via account_contacts (Owner role).
 *   6. For MMLLC: materializes additional members — find-or-create contacts,
 *      account_contacts links (Member role), members rows, copies each
 *      member's passport from Supabase storage to Drive, document records.
 *   7. Writes the owner's members row (so SS-4 line 9a / responsible-party
 *      lookup works for MMLLC; harmless for SMLLC).
 *   8. Creates the company Drive folder and migrates the contact folder.
 *   9. Updates the active "Company Formation" SD: sets account_id + service_name.
 *  10. Syncs portal tier to 'formation' on the new account (cascades to
 *      contacts).
 *
 * What this helper does NOT do (deferred):
 *   - Fire ss4_create. SS-4 needs registered_agent_id with a county-set RA
 *     address; the helper records `ss4_pending` in the steps so admin can
 *     create the SS-4 next via the existing tool. Auto-fire is a future
 *     refinement that requires extracting the SS-4 logic out of the MCP layer.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { ensureCompanyFolder, migrateContactToCompany } from "@/lib/drive-folder-utils"
import { extractMembersFromWizardData } from "@/lib/utils/wizard-members"
import { syncTier } from "./sync-tier"
import { uploadBinaryToDrive } from "@/lib/google-drive"

const STATE_NAME_FROM_CODE: Record<string, string> = {
  NM: "New Mexico",
  WY: "Wyoming",
  FL: "Florida",
  DE: "Delaware",
}

export interface MaterializeFormationParams {
  contact_id: string
  /** ISO YYYY-MM-DD. Defaults to today if omitted. */
  formation_date?: string
  /** Secretary of State filing identifier, optional. */
  filing_id?: string
  /** FK to addresses.id. Optional — admin can link RA after materialization. */
  registered_agent_id?: string
  actor?: string
}

export type MaterializeStep = {
  step: string
  status: "ok" | "skipped" | "error"
  detail?: string
}

export interface MaterializeFormationResult {
  success: boolean
  outcome:
    | "materialized"
    | "already_materialized"
    | "missing_chosen_name"
    | "missing_submission"
    | "invalid_state"
    | "error"
  account_id?: string
  steps: MaterializeStep[]
  error?: string
}

const VALID_STATE_CODES = new Set(["NM", "WY", "FL", "DE"])

export async function materializeFormationCompany(
  params: MaterializeFormationParams,
): Promise<MaterializeFormationResult> {
  const steps: MaterializeStep[] = []
  const actor = params.actor || "system:formation-materialize"
  const today = new Date().toISOString().slice(0, 10)
  const formationDate = params.formation_date || today

  if (!params.contact_id) {
    return { success: false, outcome: "error", steps, error: "contact_id is required" }
  }

  // Member passports queued during the MMLLC loop and uploaded after the
  // company folder exists (we need the company's "2. Contacts" subfolder ID).
  const pendingMemberPassports: {
    contact_id: string
    contact_name: string
    storage_path: string
    index: number
  }[] = []

  try {
    // 1. Latest completed formation submission for this contact.
    const { data: sub } = await supabaseAdmin
      .from("formation_submissions")
      .select("id, submitted_data, upload_paths, state, entity_type")
      .eq("contact_id", params.contact_id)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!sub) {
      return {
        success: false,
        outcome: "missing_submission",
        steps,
        error: "No completed formation submission found for this contact.",
      }
    }
    steps.push({ step: "fetch_submission", status: "ok", detail: `submission ${sub.id}` })

    // 2. Wizard progress with the chosen name.
    const { data: wp } = await supabaseAdmin
      .from("wizard_progress")
      .select("id, data")
      .eq("contact_id", params.contact_id)
      .eq("wizard_type", "formation")
      .eq("status", "submitted")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    const wizardData = (wp?.data || {}) as Record<string, unknown>
    const chosenName = String(wizardData.chosen_name_final || wizardData.chosen_name || "").trim()
    if (!chosenName) {
      return {
        success: false,
        outcome: "missing_chosen_name",
        steps,
        error: "No chosen LLC name on wizard data. Use 'Confirm Selected Name' on the contact page first.",
      }
    }
    steps.push({ step: "fetch_chosen_name", status: "ok", detail: chosenName })

    // 3. Idempotency — if ANY non-cancelled account is already linked to this
    // contact, no-op. This intentionally skips legacy "Pending Formation"
    // placeholders too: per Antonio's rule, historic placeholders are LEFT
    // ALONE; the new materialization flow is for clients with no prior
    // account at all (which is what the post-PR1 flow produces).
    const { data: existingLinks } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id, accounts:account_id(id, company_name, status)")
      .eq("contact_id", params.contact_id)

    if (existingLinks && existingLinks.length > 0) {
      const activeLink = existingLinks.find(l => {
        const acc = l.accounts as unknown as { id: string; company_name: string; status: string } | null
        return acc && acc.status !== "Cancelled" && acc.status !== "Closed"
      })
      if (activeLink) {
        const acc = activeLink.accounts as unknown as { id: string; company_name: string; status: string }
        steps.push({
          step: "idempotency_check",
          status: "skipped",
          detail: `Account already linked: ${acc.company_name} (${acc.status}). Materialization skipped — legacy placeholders are left alone per the architectural rule.`,
        })
        return { success: true, outcome: "already_materialized", account_id: acc.id, steps }
      }
    }

    // 4. State + entity_type.
    const rawState = String(sub.state || "").toUpperCase().trim()
    if (!VALID_STATE_CODES.has(rawState)) {
      return {
        success: false,
        outcome: "invalid_state",
        steps,
        error: `Invalid or missing state in formation_submissions: "${sub.state}". Expected one of NM/WY/FL/DE.`,
      }
    }
    const stateName = STATE_NAME_FROM_CODE[rawState]

    const submitted = (sub.submitted_data || {}) as Record<string, unknown>
    const entityTypeFromSub = sub.entity_type as string | null
    const entityType: "Single Member LLC" | "Multi Member LLC" =
      entityTypeFromSub === "MMLLC" ? "Multi Member LLC" : "Single Member LLC"
    const isMMLC = entityType === "Multi Member LLC"

    // 5. Create the account.
    const accountInsert: Record<string, unknown> = {
      company_name: chosenName,
      entity_type: entityType,
      state_of_formation: stateName,
      formation_date: formationDate,
      filing_id: params.filing_id || null,
      status: "Active",
      account_type: "Client",
    }
    if (params.registered_agent_id) accountInsert.registered_agent_id = params.registered_agent_id

    // eslint-disable-next-line no-restricted-syntax -- materialization writes to accounts directly; central path
    const { data: newAccount, error: accErr } = await supabaseAdmin
      .from("accounts")
      .insert(accountInsert as never)
      .select("id")
      .single()

    if (accErr || !newAccount) {
      return {
        success: false,
        outcome: "error",
        steps,
        error: `Failed to create account: ${accErr?.message || "no data returned"}`,
      }
    }
    const accountId = newAccount.id
    steps.push({ step: "account_create", status: "ok", detail: `Account ${accountId} created (${chosenName}, ${entityType}, ${stateName})` })

    // 6. Link owner contact.
    await supabaseAdmin
      .from("account_contacts")
      .upsert(
        {
          account_id: accountId,
          contact_id: params.contact_id,
          role: "Owner",
        },
        { onConflict: "account_id,contact_id" },
      )
    steps.push({ step: "owner_link", status: "ok", detail: "Owner linked to account" })

    // 7. MMLLC additional members.
    let primaryMemberIndex = 0
    let additionalPctSum = 0
    if (isMMLC) {
      const additionalMembers = extractMembersFromWizardData(submitted)
      const uploadPaths: string[] = Array.isArray(sub.upload_paths) ? (sub.upload_paths as string[]) : []
      primaryMemberIndex = typeof submitted.primary_member_index === "number" ? submitted.primary_member_index as number : 0
      additionalPctSum = additionalMembers.reduce((sum, m) => sum + (m.member_ownership_pct ?? 0), 0)

      // Update owner is_primary on account_contacts based on picker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary not in generated types yet
      await supabaseAdmin.from("account_contacts")
        .update({ is_primary: primaryMemberIndex === 0 } as any)
        .eq("account_id", accountId)
        .eq("contact_id", params.contact_id)

      const now = new Date().toISOString()
      for (let i = 0; i < additionalMembers.length; i++) {
        const m = additionalMembers[i]
        const isPrimary = primaryMemberIndex === i + 1
        const ownershipPct = m.member_ownership_pct
        try {
          if (m.member_type === "company") {
            const repEmail = m.member_rep_email ? String(m.member_rep_email).toLowerCase().trim() : null
            const repName = m.member_rep_name ? String(m.member_rep_name).trim() : null
            const memberCompanyName = m.member_company_name ? String(m.member_company_name).trim() : `Company Member ${i + 1}`

            await supabaseAdmin.from("members").upsert(
              {
                account_id: accountId,
                member_type: "company",
                company_name: memberCompanyName,
                ein: m.member_company_ein ?? null,
                address_street: m.member_company_street ?? null,
                address_city: m.member_company_city ?? null,
                address_state: m.member_company_state ?? null,
                address_zip: m.member_company_zip ?? null,
                address_country: m.member_company_country ?? null,
                ownership_pct: ownershipPct,
                is_primary: false,
                is_signer: false,
                representative_name: repName,
                representative_email: repEmail,
                representative_address_street: m.member_rep_address_street ?? null,
                representative_address_city: m.member_rep_address_city ?? null,
                representative_address_state: m.member_rep_address_state ?? null,
                representative_address_zip: m.member_rep_address_zip ?? null,
                representative_address_country: m.member_rep_address_country ?? null,
                updated_at: now,
              },
              { onConflict: "account_id,company_name" },
            )

            // Find-or-create the representative contact for portal access.
            if (repEmail) {
              let repContactId: string | null = null
              const { data: existingRep } = await supabaseAdmin
                .from("contacts").select("id").eq("email", repEmail).limit(1).maybeSingle()
              if (existingRep) {
                repContactId = existingRep.id
              } else {
                // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-explicit-any -- deferred migration; central materialization path
                const { data: newRep } = await supabaseAdmin.from("contacts").insert({
                  email: repEmail,
                  full_name: repName ?? repEmail,
                  created_at: now,
                  updated_at: now,
                } as any).select("id").single()
                repContactId = newRep?.id ?? null
              }
              if (repContactId) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary not in types
                await supabaseAdmin.from("account_contacts").upsert(
                  {
                    account_id: accountId,
                    contact_id: repContactId,
                    role: "Member",
                    is_primary: false,
                    ...(ownershipPct !== null && { ownership_pct: ownershipPct }),
                  } as any,
                  { onConflict: "account_id,contact_id" },
                )
                steps.push({ step: `member_${i + 1}_link`, status: "ok", detail: `${memberCompanyName} (rep: ${repName ?? repEmail})` })
              } else {
                steps.push({ step: `member_${i + 1}_link`, status: "skipped", detail: `${memberCompanyName} — could not create representative contact` })
              }
            } else {
              steps.push({ step: `member_${i + 1}_link`, status: "ok", detail: `${memberCompanyName} (no representative email)` })
            }
          } else {
            // Individual member.
            const memberEmail = m.member_email ? String(m.member_email).toLowerCase().trim() : null
            const memberName = [m.member_first_name, m.member_last_name].filter(Boolean).join(" ") || memberEmail || `Member ${i + 1}`

            let membContactId: string | null = null
            if (memberEmail) {
              const { data: existingC } = await supabaseAdmin
                .from("contacts").select("id").eq("email", memberEmail).limit(1).maybeSingle()
              if (existingC) {
                membContactId = existingC.id
              } else {
                // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-explicit-any -- deferred migration; central materialization path
                const { data: newC } = await supabaseAdmin.from("contacts").insert({
                  email: memberEmail,
                  full_name: memberName,
                  first_name: m.member_first_name ?? undefined,
                  last_name: m.member_last_name ?? undefined,
                  created_at: now,
                  updated_at: now,
                } as any).select("id").single()
                membContactId = newC?.id ?? null
              }
            }

            if (membContactId) {
              const upd: Record<string, unknown> = { updated_at: now }
              if (m.member_first_name) upd.first_name = m.member_first_name
              if (m.member_last_name) upd.last_name = m.member_last_name
              if (m.member_dob) upd.date_of_birth = m.member_dob
              if (m.member_nationality) upd.citizenship = m.member_nationality
              if (m.member_street) upd.address_line1 = m.member_street
              if (m.member_city) upd.address_city = m.member_city
              if (m.member_state_province) upd.address_state = m.member_state_province
              if (m.member_zip) upd.address_zip = m.member_zip
              if (m.member_country) upd.address_country = m.member_country
              // eslint-disable-next-line no-restricted-syntax -- deferred migration; central materialization path
              await supabaseAdmin.from("contacts").update(upd).eq("id", membContactId)

              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary not in types
              await supabaseAdmin.from("account_contacts").upsert(
                {
                  account_id: accountId,
                  contact_id: membContactId,
                  role: "Member",
                  is_primary: isPrimary,
                  ...(ownershipPct !== null && { ownership_pct: ownershipPct }),
                } as any,
                { onConflict: "account_id,contact_id" },
              )

              await supabaseAdmin.from("members").upsert(
                {
                  account_id: accountId,
                  member_type: "individual",
                  full_name: memberName,
                  email: memberEmail,
                  address_street: m.member_street ?? null,
                  address_city: m.member_city ?? null,
                  address_state: m.member_state_province ?? null,
                  address_zip: m.member_zip ?? null,
                  address_country: m.member_country ?? null,
                  ownership_pct: ownershipPct,
                  is_primary: isPrimary,
                  is_signer: false,
                  contact_id: membContactId,
                  updated_at: now,
                },
                { onConflict: "account_id,contact_id" },
              )

              steps.push({ step: `member_${i + 1}_link`, status: "ok", detail: `${memberName}${isPrimary ? " [PRIMARY]" : ""}` })

              // Copy member passport from Supabase storage to Drive (we'll add to
              // the company folder after we create it; for now, just queue the
              // path for the post-folder upload).
              const passportPath = uploadPaths.find(p => p.includes(`passport_member_${i}`))
              if (passportPath && membContactId) {
                pendingMemberPassports.push({
                  contact_id: membContactId,
                  contact_name: memberName,
                  storage_path: passportPath,
                  index: i + 1,
                })
              }
            } else {
              steps.push({ step: `member_${i + 1}_link`, status: "skipped", detail: "No email — cannot create/find contact" })
            }
          }
        } catch (membErr) {
          steps.push({ step: `member_${i + 1}`, status: "error", detail: membErr instanceof Error ? membErr.message : String(membErr) })
        }
      }
    }

    // 8. Owner members row (for MMLLC SS-4 lookup; harmless duplicate-safe for SMLLC).
    if (isMMLC) {
      const ownerFirst = submitted.owner_first_name ? String(submitted.owner_first_name).trim() : ""
      const ownerLast = submitted.owner_last_name ? String(submitted.owner_last_name).trim() : ""
      const ownerFullName = [ownerFirst, ownerLast].filter(Boolean).join(" ") || null
      const ownerEmail = submitted.owner_email ? String(submitted.owner_email).toLowerCase().trim() : null
      const ownerPct = Math.max(0, Math.round((100 - additionalPctSum) * 100) / 100)
      await supabaseAdmin.from("members").upsert(
        {
          account_id: accountId,
          member_type: "individual",
          full_name: ownerFullName,
          email: ownerEmail,
          address_street: submitted.owner_street ? String(submitted.owner_street) : null,
          address_city: submitted.owner_city ? String(submitted.owner_city) : null,
          address_state: submitted.owner_state_province ? String(submitted.owner_state_province) : null,
          address_zip: submitted.owner_zip ? String(submitted.owner_zip) : null,
          address_country: submitted.owner_country ? String(submitted.owner_country) : null,
          ownership_pct: ownerPct,
          is_primary: primaryMemberIndex === 0,
          is_signer: false,
          contact_id: params.contact_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id,contact_id" },
      )
      steps.push({ step: "owner_member_row", status: "ok", detail: `Owner member row (${ownerPct}%)` })
    }

    // 9. Drive folder + migration.
    const { data: ownerContact } = await supabaseAdmin
      .from("contacts")
      .select("first_name, last_name, gdrive_folder_url, drive_folder_id")
      .eq("id", params.contact_id)
      .single()
    const ownerName = ownerContact ? [ownerContact.first_name, ownerContact.last_name].filter(Boolean).join(" ") : ""

    let companyContactsSubfolderId: string | null = null
    try {
      const folderResult = await ensureCompanyFolder(accountId, chosenName, stateName, ownerName)
      companyContactsSubfolderId = folderResult.subfolders["2. Contacts"] ?? null
      steps.push({
        step: "drive_folder",
        status: "ok",
        detail: folderResult.created ? "Company Drive folder created" : "Company Drive folder already exists, linked",
      })

      const contactFolderId = ownerContact?.drive_folder_id || (() => {
        const u = ownerContact?.gdrive_folder_url
        if (!u) return null
        const m = u.match(/folders\/([a-zA-Z0-9_-]+)/)
        return m?.[1] ?? null
      })()
      if (contactFolderId && contactFolderId !== folderResult.folderId) {
        const migrationResult = await migrateContactToCompany(contactFolderId, folderResult.folderId, params.contact_id)
        steps.push({
          step: "drive_migration",
          status: migrationResult.errors.length > 0 ? "error" : "ok",
          detail: `${migrationResult.moved} file(s) migrated${migrationResult.errors.length > 0 ? `, ${migrationResult.errors.length} error(s)` : ""}`,
        })
      }
    } catch (driveErr) {
      steps.push({ step: "drive_folder", status: "error", detail: driveErr instanceof Error ? driveErr.message : String(driveErr) })
    }

    // 9b. Member passports (after company folder exists).
    if (companyContactsSubfolderId && pendingMemberPassports.length > 0) {
      for (const mp of pendingMemberPassports) {
        try {
          const cleanPath = mp.storage_path.replace(/^\/+/, "")
          const { data: blob, error: dlErr } = await supabaseAdmin.storage
            .from("onboarding-uploads")
            .download(cleanPath)
          if (dlErr || !blob) {
            steps.push({ step: `member_${mp.index}_passport`, status: "error", detail: dlErr?.message || "Download failed" })
            continue
          }
          const fileName = cleanPath.split("/").pop() || `passport_member_${mp.index}.pdf`
          const buffer = Buffer.from(await blob.arrayBuffer())
          const mimeType = blob.type || "application/octet-stream"
          const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, companyContactsSubfolderId) as { id: string }
          await supabaseAdmin.from("documents").insert({
            file_name: fileName,
            drive_file_id: driveFile.id,
            drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
            document_type_name: "Passport",
            category: 2,
            category_name: "Contacts",
            status: "classified",
            contact_id: mp.contact_id,
            account_id: accountId,
            portal_visible: true,
          })
          steps.push({ step: `member_${mp.index}_passport`, status: "ok", detail: `Uploaded ${fileName}` })
        } catch (e) {
          steps.push({ step: `member_${mp.index}_passport`, status: "error", detail: e instanceof Error ? e.message : String(e) })
        }
      }
    }

    // 10. Update SD: link to account + update service_name.
    // eslint-disable-next-line no-restricted-syntax -- materialization writes to service_deliveries directly; central path
    const { data: updatedSds } = await supabaseAdmin
      .from("service_deliveries")
      .update({
        account_id: accountId,
        service_name: `Company Formation - ${chosenName}`,
        updated_at: new Date().toISOString(),
      })
      .eq("contact_id", params.contact_id)
      .eq("service_type", "Company Formation")
      .eq("status", "active")
      .select("id")
    steps.push({
      step: "sd_link",
      status: "ok",
      detail: `${updatedSds?.length ?? 0} SD(s) linked to account`,
    })

    // 11. Sync portal tier.
    try {
      const tierResult = await syncTier({
        accountId,
        newTier: "formation",
        reason: "company materialized from Articles of Organization",
        actor,
      })
      steps.push({
        step: "tier_sync",
        status: tierResult.success ? "ok" : "error",
        detail: tierResult.success ? `${tierResult.previousTier ?? "lead"} → formation` : tierResult.error,
      })
    } catch (tierErr) {
      steps.push({ step: "tier_sync", status: "error", detail: tierErr instanceof Error ? tierErr.message : String(tierErr) })
    }

    // 12. SS-4 next-step indicator. ss4_create requires registered_agent_id
    // with a county-set address (lib/mcp/tools/ss4.ts:240). Auto-fire is a
    // future refinement — admin runs ss4_create from MCP after RA is set.
    steps.push({
      step: "ss4_pending",
      status: "skipped",
      detail: params.registered_agent_id
        ? "Run ss4_create on the new account to start the EIN application"
        : "Set Registered Agent first, then run ss4_create",
    })

    // 13. Audit log.
    await logAction({
      actor,
      action_type: "materialize_formation_company",
      table_name: "accounts",
      record_id: accountId,
      account_id: accountId,
      contact_id: params.contact_id,
      summary: `Formation company materialized: ${chosenName} (${entityType}, ${stateName})`,
      details: {
        formation_date: formationDate,
        filing_id: params.filing_id ?? null,
        registered_agent_id: params.registered_agent_id ?? null,
        steps: steps.map(s => ({ step: s.step, status: s.status, detail: s.detail })),
      },
    })

    return { success: true, outcome: "materialized", account_id: accountId, steps }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      steps,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
