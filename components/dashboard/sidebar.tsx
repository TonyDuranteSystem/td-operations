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
  Users,
  Landmark,
  KeyRound,
  Loader2,
  Eye,
  EyeOff,
  UserCheck,
  Target,
  Wrench,
} from 'lucide-react'
import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  TouchSensor,
  MouseSensor,
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
  badgeCounts?: { inbox: number; tasks: number; portalChats?: number }
  enabledFeatures?: string[]
}

const STORAGE_KEY = 'td-sidebar-order'

const defaultNavigation: NavItem[] = [
  { id: 'home', name: 'Home', href: '/', icon: LayoutDashboard },
  { id: 'inbox', name: 'Inbox', href: '/inbox', icon: MessageSquare },
  { id: 'tasks', name: 'Task Board', href: '/tasks', icon: ClipboardList },
  { id: 'tax', name: 'Tax Returns', href: '/tax-returns', icon: FileText },
  { id: 'leads', name: 'Leads', href: '/leads', icon: Target },
  { id: 'contacts', name: 'Contacts', href: '/contacts', icon: UserCheck },
  { id: 'accounts', name: 'Accounts', href: '/accounts', icon: Building2 },
  { id: 'pipeline', name: 'Pipeline', href: '/pipeline', icon: TrendingUp },
  { id: 'trackers', name: 'Trackers', href: '/trackers', icon: Gauge },
  { id: 'payments', name: 'Payments', href: '/payments', icon: CreditCard },
  { id: 'inv-settings', name: 'Invoice Settings', href: '/invoice-settings', icon: Settings },
  { id: 'reconciliation', name: 'Reconciliation', href: '/reconciliation', icon: ArrowLeftRight },
  { id: 'bank-feeds', name: 'Bank Feeds', href: '/bank-feeds', icon: Landmark, adminOnly: true },
  { id: 'calendar', name: 'Calendar', href: '/calendar', icon: Calendar },
  { id: 'portal-chats', name: 'Portal Chats', href: '/portal-chats', icon: MessagesSquare },
  { id: 'portal-launch', name: 'Portal Launch', href: '/portal-launch', icon: Rocket },
  { id: 'team-mgmt', name: 'Team Management', href: '/team-management', icon: Users, adminOnly: true },
  { id: 'dev-tools', name: 'Dev Tools', href: '/dev-tools', icon: Wrench, adminOnly: true },
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

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      draggable={false}
      className={cn(
        'flex items-center rounded-md transition-colors select-none',
        isDragging && 'opacity-50 z-50 bg-sidebar-accent shadow-lg'
      )}
    >
      {editMode && (
        <button
          {...attributes}
          {...listeners}
          onDragStart={e => e.preventDefault()}
          className="p-1 cursor-grab active:cursor-grabbing text-sidebar-foreground/30 hover:text-sidebar-foreground/60 shrink-0"
          style={{ touchAction: 'none' }}
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
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [livePortalChats, setLivePortalChats] = useState(badgeCounts?.portalChats ?? 0)
  const [liveInbox, setLiveInbox] = useState(badgeCounts?.inbox ?? 0)
  const pathnameRef = useRef(pathname)

  // Keep pathname ref in sync for use inside realtime callback
  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  // Fetch real count from API on mount (corrects stale server-side layout value)
  useEffect(() => {
    if (pathname === '/portal-chats') return // already reset below
    fetch('/api/portal/chat/badge')
      .then(r => r.json())
      .then(({ count }: { count: number }) => {
        if (typeof count === 'number') setLivePortalChats(count)
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset badge when admin opens the portal chats page
  useEffect(() => {
    if (pathname === '/portal-chats') {
      setLivePortalChats(0)
    }
  }, [pathname])

  // Fetch inbox unread count on mount + poll every 30s
  useEffect(() => {
    const fetchInbox = () => {
      fetch('/api/inbox/stats')
        .then(r => r.json())
        .then(data => {
          if (typeof data.total === 'number') setLiveInbox(data.total)
        })
        .catch(() => {})
    }
    if (pathname !== '/inbox') fetchInbox()
    const interval = setInterval(fetchInbox, 30_000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset inbox badge when user is on inbox page
  useEffect(() => {
    if (pathname === '/inbox') {
      setLiveInbox(0)
    }
  }, [pathname])

  // Subscribe to new WhatsApp/Telegram messages for inbox badge
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('admin-inbox-badge')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'direction=eq.inbound',
        },
        () => {
          if (pathnameRef.current !== '/inbox') {
            setLiveInbox(prev => prev + 1)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // Subscribe to new client messages for real-time badge updates
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('admin-portal-chats-badge')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'portal_messages',
          filter: 'sender_type=eq.client',
        },
        () => {
          if (pathnameRef.current !== '/portal-chats') {
            setLivePortalChats(prev => prev + 1)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

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
      if (item.id === 'inbox' && liveInbox > 0) return { ...item, badge: liveInbox }
      if (item.id === 'tasks' && badgeCounts?.tasks) return { ...item, badge: badgeCounts.tasks }
      if (item.id === 'portal-chats' && livePortalChats > 0) return { ...item, badge: livePortalChats }
      return item
    })
    .filter((item): item is NavItem => {
      if (!item) return false
      if (item.adminOnly && !isAdmin) return false
      if (item.featureFlag && !enabledFeatures.includes(item.featureFlag)) return false
      return true
    })

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } }),
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
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => setPasswordDialogOpen(true)}
                className="p-1.5 rounded hover:bg-sidebar-accent"
                title="Change password"
              >
                <KeyRound className="h-4 w-4" />
              </button>
              <button
                onClick={handleLogout}
                className="p-1.5 rounded hover:bg-sidebar-accent"
                title="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Change Password Dialog */}
      {passwordDialogOpen && (
        <ChangePasswordDialog onClose={() => setPasswordDialogOpen(false)} />
      )}
    </>
  )
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Password changed successfully')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-zinc-600" />
              <h2 className="text-base font-semibold">Change Password</h2>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-4 w-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Current Password</label>
              <div className="relative">
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  required
                  autoFocus
                  className="w-full px-3 py-2 pr-10 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button type="button" onClick={() => setShowCurrent(!showCurrent)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600">
                  {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">New Password</label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-3 py-2 pr-10 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Min 8 characters"
                />
                <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600">
                  {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Confirm New Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                className={cn(
                  "w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500",
                  confirmPassword && confirmPassword !== newPassword && "border-red-300 focus:ring-red-500"
                )}
              />
              {confirmPassword && confirmPassword !== newPassword && (
                <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !currentPassword || !newPassword || newPassword !== confirmPassword}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Change Password
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
