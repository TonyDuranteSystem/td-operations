'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  MessageSquare,
  ClipboardList,
  FileText,
  Building2,
  TrendingUp,
  Cog,
  CreditCard,
  Settings,
  Calendar,
  LogOut,
  Menu,
  X,
  MessagesSquare,
  Search,
  Bot,
  Rocket,
  ArrowLeftRight,
  Gauge,
  GripVertical,
} from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface NavItem {
  id: string
  name: string
  href: string
  icon: React.ElementType
  badge?: number
  adminOnly?: boolean
  featureFlag?: string
}

interface SidebarProps {
  user: { email?: string }
  isAdmin?: boolean
  badgeCounts?: { inbox: number; tasks: number }
  enabledFeatures?: string[]
}

const STORAGE_KEY = 'td-sidebar-order'

const defaultNavigation: NavItem[] = [
  { id: 'home', name: 'Home', href: '/', icon: LayoutDashboard },
  { id: 'inbox', name: 'Inbox', href: '/inbox', icon: MessageSquare },
  { id: 'tasks', name: 'Task Board', href: '/tasks', icon: ClipboardList },
  { id: 'tax', name: 'Tax Returns', href: '/tax-returns', icon: FileText },
  { id: 'accounts', name: 'Accounts', href: '/accounts', icon: Building2 },
  { id: 'pipeline', name: 'Pipeline', href: '/pipeline', icon: TrendingUp },
  { id: 'trackers', name: 'Trackers', href: '/trackers', icon: Gauge },
  { id: 'payments', name: 'Payments', href: '/payments', icon: CreditCard },
  { id: 'inv-settings', name: 'Invoice Settings', href: '/invoice-settings', icon: Settings, adminOnly: true },
  { id: 'reconciliation', name: 'Reconciliation', href: '/reconciliation', icon: ArrowLeftRight, adminOnly: true },
  { id: 'calendar', name: 'Calendar', href: '/calendar', icon: Calendar },
  { id: 'portal-chats', name: 'Portal Chats', href: '/portal-chats', icon: MessagesSquare, adminOnly: true },
  { id: 'portal-launch', name: 'Portal Launch', href: '/portal-launch', icon: Rocket, adminOnly: true },
]

function SortableNavItem({ item, isActive, onMobileClose, editMode }: {
  item: NavItem
  isActive: boolean
  onMobileClose: () => void
  editMode: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: !editMode })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center rounded-md transition-colors',
        isDragging && 'opacity-50 z-50 bg-sidebar-accent shadow-lg'
      )}
    >
      {editMode && (
        <button
          {...attributes}
          {...listeners}
          className="p-1 cursor-grab active:cursor-grabbing text-sidebar-foreground/30 hover:text-sidebar-foreground/60 shrink-0"
          title="Drag to reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <Link
        href={item.href}
        onClick={onMobileClose}
        className={cn(
          'flex-1 flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
          editMode && 'pl-1',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        )}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        <span className="flex-1">{item.name}</span>
        {item.badge != null && item.badge > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-600 text-white min-w-[20px] text-center">
            {item.badge > 99 ? '99+' : item.badge}
          </span>
        )}
      </Link>
    </div>
  )
}

