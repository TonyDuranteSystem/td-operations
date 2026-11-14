'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Columns3 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { columnDefs, defaultColumns, type ListId } from '@/lib/crm-lists/columns'
import { resetListColumns, saveListColumns } from '@/app/(dashboard)/accounts/list-actions'

/**
 * The "Columns" dropdown: tick the extra fields you want on this list. The choice is saved with your login, so it follows you to every
 * computer. Name, Companies / Company and the money columns are always there and are not in the list.
 */
export function ColumnsMenu({ list, selected, always }: { list: ListId; selected: string[]; always: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>(selected)
  const wrapRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Follow the saved choice when the page reloads with a different one (another tab, a reset).
  useEffect(() => {
    setPicked(selected)
  }, [selected])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const defs = columnDefs(list)
  const groups: { name: string; items: typeof defs[number][] }[] = []
  for (const d of defs) {
    const g = groups.find(x => x.name === d.group)
    if (g) g.items.push(d)
    else groups.push({ name: d.group, items: [d] })
  }

  // Ticks are saved together half a second after the last one, then the page reloads its data with the new fields.
  function scheduleSave(next: string[]) {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      try {
        const res = await saveListColumns(list, next)
        if (!res.success) {
          toast.error(res.error || 'Could not save your fields. Please try again.')
          return
        }
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Could not save your fields. Please try again.')
      }
    }, 500)
  }

  function toggle(id: string) {
    const next = picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id]
    setPicked(next)
    scheduleSave(next)
  }

  async function reset() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setPicked(defaultColumns(list))
    try {
      const res = await resetListColumns(list)
      if (!res.success) {
        toast.error(res.error || 'Could not reset your fields. Please try again.')
        return
      }
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not reset your fields. Please try again.')
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50',
          open && 'bg-zinc-50',
        )}
      >
        <Columns3 className="h-4 w-4" />
        Columns
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 max-h-[70vh] w-[320px] overflow-y-auto rounded-xl border bg-white p-3.5 shadow-lg">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Always shown</p>
          <p className="mb-3 text-sm text-zinc-500">{always}</p>
          {groups.map(g => (
            <div key={g.name} className="mb-3">
              <p className="mb-1 border-t pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.name}</p>
              {g.items.map(d => (
                <label key={d.id} className="flex cursor-pointer items-center gap-2.5 py-1 text-sm text-zinc-800">
                  <input type="checkbox" checked={picked.includes(d.id)} onChange={() => toggle(d.id)} className="h-4 w-4 accent-zinc-900" />
                  {d.label}
                </label>
              ))}
            </div>
          ))}
          <div className="flex items-center justify-between border-t pt-2.5">
            <p className="text-xs text-muted-foreground">Saved for you only.</p>
            <button type="button" onClick={() => void reset()} className="text-xs font-semibold text-zinc-700 underline underline-offset-2 hover:text-zinc-900">
              Standard fields
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
