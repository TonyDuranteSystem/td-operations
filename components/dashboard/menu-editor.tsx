'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GripVertical, Loader2, Pencil, Trash2, X } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { groupIcon } from '@/components/dashboard/menu-groups'
import type { NavItem } from '@/components/dashboard/nav-item-row'
import {
  containerOf,
  isGroupId,
  layoutsEqual,
  movePage,
  reorder,
  visibleRows,
  GROUP_NAME_MAX,
  type MenuLayout,
} from '@/lib/nav/menu-layout'

/**
 * "Edit menu" (dev job 45aa5872): the whole menu laid open so pages can be dragged between the main list and any group, groups can
 * be dragged up and down, and each group can be renamed or deleted. Dragging works across containers (the pointer decides which one
 * a page lands in); the moves are held in a draft while the mouse is down and saved ONCE when it is released. The ⋯ → "Move to…"
 * entry on every page does the same job without dragging (and is what a phone is best at).
 */

const EMPTY = 'empty:'

function area(rect: { width: number; height: number } | undefined): number {
  return rect ? rect.width * rect.height : Number.POSITIVE_INFINITY
}

function EditPageRow({ item }: { item: NavItem }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`edit-page-${item.id}`}
      className={cn('flex items-center rounded-md select-none', isDragging && 'relative z-50 bg-sidebar-accent opacity-60 shadow-lg')}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        onDragStart={e => e.preventDefault()}
        className="p-1 shrink-0 cursor-grab text-sidebar-foreground/40 hover:text-sidebar-foreground/70 active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        aria-label={`Drag ${item.name}`}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-sm font-medium text-sidebar-foreground/70">
        <item.icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.name}</span>
      </div>
    </div>
  )
}

function EmptyDrop({ groupId }: { groupId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: EMPTY + groupId })
  return (
    <div
      ref={setNodeRef}
      className={cn('rounded-md border border-dashed px-2 py-2 text-center text-xs', isOver ? 'border-emerald-400 bg-emerald-500/10 text-emerald-300' : 'border-sidebar-border text-sidebar-foreground/40')}
    >
      Drag pages here
    </div>
  )
}

function EditGroupBlock({ id, name, empty, childIds, onRename, onDelete, children }: {
  id: string
  name: string
  empty: boolean
  childIds: string[]
  onRename: () => void
  onDelete: () => void
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const Icon = groupIcon(id)
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`edit-group-${id}`}
      className={cn('rounded-md border border-sidebar-border/70 bg-sidebar-accent/20', isDragging && 'relative z-50 opacity-70 shadow-lg')}
    >
      <div className="flex items-center">
        <button
          {...attributes}
          {...listeners}
          type="button"
          onDragStart={e => e.preventDefault()}
          className="p-1 shrink-0 cursor-grab text-sidebar-foreground/40 hover:text-sidebar-foreground/70 active:cursor-grabbing"
          style={{ touchAction: 'none' }}
          aria-label={`Drag group ${name}`}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <Icon className="mx-1 h-4 w-4 shrink-0 text-sidebar-foreground/70" />
        <span className="min-w-0 flex-1 truncate px-1 py-2 text-sm font-semibold">{name}</span>
        <button type="button" onClick={onRename} aria-label={`Rename group ${name}`} className="rounded p-1.5 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground">
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onDelete} aria-label={`Delete group ${name}`} className="mr-1 rounded p-1.5 text-sidebar-foreground/50 hover:bg-red-500/15 hover:text-red-400">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="ml-4 space-y-0.5 pb-1 pr-1">
        <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
        {empty && <EmptyDrop groupId={id} />}
      </div>
    </div>
  )
}

