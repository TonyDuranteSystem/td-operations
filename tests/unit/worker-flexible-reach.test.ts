import { describe, it, expect } from 'vitest'
import {
  executeWorkerTool,
  WORKER_TOOLS,
  FIND_TOOL_TOOL,
  USE_TOOL_TOOL,
} from '@/lib/ai-agent/worker-tools'

// Covers the gating + policy routing of the flexible action surface (find_tool /
// use_tool). The READ path (use_tool → bridge → Supabase) is exercised separately
// against sandbox; these cases are all DB-free (they return before any tool runs).
const ON = new Set(['find_tool', 'use_tool'])

describe('flexible action surface gating', () => {
  it('find_tool and use_tool are NOT in WORKER_TOOLS (Hermes never gets them, R108)', () => {
    const names = WORKER_TOOLS.map((t) => t.name)
    expect(names).not.toContain('find_tool')
    expect(names).not.toContain('use_tool')
    expect(FIND_TOOL_TOOL.name).toBe('find_tool')
    expect(USE_TOOL_TOOL.name).toBe('use_tool')
  })

  it('refuses both tools when full reach is not enabled (no availableNames)', async () => {
    expect(await executeWorkerTool('find_tool', { query: 'offer' })).toMatch(/not permitted/)
    expect(await executeWorkerTool('use_tool', { name: 'offer_list' })).toMatch(/not permitted/)
  })

  it('find_tool returns matches from the catalog when enabled', async () => {
    const out = await executeWorkerTool('find_tool', { query: 'offer' }, ON)
    expect(out).toMatch(/offer_/)
  })

  it('use_tool gates a data-changing tool to approval (never auto-runs it)', async () => {
    const out = await executeWorkerTool('use_tool', { name: 'crm_update_record', params: {} }, ON)
    expect(out).toMatch(/approval|🔒/)
    expect(out).not.toMatch(/not permitted/)
  })

  it('use_tool refuses a hard-blocked tool', async () => {
    expect(await executeWorkerTool('use_tool', { name: 'execute_sql', params: {} }, ON)).toMatch(/blocked/)
  })

  it('use_tool needs a tool name', async () => {
    expect(await executeWorkerTool('use_tool', {}, ON)).toMatch(/needs a tool/)
  })
})
