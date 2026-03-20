/**
 * Agent Decision Memory — Helper functions
 *
 * Stores AI agent decisions that Antonio approves/rejects.
 * This becomes the AI's "brain" — learning from past decisions.
 *
 * Table: agent_decisions (see SQL in docs)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

export interface AgentDecision {
  id: string
  situation: string
  action_taken: string
  tools_used: string[] | null
  account_id: string | null
  contact_id: string | null
  task_id: string | null
  approved: boolean | null
  approved_by: string | null
  outcome: string | null
  created_at: string
}

interface CreateDecisionInput {
  situation: string
  action_taken: string
  tools_used?: string[]
  account_id?: string
  contact_id?: string
  task_id?: string
}

/**
 * Insert a new pending decision (approved = null).
 */
export async function createDecision(input: CreateDecisionInput): Promise<AgentDecision> {
  const { data, error } = await supabaseAdmin
    .from('agent_decisions')
    .insert({
      situation: input.situation,
      action_taken: input.action_taken,
      tools_used: input.tools_used ?? null,
      account_id: input.account_id ?? null,
      contact_id: input.contact_id ?? null,
      task_id: input.task_id ?? null,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create decision: ${error.message}`)
  return data as AgentDecision
}

/**
 * Mark a decision as approved.
 */
export async function approveDecision(
  id: string,
  approvedBy: string = 'admin'
): Promise<AgentDecision> {
  const { data, error } = await supabaseAdmin
    .from('agent_decisions')
    .update({ approved: true, approved_by: approvedBy })
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(`Failed to approve decision: ${error.message}`)
  return data as AgentDecision
}

/**
 * Mark a decision as rejected.
 */
export async function rejectDecision(
  id: string,
  approvedBy: string = 'admin'
): Promise<AgentDecision> {
  const { data, error } = await supabaseAdmin
    .from('agent_decisions')
    .update({ approved: false, approved_by: approvedBy })
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(`Failed to reject decision: ${error.message}`)
  return data as AgentDecision
}

/**
 * Search past approved decisions by keyword similarity (ILIKE on situation text).
 * Returns up to `limit` most recent matches.
 */
export async function findSimilarDecisions(
  situation: string,
  limit: number = 5
): Promise<AgentDecision[]> {
  // Extract significant keywords (3+ chars, skip common words)
  const stopWords = new Set([
    'the', 'and', 'for', 'from', 'with', 'that', 'this', 'has', 'was', 'are',
    'new', 'email', 'task', 'mark', 'suggest',
  ])
  const keywords = situation
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w))
    .slice(0, 5) // limit to 5 keywords

  if (keywords.length === 0) return []

  // Build OR condition: situation ILIKE any keyword
  const conditions = keywords.map(kw => `situation.ilike.%${kw}%`)

  const { data, error } = await supabaseAdmin
    .from('agent_decisions')
    .select()
    .eq('approved', true)
    .or(conditions.join(','))
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error(`Failed to search decisions: ${error.message}`)
  return (data ?? []) as AgentDecision[]
}
