/**
 * TD Marketing — settings, teams and commission terms (server side; P0, dev job 9aec66fa).
 * Pure rules live in settings-schema.ts, commission.ts and team-status.ts. The database also keeps the history of every
 * settings change (trigger) and refuses to change or delete a commission term (trigger), so no code path can skip them.
 * Admin-only by the callers: this module trusts that the route already checked who is asking.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  MARKETING_SETTING_KEYS, defaultForSetting, failClosedValue, isMarketingSettingKey, parseSettingValue, resolveSetting, type MarketingSettingKey,
} from "@/lib/marketing/settings-schema"
import { canChangeTeamStatus, isTeamStatus, type TeamStatus } from "@/lib/marketing/team-status"
import type { CommissionTerm } from "@/lib/marketing/commission"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

export interface MarketingTeam {
  id: string
  name: string
  owner_user_id: string | null
  status: TeamStatus
  created_by: string | null
  created_at: string
  updated_at: string
}

export type Result<T> = { ok: boolean; error?: string; data?: T }
const fail = <T>(error: string): Result<T> => ({ ok: false, error })

// ── teams ────────────────────────────────────────────────────────────────

export async function createTeam(input: { name: string; ownerUserId?: string | null; actor: string }): Promise<Result<MarketingTeam>> {
  const name = (input.name ?? "").trim()
  if (!name) return fail("Give the team a name.")
  const { data, error } = await db()
    .from("marketing_teams")
    .insert({ name, owner_user_id: input.ownerUserId ?? null, status: "draft", created_by: input.actor })
    .select("*")
    .single()
  if (error) return fail(error.message)
  return { ok: true, data: data as MarketingTeam }
}

export async function getTeam(teamId: string): Promise<MarketingTeam | null> {
  const { data } = await db().from("marketing_teams").select("*").eq("id", teamId).maybeSingle()
  return (data as MarketingTeam | null) ?? null
}

export async function listTeams(): Promise<MarketingTeam[]> {
  const { data } = await db().from("marketing_teams").select("*").order("created_at", { ascending: true })
  return (data ?? []) as MarketingTeam[]
}

export async function setTeamStatus(teamId: string, to: TeamStatus, actor: string): Promise<Result<MarketingTeam>> {
  if (!isTeamStatus(to)) return fail("Unknown team status.")
  const team = await getTeam(teamId)
  if (!team) return fail("Team not found.")
  if (!canChangeTeamStatus(team.status, to)) return fail(`A team cannot go from ${team.status} to ${to}.`)
  const { data, error } = await db()
    .from("marketing_teams")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", teamId)
    .eq("status", team.status) // only if nobody changed it meanwhile
    .select("*")
    .maybeSingle()
  if (error) return fail(error.message)
  if (!data) return fail("The team changed while you were editing. Reload and try again.")
  console.warn(`[marketing] team ${teamId} ${team.status} -> ${to} by ${actor}`)
  return { ok: true, data: data as MarketingTeam }
}

// ── settings ─────────────────────────────────────────────────────────────

/** Value for a key: the team's own, else the program-wide one, else the built-in default. Invalid stored values fall back. */
export async function getMarketingSetting(key: MarketingSettingKey, teamId?: string | null): Promise<unknown> {
  const read = await db().from("marketing_settings").select("team_id, value").eq("key", key)
  if (read.error) {
    // The settings could not be read. For a setting that grants access that must mean "no access", not the built-in default.
    console.error(`[marketing] could not read setting ${key}: ${read.error.message}`)
    const closed = failClosedValue(key)
    if (closed !== undefined) return closed
  }
  const rows: { team_id: string | null; value: unknown }[] = read.data ?? []
  const own = teamId ? rows.find(r => r.team_id === teamId) : undefined
  const global = rows.find(r => r.team_id === null)
  return resolveSetting(key, (own ?? global)?.value).value
}

/**
 * The team's stored value for a key, READ STRICTLY: for a screen that changes a setting by reading it, editing it and writing it back. If the read fails, or a stored value exists but is
 * broken, it says so instead of handing back the built-in default (writing a change on top of a default would silently erase what was stored).
 */
