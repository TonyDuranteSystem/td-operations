export interface DevJob {
  id: string
  title: string
  type: string
  status: string
  priority: string
  channel: string | null
  milestones: unknown
  summary_plain: string | null
  description: string | null
  findings: string | null
  plan: string | null
  decisions: string | null
  blockers: string | null
  progress_log: string | null
  parent_task_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  knowledge_ref: string | null
  knowledge_status: string | null
}

/** One work-log entry, optionally tagged to the stage it happened in. */
export interface TrailEntry {
  date?: string
  action?: string
  result?: string
  stage?: string
}

export function parseProgressLog(raw: string | null): TrailEntry[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw)
    return Array.isArray(p) ? (p as TrailEntry[]) : []
  } catch {
    return []
  }
}
