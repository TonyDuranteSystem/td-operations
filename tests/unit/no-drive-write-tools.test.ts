/**
 * Stop Drive (dev job 264bb882): the MCP server and the AI assistants have NO Drive write TOOL any more.
 * Reads (search / list / info / read) and the CRM-storage tools stay.
 *
 * What this does NOT claim (and the test pins, so a doc can never say more than is true):
 *  - `storage_write` / `storage_move` still mirror their own bucket into My Drive (`syncToDrive` in storage.ts);
 *  - the review tools of formation / banking / closure / tax still call `saveFormToDrive` (guarded by guardDriveWrite).
 *    Moving those to storage is session S1d; this list may only SHRINK.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn(), storage: { from: vi.fn() } } }))

const ROOT = join(__dirname, '..', '..')
const WRITE_TOOL_NAMES = ['drive_upload', 'drive_upload_file', 'drive_create_folder', 'drive_move', 'drive_rename', 'drive_delete']
const DRIVE_WRITE_HELPERS = [
  'uploadFile', 'updateFileContent', 'renameFile', 'createFolder', 'moveFile', 'uploadBinaryToDrive',
  'uploadBinaryToDriveUpsert', 'updateBinaryFile', 'trashFile', 'findOrCreateYearFolder', 'createTaggedFolder',
  'patchTaggedItem', 'uploadStreamToDrive', 'createFolderMyDrive',
]

function registeredFiles(): string[] {
  const route = readFileSync(join(ROOT, 'app/api/[transport]/route.ts'), 'utf8')
  return Array.from(route.matchAll(/^import \{ (register\w+) \} from "@\/lib\/mcp\/tools\/([\w-]+)"/gm)).map(m => `${m[2]}:${m[1]}`)
}

describe('MCP server — no Drive write tools', () => {
  it('lists no Drive write tool and still lists the read + storage tools', async () => {
    const names: string[] = []
    const server = { tool: (name: string) => { names.push(name) } } as never
    for (const entry of registeredFiles()) {
      const [file, fn] = entry.split(':')
      const mod = await import(/* @vite-ignore */ `@/lib/mcp/tools/${file}`)
      mod[fn](server)
    }
    for (const w of WRITE_TOOL_NAMES) expect(names, w).not.toContain(w)
    expect(names).not.toContain('tax_send_to_accountant')
    for (const r of ['drive_search', 'drive_list_folder', 'drive_get_file_info', 'drive_read_file', 'storage_write', 'storage_move', 'storage_read', 'storage_list', 'my_files_save']) {
      expect(names, r).toContain(r)
    }
  }, 60_000)

  it('no MCP tool file (except the by-hand storage tools) calls a Drive write helper', () => {
    const dir = join(ROOT, 'lib/mcp/tools')
    const allowed = new Set(['storage.ts', 'my-files-drop.ts'])
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts') && !allowed.has(n))) {
      const src = readFileSync(join(dir, f), 'utf8')
      for (const h of DRIVE_WRITE_HELPERS) {
        expect(new RegExp(`\\b${h}\\b`).test(src), `${f} uses ${h}`).toBe(false)
      }
    }
  })
})

describe('what still touches Drive from MCP tools — pinned exactly (may only shrink)', () => {
  const dir = join(ROOT, 'lib/mcp/tools')
  const files = readdirSync(dir).filter(n => n.endsWith('.ts'))
  it('no NEW tool file calls saveFormToDrive: today it is a subset of these four, and moving them to storage only shrinks it', () => {
    const users = files.filter(f => /\bsaveFormToDrive\b/.test(readFileSync(join(dir, f), 'utf8'))).sort()
    const allowed = ['banking-form.ts', 'closure.ts', 'formation.ts', 'tax.ts']
    expect(users.filter(f => !allowed.includes(f)), `New saveFormToDrive callers: ${users.join(', ')}`).toEqual([])
  })
  it('only storage.ts mirrors into My Drive (syncToDrive)', () => {
    const users = files.filter(f => /\bsyncToDrive\b/.test(readFileSync(join(dir, f), 'utf8'))).sort()
    expect(users).toEqual(['storage.ts'])
  })
})

describe('AI assistants — no Drive write tools', () => {
  it('the assistant tool list has no Drive write tool and keeps the Drive read tools', async () => {
    const { AGENT_TOOLS } = await import('@/lib/ai-agent/tools')
    const names = AGENT_TOOLS.map(t => t.name)
    for (const w of WRITE_TOOL_NAMES) expect(names, w).not.toContain(w)
    for (const r of ['drive_search', 'drive_list_folder']) expect(names, r).toContain(r)
  })

  it('the approvable and worker lists name no Drive write tool', async () => {
    const { APPROVABLE_TOOL_NAMES } = await import('@/lib/ai-agent/approvable-tools')
    const { WORKER_READ_ONLY_TOOL_NAMES } = await import('@/lib/ai-agent/worker-tools')
    for (const w of WRITE_TOOL_NAMES) {
      expect(APPROVABLE_TOOL_NAMES.has(w), w).toBe(false)
      expect(WORKER_READ_ONLY_TOOL_NAMES.has(w), w).toBe(false)
    }
  })

  it('an old-shape gmail_get_attachments call saving to Drive returns an explicit error and saves/lists nothing', async () => {
    const { executeTool } = await import('@/lib/ai-agent/tools')
    for (const params of [{ message_id: 'm1', save_to_drive: true, drive_folder_id: 'f1' }, { message_id: 'm1', save_to_drive: true }, { message_id: 'm1', drive_folder_id: 'f1' }]) {
      const out = JSON.parse(await executeTool('gmail_get_attachments', params))
      expect(out.error).toMatch(/save_to_storage/)
      expect(out.attachments).toBeUndefined()
    }
  })

  it('gmail_get_attachments with save_to_storage but NO account_id is an explicit error, not a silent listing', async () => {
    const { executeTool } = await import('@/lib/ai-agent/tools')
    const out = JSON.parse(await executeTool('gmail_get_attachments', { message_id: 'm1', save_to_storage: true }))
    expect(out.error).toMatch(/account_id/)
    expect(out.attachments).toBeUndefined()
  })

  it('asking the assistant to move or upload a Drive file reaches no tool', async () => {
    const { executeTool } = await import('@/lib/ai-agent/tools')
    for (const name of ['drive_move', 'drive_upload_file']) {
      expect(JSON.parse(await executeTool(name, { file_id: 'f', target_folder_id: 't', file_name: 'x' })).error).toMatch(/Unknown tool/)
    }
  })

  it('the assistant prompt and tool texts do not tell the model it can save to Drive', async () => {
    const { SYSTEM_PROMPT } = await import('@/lib/ai-agent/system-prompt')
    const { AGENT_TOOLS } = await import('@/lib/ai-agent/tools')
    const texts = [SYSTEM_PROMPT, ...AGENT_TOOLS.map(t => `${t.description} ${JSON.stringify(t.parameters)}`)].join('\n')
    expect(texts).not.toMatch(/save[^.\n]{0,40}to (their |the )?(google )?drive/i)
    expect(texts).not.toMatch(/save_to_drive|drive_folder_id|gdrive_folder_url|drive_upload_file|drive_move/)
  })

  it('the assistant code calls no Drive write helper', () => {
    for (const f of ['tools.ts', 'worker-tools.ts', 'providers.ts']) {
      const src = readFileSync(join(ROOT, 'lib/ai-agent', f), 'utf8')
      for (const h of DRIVE_WRITE_HELPERS) {
        expect(new RegExp(`\\b${h}\\b`).test(src), `${f} uses ${h}`).toBe(false)
      }
    }
  })
})
