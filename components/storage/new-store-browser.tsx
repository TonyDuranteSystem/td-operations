'use client'

/**
 * Read-only browser of the NEW CRM store (job 685467b5) — Storage page → "New storage".
 * Owners (companies / people / companies being formed) → folders → files. Each file opens; badges say
 * whether the client can see it, whether it is staff-only or personal, whether it is in the trash, and
 * how many versions it has. View only: no upload / rename / move / delete (Stage-1 screens).
 */

import { useCallback, useEffect, useState } from 'react'
import { Building2, User, Hammer, Folder, FileText, ChevronRight, Eye, EyeOff, Lock, Trash2, Layers } from 'lucide-react'

interface Owner { id: string; kind: 'company' | 'person' | 'formation' | 'unfiled'; label: string; status: string | null; fileCount: number }
interface Fold { id: string; name: string; kind: string; trashed: boolean }
interface File_ {
  id: string; name: string; documentType: string | null; state: string; published: boolean; clientVisible: boolean
  staffOnly: boolean; personal: boolean; versions: number; size: number | null; mimeType: string | null; updatedAt: string
}
interface Contents { folder: Fold | null; path: Fold[]; folders: Fold[]; files: File_[] }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not load the new storage — please try again.')
  return data as T
}

const ownerIcon = (k: Owner['kind']) => (k === 'company' ? Building2 : k === 'person' ? User : k === 'formation' ? Hammer : Folder)

function Badge({ tone, children }: { tone: 'green' | 'gray' | 'amber' | 'red' | 'blue'; children: React.ReactNode }) {
  const t = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    gray: 'bg-zinc-50 text-zinc-600 border-zinc-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
  }[tone]
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${t}`}>{children}</span>
}

export function NewStoreBrowser() {
  const [owners, setOwners] = useState<Owner[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [contents, setContents] = useState<Contents | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    getJson<{ owners: Owner[] }>('/api/crm-store/browse/owners')
      .then((d) => setOwners(d.owners))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the new storage.'))
  }, [])

  const open = useCallback(async (oid: string, folderId: string | null) => {
    setOwnerId(oid)
    setError(null)
    try {
      const q = `/api/crm-store/browse/folder?owner=${encodeURIComponent(oid)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`
      setContents(await getJson<Contents>(q))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the folder.')
    }
  }, [])

  const shown = (owners ?? []).filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
      <div className="rounded-xl border border-zinc-200 bg-white p-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search companies and people…"
          className="mb-2 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
        />
        {owners === null && !error && <p className="p-2 text-sm text-zinc-500">Loading…</p>}
        {owners !== null && shown.length === 0 && <p className="p-2 text-sm text-zinc-500">Nothing in the new storage yet.</p>}
        <ul className="max-h-[70vh] space-y-0.5 overflow-y-auto">
          {shown.map((o) => {
            const Icon = ownerIcon(o.kind)
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => open(o.id, null)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-50 ${ownerId === o.id ? 'bg-zinc-100' : ''}`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.status && <Badge tone={o.status === 'archived' ? 'gray' : 'amber'}>{o.status}</Badge>}
                  <span className="text-xs text-zinc-400">{o.fileCount}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!contents && !error && <p className="text-sm text-zinc-500">Pick a company or person on the left to see its folders and files.</p>}
        {contents && !contents.folder && <p className="text-sm text-zinc-500">This owner has no folders yet.</p>}
        {contents?.folder && ownerId && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
              {contents.path.map((p, i) => (
                <span key={p.id} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-zinc-300" />}
                  <button type="button" onClick={() => open(ownerId, i === 0 ? null : p.id)} className="text-blue-700 hover:underline">
                    {p.name}
                  </button>
                </span>
              ))}
            </div>
            <ul className="divide-y divide-zinc-100">
              {contents.folders.map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => open(ownerId, f.id)} className="flex w-full items-center gap-2 py-2 text-left text-sm hover:bg-zinc-50">
                    <Folder className="h-4 w-4 text-amber-500" />
                    <span className="flex-1">{f.name}</span>
                    {f.trashed && <Badge tone="red"><Trash2 className="h-3 w-3" />in trash</Badge>}
                  </button>
                </li>
              ))}
              {contents.files.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <FileText className="h-4 w-4 text-zinc-400" />
                  <span className={`min-w-0 flex-1 truncate ${f.state === 'trashed' ? 'text-zinc-400 line-through' : ''}`}>{f.name}</span>
                  {f.state === 'trashed' && <Badge tone="red"><Trash2 className="h-3 w-3" />in trash</Badge>}
                  {f.staffOnly ? (
                    <Badge tone="gray"><Lock className="h-3 w-3" />staff only</Badge>
                  ) : f.clientVisible ? (
                    <Badge tone="green"><Eye className="h-3 w-3" />client can see</Badge>
                  ) : (
                    <Badge tone="gray"><EyeOff className="h-3 w-3" />hidden from client</Badge>
                  )}
                  {f.personal && <Badge tone="blue">personal</Badge>}
                  {f.versions > 1 && <Badge tone="blue"><Layers className="h-3 w-3" />{f.versions} versions</Badge>}
                  <span className="text-xs text-zinc-400">{f.size != null ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</span>
                  <a href={`/api/crm-store/browse/file/${f.id}`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">View</a>
                </li>
              ))}
              {contents.folders.length === 0 && contents.files.length === 0 && (
                <li className="py-2 text-sm text-zinc-500">This folder is empty.</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
