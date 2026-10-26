import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isAdmin, isOwnerOnly } from '@/lib/auth'
import { ContractTextError } from '@/lib/contracts/service-contract-texts'

/** The signed-in staff member (an admin), or the refusal to send back. */
export async function requireStaff(): Promise<{ user: User } | { res: NextResponse }> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isAdmin(user)) return { res: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }
  return { user }
}

/** An owner (Antonio, or a person added to the owner list) — the only people who may approve a contract. */
export async function requireOwner(): Promise<{ user: User } | { res: NextResponse }> {
  const staff = await requireStaff()
  if ('res' in staff) return staff
  if (!isOwnerOnly(staff.user)) return { res: NextResponse.json({ error: 'Only an owner can approve a contract.', code: 'NOT_OWNER' }, { status: 403 }) }
  return staff
}

const STATUS: Record<ContractTextError['code'], number> = {
  INVALID_WORDING: 422,
  NOT_FOUND: 404,
  BUILT_IN_CONTRACT: 409,
  DRAFT_EXISTS: 409,
  NOT_A_DRAFT: 409,
  DRAFT_CHANGED: 409,
  NO_APPROVER: 400,
  NOT_READY: 503,
  TYPE_IN_USE: 409,
  DB: 500,
}

/** Turn anything thrown into a JSON answer the screen can show as it is (R099: the real reason, in plain words). */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ContractTextError) {
    return NextResponse.json({ error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) }, { status: STATUS[e.code] })
  }
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
}

/** Who the audit columns record: the person's email (the screen shows it as a name). */
export const actorOf = (user: User) => ({ kind: 'ui' as const, userId: user.id })
export const whoOf = (user: User) => (user.email ?? user.id).toLowerCase()