export function EditMenuTree({ layout, isVisible, itemOf, onCommit, onRenameGroup, onDeleteGroup }: {
  layout: MenuLayout
  isVisible: (id: string) => boolean
  itemOf: (id: string) => NavItem | undefined
  onCommit: (next: MenuLayout) => void
  onRenameGroup: (groupId: string) => void
  onDeleteGroup: (groupId: string) => void
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // While a drag is going on, moves between containers live in a draft; it is saved once, on release.
  const [draft, setDraft] = useState<MenuLayout | null>(null)
  const justMoved = useRef(false)
  const current = draft ?? layout
  const rows = visibleRows(current, isVisible, false)

  // The most specific thing under the pointer wins (a page row beats the group block that holds it); otherwise the nearest one.
  const collision: CollisionDetection = useCallback(args => {
    const within = pointerWithin(args)
    if (within.length > 0) return [...within].sort((a, b) => area(args.droppableRects.get(a.id)) - area(args.droppableRects.get(b.id)))
    return closestCenter(args)
  }, [])

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e
    if (!over) return
    const aid = String(active.id)
    const oid = String(over.id)
    if (isGroupId(aid) || justMoved.current) return // groups only change places on release; one container hop per frame
    const base = draft ?? layout
    const from = containerOf(base, aid)
    let to: string | null
    let before: string | undefined
    if (oid.startsWith(EMPTY)) to = oid.slice(EMPTY.length)
    else if (isGroupId(oid)) to = oid
    else { to = containerOf(base, oid); before = oid }
    if (!from || !to || from === to) return
    setDraft(movePage(base, aid, to, { before }))
    justMoved.current = true
    requestAnimationFrame(() => { justMoved.current = false })
  }

  const onDragEnd = (e: DragEndEvent) => {
    const base = draft ?? layout
    setDraft(null)
    const { active, over } = e
    if (!over) return // dropped outside the menu: nothing changes
    const aid = String(active.id)
    const oid = String(over.id)
    const next = oid.startsWith(EMPTY) ? base : reorder(base, aid, oid)
    if (!layoutsEqual(next, layout)) onCommit(next)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDraft(null)}>
      <SortableContext items={rows.map(r => r.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-1" data-testid="edit-menu-tree">
          {rows.map(row => {
            if (row.type === 'page') {
              const item = itemOf(row.id)
              return item ? <EditPageRow key={row.id} item={item} /> : null
            }
            return (
              <EditGroupBlock
                key={row.id}
                id={row.id}
                name={row.name}
                empty={row.empty}
                childIds={row.children}
                onRename={() => onRenameGroup(row.id)}
                onDelete={() => onDeleteGroup(row.id)}
              >
                {row.children.map(cid => {
                  const item = itemOf(cid)
                  return item ? <EditPageRow key={cid} item={item} /> : null
                })}
              </EditGroupBlock>
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
}

/** Name a new group, or rename one. `onSubmit` returns an error message to show, or null when it worked (the box then closes). */
export function GroupNameDialog({ title, initial = '', submitLabel, onSubmit, onClose }: {
  title: string
  initial?: string
  submitLabel: string
  onSubmit: (name: string) => string | null
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Ready to type: the cursor is in the box and an old name (rename) is selected, so typing replaces it.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const problem = onSubmit(name)
    setBusy(false)
    if (problem) setError(problem)
    else onClose()
  }
  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
        <form
          onSubmit={submit}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
          className="pointer-events-auto w-full max-w-sm rounded-lg bg-white text-zinc-900 shadow-xl"
          data-testid="group-name-dialog"
        >
          <div className="flex items-center justify-between border-b px-5 py-4">
            <h2 className="text-base font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="rounded p-1 hover:bg-zinc-100" aria-label="Close"><X className="h-4 w-4" /></button>
          </div>
          <div className="space-y-2 px-5 py-4">
            <label className="block text-sm font-medium" htmlFor="menu-group-name">Group name</label>
            <input
              id="menu-group-name"
              ref={inputRef}
              value={name}
              maxLength={GROUP_NAME_MAX}
              onChange={e => { setName(e.target.value); setError(null) }}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="For example: Daily work"
            />
            {error && <p className="text-xs text-red-500" role="alert">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 px-5 pb-4">
            <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50">Cancel</button>
            <button type="submit" disabled={busy || name.trim().length === 0} className="flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