export function Sidebar({
  user,
  isAdmin = false,
  badgeCounts,
  enabledFeatures = [],
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [navOrder, setNavOrder] = useState<string[]>([])

  // Load saved order from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const order = JSON.parse(saved) as string[]
        // Validate — only use if all default IDs are present
        const defaultIds = defaultNavigation.map(n => n.id)
        const hasAll = defaultIds.every(id => order.includes(id))
        if (hasAll) {
          setNavOrder(order)
          return
        }
      }
    } catch { /* ignore */ }
    setNavOrder(defaultNavigation.map(n => n.id))
  }, [])

  // Build ordered nav with badges applied
  const orderedNav = navOrder
    .map(id => {
      const item = defaultNavigation.find(n => n.id === id)
      if (!item) return null
      // Apply live badges
      if (item.id === 'inbox' && badgeCounts?.inbox) return { ...item, badge: badgeCounts.inbox }
      if (item.id === 'tasks' && badgeCounts?.tasks) return { ...item, badge: badgeCounts.tasks }
      return item
    })
    .filter((item): item is NavItem => {
      if (!item) return false
      if (item.adminOnly && !isAdmin) return false
      if (item.featureFlag && !enabledFeatures.includes(item.featureFlag)) return false
      return true
    })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    setNavOrder(prev => {
      const oldIndex = prev.indexOf(active.id as string)
      const newIndex = prev.indexOf(over.id as string)
      const newOrder = arrayMove(prev, oldIndex, newIndex)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newOrder))
      return newOrder
    })
  }, [])

  const handleResetOrder = useCallback(() => {
    const defaultOrder = defaultNavigation.map(n => n.id)
    setNavOrder(defaultOrder)
    localStorage.removeItem(STORAGE_KEY)
    setEditMode(false)
  }, [])

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const displayName = user.email?.split('@')[0] ?? 'User'

  return (
    <>
      {/* Mobile header */}
      <div className="fixed top-0 left-0 right-0 z-40 h-14 bg-white border-b flex items-center px-4 lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 -ml-2 rounded-md hover:bg-zinc-100"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="ml-3 font-semibold flex-1">TD Operations</span>
        <button
          onClick={() => document.dispatchEvent(new CustomEvent('open-command-palette'))}
          className="p-2 rounded-md hover:bg-zinc-100 text-zinc-500"
        >
          <Search className="h-5 w-5" />
        </button>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-sidebar text-sidebar-foreground flex flex-col transition-transform lg:translate-x-0 lg:static lg:z-auto',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-16 px-6 border-b border-sidebar-border">
          <span className="text-lg font-semibold">TD Operations</span>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1 rounded hover:bg-sidebar-accent"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {editMode && (
            <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-sidebar-border">
              <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 font-semibold">Drag to reorder</span>
              <div className="flex gap-1">
                <button
                  onClick={handleResetOrder}
                  className="text-[10px] px-1.5 py-0.5 rounded text-amber-400 hover:bg-amber-500/10"
                >
                  Reset
                </button>
                <button
                  onClick={() => setEditMode(false)}
                  className="text-[10px] px-1.5 py-0.5 rounded text-emerald-400 hover:bg-emerald-500/10"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={orderedNav.map(i => i.id)} strategy={verticalListSortingStrategy}>
              {orderedNav.map((item) => {
                const isActive = item.href === '/'
                  ? pathname === '/'
                  : pathname === item.href || pathname.startsWith(item.href + '/')
                return (
                  <SortableNavItem
                    key={item.id}
                    item={item}
                    isActive={isActive}
                    onMobileClose={() => setMobileOpen(false)}
                    editMode={editMode}
                  />
                )
              })}
            </SortableContext>
          </DndContext>
        </nav>

        {/* Search + AI Agent + Edit buttons */}
        <div className="px-3 py-2 border-t border-sidebar-border space-y-1">
          <button
            onClick={() => document.dispatchEvent(new CustomEvent('open-command-palette'))}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">Search...</span>
            <kbd className="hidden sm:inline-flex px-1.5 py-0.5 bg-sidebar-accent rounded text-[10px] text-sidebar-foreground/40">{'\u2318'}K</kbd>
          </button>
          <button
            onClick={() => document.dispatchEvent(new CustomEvent('open-ai-agent'))}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-violet-400 hover:bg-violet-500/10 hover:text-violet-300 transition-colors"
          >
            <Bot className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">AI Agent</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">NEW</span>
          </button>
          {!editMode && (
            <button
              onClick={() => setEditMode(true)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/60 transition-colors"
            >
              <GripVertical className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">Reorder sidebar</span>
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-sidebar-border">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-sm truncate mr-2">
              <p className="font-medium capitalize">{displayName}</p>
              <p className="text-xs text-sidebar-foreground/50 truncate">{user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded hover:bg-sidebar-accent shrink-0"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
