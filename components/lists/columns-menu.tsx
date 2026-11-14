'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Columns3 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { cleanColumns, columnDefs, defaultColumns, type ListId } from '@/lib/crm-lists/columns'
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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The newest ticks, and how many saves are waiting or running. While any are, a page that reloads with the OLD saved choice must not
  // overwrite what was just ticked (that used to flip a tick back or drop it).
  const latestRef = useRef<string[]>(selected)
  const busyRef = useRef(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // The choice (in the dropdown's own order) we last saved successfully. A page that arrives still showing an OLDER choice (a reload that
  // was already on its way) is ignored, so it cannot flip a tick back.
  const lastSavedKeyRef = useRef<string | null>(null)
  const selectedKey = selected.join('|')

  // Follow the saved choice when the page reloads with a different one (another tab, a reset) — but not while ticks are still being saved.
  useEffect(() => {
    if (busyRef.current > 0) return
    if (lastSavedKeyRef.current !== null && selectedKey !== lastSavedKeyRef.current) return
    latestRef.current = selected
    setPicked(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the CONTENT of the saved choice, not the array's identity
  }, [selectedKey])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Leaving the page with a tick still waiting (clicking a row within half a second) saves it instead of dropping it.
  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      void saveListColumns(list, latestRef.current).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when the menu goes away
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
    busyRef.current += 1
    timerRef.current = setTimeout(async () => {
      timerRef.current = null
      try {
        const res = await saveListColumns(list, next)
        if (!res.success) {
          toast.error(res.error || 'Could not save your fields. Please try again.')
          failed()
          return
        }
        lastSavedKeyRef.current = cleanColumns(list, next).join('|')
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Could not save your fields. Please try again.')
        failed()
      } finally {
        busyRef.current = Math.max(0, busyRef.current - 1)
      }
    }, 500)
  }

  // A save that did not go through: show what the table really has, not the box that was just ticked.
  function failed() {
    latestRef.current = selectedRef.current
    setPicked(selectedRef.current)
  }

  function toggle(id: string) {
    const base = latestRef.current
    const next = base.includes(id) ? base.filter(x => x !== id) : [...base, id]
    latestRef.current = next
    setPicked(next)
    // A tick made while an earlier save is still running replaces the waiting one; only the newest choice is sent.
    if (timerRef.current) busyRef.current = Math.max(0, busyRef.current - 1)
    scheduleSave(next)
  }

  async function reset() {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      busyRef.current = Math.max(0, busyRef.current - 1)
    }
    const standard = defaultColumns(list)
    latestRef.current = standard
    setPicked(standard)
    busyRef.current += 1
    try {
      const res = await resetListColumns(list)
      if (!res.success) {
        toast.error(res.error || 'Could not reset your fields. Please try again.')
        failed()
        return
      }
      lastSavedKeyRef.current = standard.join('|')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not reset your fields. Please try again.')
      failed()
    } finally {
      busyRef.current = Math.max(0, busyRef.current - 1)
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
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
