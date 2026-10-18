/**
 * Stop Drive (dev job 264bb882): neither the MCP server nor the AI assistants may be able to WRITE to Drive.
 * Reads (search / list / info / read) and the CRM-storage tools stay.
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
    for (const r of ['drive_search', 'drive_list_folder', 'drive_get_file_info', 'drive_read_file', 'storage_write', 'storage_move', 'storage_read', 'storage_list', 'my_files_save']) {
      expect(names, r).toContain(r)
    }
  })

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

  it('the assistant code calls no Drive write helper', () => {
    for (const f of ['tools.ts', 'worker-tools.ts', 'providers.ts']) {
      const src = readFileSync(join(ROOT, 'lib/ai-agent', f), 'utf8')
      for (const h of DRIVE_WRITE_HELPERS) {
        expect(new RegExp(`\\b${h}\\b`).test(src), `${f} uses ${h}`).toBe(false)
      }
    }
  })
})