export async function readMarketingSettingStrict(key: MarketingSettingKey, teamId: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const read = await db().from("marketing_settings").select("team_id, value").eq("key", key).eq("team_id", teamId)
  if (read.error) return { ok: false, error: read.error.message }
  const row = (read.data ?? [])[0] as { value: unknown } | undefined
  if (!row) return { ok: true, value: defaultForSetting(key) }
  const p = parseSettingValue(key, row.value)
  return p.ok === true ? { ok: true, value: p.value } : { ok: false, error: "The stored value is not valid." }
}

/** Every setting resolved for a team, for the Settings screen. */
export async function getAllMarketingSettings(teamId?: string | null): Promise<Record<string, unknown>> {
  const rows: { key: string; team_id: string | null; value: unknown }[] =
    (await db().from("marketing_settings").select("key, team_id, value")).data ?? []
  const out: Record<string, unknown> = {}
  for (const key of MARKETING_SETTING_KEYS) {
    const own = teamId ? rows.find(r => r.key === key && r.team_id === teamId) : undefined
    const global = rows.find(r => r.key === key && r.team_id === null)
    out[key] = resolveSetting(key, (own ?? global)?.value).value
  }
  return out
}

export async function setMarketingSetting(input: {
  key: string
  value: unknown
  actor: string
  teamId?: string | null
}): Promise<Result<unknown>> {
  if (!isMarketingSettingKey(input.key)) return fail(`Unknown setting "${input.key}".`)
  const parsed = parseSettingValue(input.key, input.value)
  if (parsed.ok === false) return fail(parsed.error)
  const teamId = input.teamId ?? null
  const existing = await db().from("marketing_settings").select("id").eq("key", input.key).filter("team_id", teamId === null ? "is" : "eq", teamId).maybeSingle()
  const now = new Date().toISOString()
  const write = existing.data?.id
    ? await db().from("marketing_settings").update({ value: parsed.value, updated_by: input.actor, updated_at: now }).eq("id", existing.data.id)
    : await db().from("marketing_settings").insert({ key: input.key, team_id: teamId, value: parsed.value, updated_by: input.actor })
  if (write.error) return fail(write.error.message)
  return { ok: true, data: parsed.value }
}

export async function getSettingHistory(key: string, limit = 50) {
  const { data } = await db().from("marketing_settings_history").select("*").eq("key", key).order("changed_at", { ascending: false }).limit(limit)
  return data ?? []
}

// ── commission terms (append-only) ───────────────────────────────────────

export async function listCommissionTerms(teamId: string): Promise<CommissionTerm[]> {
  const { data } = await db().from("marketing_commission_terms").select("*").eq("team_id", teamId).order("effective_from", { ascending: false })
  return ((data ?? []) as CommissionTerm[]).map(t => ({ ...t, seller_pct: Number(t.seller_pct), td_pct: Number(t.td_pct) }))
}

export async function addCommissionTerm(input: {
  teamId: string
  kind: string
  sellerPct: number
  basis?: "amount_paid" | "net_of_fees"
  personRef?: string
  payeeAccountId?: string | null
  effectiveFrom?: string
  actor: string
}): Promise<Result<CommissionTerm>> {
  const kinds = (await getMarketingSetting("sale_kinds", input.teamId)) as { key: string }[]
  if (!kinds.some(k => k.key === input.kind)) return fail(`"${input.kind}" is not a kind of sale in the settings.`)
  if (!(input.sellerPct >= 0 && input.sellerPct <= 100)) return fail("The seller's share must be between 0 and 100.")
  const basis = input.basis ?? "amount_paid"
  if (basis !== "amount_paid" && basis !== "net_of_fees") return fail("Unknown basis.")
  const effective = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date()
  if (Number.isNaN(effective.getTime())) return fail("That start date is not valid.")
  const { data, error } = await db()
    .from("marketing_commission_terms")
    .insert({
      team_id: input.teamId,
      person_ref: input.personRef?.trim() || "team",
      kind: input.kind,
      seller_pct: input.sellerPct,
      td_pct: Math.round((100 - input.sellerPct) * 100) / 100,
      basis,
      payee_account_id: input.payeeAccountId ?? null,
      effective_from: effective.toISOString(),
      set_by: input.actor,
    })
    .select("*")
    .single()
  if (error) return fail(error.message)
  return { ok: true, data: { ...(data as CommissionTerm), seller_pct: Number(data.seller_pct), td_pct: Number(data.td_pct) } }
}
