'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { browserStore, clearAllWindows } from '@/lib/windows/windows-storage'
import { WindowsLauncher } from '@/components/dashboard/windows-launcher'
import {
  LayoutDashboard,
  MessageSquare,
  MessageSquareText,
  MessageCircle,
  FileText,
  Building2,
  TrendingUp,
  Settings,
  Calendar,
  CalendarDays,
  LogOut,
  Menu,
  X,
  MessagesSquare,
  Search,
  Bot,
  Gauge,
  Users,
  Wallet,
  KeyRound,
  Loader2,
  Eye,
  EyeOff,
  UserCheck,
  Target,
  Wrench,
  Share2,
  Package,
  PhoneIncoming,
  Phone,
  Mail,
  ClipboardCheck,
  Tag,
  MapPin,
  LayoutGrid,
  Radio,
  StickyNote,
  ShieldCheck,
  SlidersHorizontal,
  HardDrive,
  ClipboardList,
  Megaphone,
  Pencil,
  Plus,
  RotateCcw,
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { DashboardPushToggle } from '@/components/dashboard/push-toggle'
import { StaffAlertsBell } from '@/components/dashboard/staff-alerts-bell'
import { ParkedNotesTrigger } from '@/components/dashboard/parked-notes-trigger'
import { CaptureButton } from '@/components/captures/capture-button'
import { GlobalBackButton } from '@/components/dashboard/global-back-button'
import { MfaSettingsDialog } from '@/components/dashboard/mfa-settings-dialog'
import { ThemeToggle } from '@/components/dashboard/theme-sync'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { NavItemRow, type NavItem } from '@/components/dashboard/nav-item-row'
import type { MoveMenu } from '@/components/dashboard/nav-item-menu'
import { GroupRow, useFlyoutController, useFlyoutMode } from '@/components/dashboard/menu-groups'
import { EditMenuTree, GroupNameDialog } from '@/components/dashboard/menu-editor'
import { useMenuLayout } from '@/components/dashboard/use-menu-layout'
import { isNavItemActive, onWhatsappView } from '@/lib/nav/nav-active'
import {
  containerOf,
  createGroup,
  deleteGroup,
  flattenVisible,
  movePage,
  renameGroup,
  visibleRows,
  type ServerLayoutStatus,
} from '@/lib/nav/menu-layout'

interface SidebarProps {
  user: { email?: string }
  isAdmin?: boolean
  /** True only for the code-level owner account (see lib/auth). */
  isOwner?: boolean
  /** Ids of administrator-only items this non-administrator may still see (e.g. 'forms' for the people named in lib/auth/forms-access.ts). */
  extraNavIds?: string[]
  badgeCounts?: { inbox: number; whatsapp?: number; tasks: number; portalChats?: number; teamChat?: number; talk?: number; overdueInvoices?: number; reconciliationReview?: number; commUnread?: number; marketing?: number; devBoard?: number }
  enabledFeatures?: string[]
  /** The signed-in login — keys this computer's own copy of the menu layout. */
  userId: string
  /** The layout saved on this login (read on the server), or null when the person has not changed the standard one. */
  initialMenuLayout?: unknown
  /** How reading the saved layout went. 'unavailable' = it could not be read, so editing is switched off (a save could overwrite it). */
  menuLayoutStatus?: ServerLayoutStatus
}

/** The two pages that ARE the team chat: opening either one reads it, so the dot must not be held up while you are on it. */
function isChatTab(pathname: string | null | undefined): boolean {
  return pathname === '/team-chat' || pathname === '/td-talk'
}

const defaultNavigation: NavItem[] = [
  { id: 'td-talk', name: 'TD Talk', href: '/td-talk', icon: MessageCircle, tooltip: 'TD Talk — the simple WhatsApp-style chat with Luca, Jodi and your groups. The same messages as the TD Talk phone app and Team Chat.' },
  { id: 'home', name: 'Home', href: '/', icon: LayoutDashboard, tooltip: 'Dashboard overview — urgent tasks, unread messages, deadlines, and action items at a glance.' },
  { id: 'research', name: 'Research', href: '/research', icon: SlidersHorizontal, adminOnly: true, tooltip: 'Build a filter, search across companies, contacts, leads, deals, services, payments, tasks, offers, leases, and operating agreements. Admin only.' },
  { id: 'notes', name: 'Notes', href: '/notes', icon: StickyNote, tooltip: 'Your post-its — active, snoozed (with when they come back), and done. Private by default; share one with a teammate or the whole team.' },
  { id: 'inbox', name: 'Inbox', href: '/inbox', icon: MessageSquare, tooltip: 'Company email (Gmail). Vendor emails, government correspondence, and client replies.' },
  // WhatsApp is its own menu page (Antonio 2026-11-04): the same screen as the Inbox, opened on the WhatsApp conversations only (the Inbox is email only).
  { id: 'whatsapp', name: 'WhatsApp', href: '/inbox?channel=whatsapp', icon: Phone, tooltip: 'WhatsApp conversations with clients and contacts.' },
  // Marketing Chat: the TD Marketing team chat and lead conversations. Only the owner's login sees this row; it opens in the Marketing workspace.
  { id: 'marketing-chat', name: 'Marketing Chat', href: '/marketing/chat', icon: MessageSquareText, ownerOnly: true, tooltip: "TD Marketing chat — Rocco's team chat and the lead conversations. Opens in the Marketing workspace. Owner only." },
  { id: 'portal-chats', name: 'Portal Chats', href: '/portal-chats', icon: MessagesSquare, tooltip: 'Direct messages from clients through the portal. Reply, tag, and create tasks from here.' },
  { id: 'team-chat', name: 'Team Chat', href: '/team-chat', icon: MessageSquare, tooltip: 'Internal chat between team members. Messages are identified by sender with unique sounds per person.' },
  { id: 'dev-board', name: 'Dev Board', href: '/dev-board', icon: LayoutGrid, tooltip: 'Dev-tracker board — every dev job by channel (td-dev/td-bug/td-support): request, findings, approved plan, milestones and status. Claude Code sessions keep it current so nothing is lost.' },
  { id: 'storage', name: 'Storage', href: '/storage', icon: HardDrive, tooltip: 'General-purpose CRM storage — folders and files organized by staff. Not connected to Google Drive.' },
  { id: 'forms', name: 'Forms', href: '/forms', icon: ClipboardList, adminOnly: true, tooltip: 'Standalone forms that are not tied to a client — view a form, make a one-time link to send, and read what comes back. Admins and the staff logins named for it.' },
  { id: 'leads', name: 'Leads', href: '/leads', icon: Target, tooltip: 'New inquiries that haven\'t signed yet. First stage of the client journey.' },
  { id: 'marketing', name: 'Marketing', href: '/marketing-leads', icon: Megaphone, adminOnly: true, tooltip: 'TD Marketing — the master view of Rocco\'s team: leads from the ads, who is working them, what needs you today, and the Meta connection. Admin only.' },
  { id: 'intake', name: 'Intake', href: '/intake', icon: PhoneIncoming, tooltip: 'Review new Calendly bookings — create leads, link calls, or dismiss.' },
  { id: 'contacts', name: 'Contacts', href: '/contacts', icon: UserCheck, tooltip: 'All people in the system. Each contact can own one or more LLCs (accounts).' },
  { id: 'accounts', name: 'Accounts', href: '/accounts', icon: Building2, tooltip: 'LLCs and companies. Each account has services, documents, invoices, and a timeline.' },
  { id: 'conversations', name: 'Conversations', href: '/conversations', icon: Tag, tooltip: 'Client threads tagged by client + topic — pull up everything for a client or a topic. Auto-tagged from #td-support.' },
  { id: 'client-audit', name: 'Client Audit', href: '/clients/audit', icon: ClipboardCheck, tooltip: 'Point zero — review every active client account, establish ground truth, fix data inconsistencies.' },
  { id: 'addresses', name: 'Addresses', href: '/addresses', icon: MapPin, tooltip: 'Address registry — manage the shared Articles-address, mailing, and registered agent records used across accounts. The Principal Office clients see (Largo plus their suite) comes from the suite.' },
  { id: 'pipeline', name: 'Pipeline', href: '/pipeline', icon: TrendingUp, tooltip: 'Visual pipeline of active service deliveries across all stages.' },
  { id: 'trackers', name: 'Trackers', href: '/trackers', icon: Gauge, tooltip: 'Track service deliveries by type — drag cards between stages to advance.' },
  { id: 'pipeline-overview', name: 'Pipeline Overview', href: '/pipeline-overview', icon: LayoutGrid, tooltip: 'All active service deliveries across every pipeline in one view — oldest cards surface first.' },
  // DO NOT REMOVE - Tools sidebar entry. Operator tools hub lives here.
  { id: 'tools', name: 'Tools', href: '/tools', icon: Wrench, tooltip: 'Operator tools hub — fax, e-sign, system health, exceptions, client health, config, dev tools, portal launch.' },
  { id: 'finance', name: 'Finance', href: '/finance', icon: Wallet, tooltip: 'Invoices, payments, bank feed reconciliation, and financial overview. Includes the bank-feed review queue for uncertain auto-matches and crashed activations.' },
  { id: 'owner', name: 'My Finances', href: '/owner', icon: TrendingUp, ownerOnly: true, tooltip: 'Tony Durante LLC — P&L, cash position, transaction categorization, tax estimates. Owner only.' },
  { id: 'tax', name: 'Tax Returns', href: '/tax-returns', icon: FileText, tooltip: 'Tax return filing tracker — status and deadlines.' },
  // Calendar (dev job 40235e3c, Antonio 2026-10-16: "turn on the new calendar"): the ONE Calendar item. For people who may open the New Calendar
  // (the layout passes the 'new-calendar' flag from the same switch the page itself checks — see dashboard-navigation.md) it opens the new
  // day-by-day work list; for everyone else it keeps opening the existing /calendar, so nobody gets a 404 on a main menu item. The existing
  // Calendar (renewals, annual reports, Mark Filed) stays reachable from the new page's third tab. The id stays 'calendar' so everyone's saved menu order holds.
  { id: 'calendar', name: 'Calendar', href: '/calendar', icon: Calendar, tooltip: 'Upcoming deadlines, meetings, and scheduled events.' },
  { id: 'partners', name: 'Partners', href: '/partners', icon: Users, tooltip: 'Client-bringing partners — Maxscale, Fiscalot, Fresh Legal Group. View managed clients and invoices.' },
  { id: 'td-communication', name: 'TD Communication', href: '/dashboard/td-communication', icon: Radio, tooltip: 'Direct realtime channel between TD staff and managed partners (e.g. Cris). Reply to partner messages here.' },
  { id: 'referrals', name: 'Referrals', href: '/referrals', icon: Share2, tooltip: 'Referral tracking — who referred whom, commissions, and payouts.' },
  // Task Board (/tasks) intentionally NOT in the sidebar — retired in favor of
  // the Notification Center (Portal Chats → What's New / To Do). The workflow
  // engine + the /tasks page stay alive at the URL; daily work happens in
  // What's New (workflow steps surface there with their action buttons + SLA).
  // See sysdoc notification-center-workflow-integration-plan.
  { id: 'service-catalog', name: 'Service Catalog', href: '/service-catalog', icon: Package, tooltip: 'Manage services + stages + workflows — one place to add, edit, and publish everything about a service.' },
  // /catalog (generic framework UI) intentionally NOT in the sidebar since the
  // workflow-editor consolidation (2026-05-18). Service Catalog handles services
  // + stages + workflows in one flow. /catalog stays alive at the URL for
  // power-user governance (status / tags / translations).
  { id: 'inv-settings', name: 'Invoice Settings', href: '/invoice-settings', icon: Settings, tooltip: 'Configure invoice templates, payment methods, and default settings.' },
  { id: 'email-templates', name: 'Email Templates', href: '/email-templates', icon: Mail, tooltip: 'Manage reusable email templates used by the CRM compose dialog. Placeholders like {{first_name}} are filled at send time.' },
  { id: 'team-mgmt', name: 'Team Management', href: '/team-management', icon: Users, adminOnly: true, tooltip: 'Manage staff accounts, roles, and permissions.' },
  { id: 'code-tasks', name: 'Code Tasks', href: '/code-tasks', icon: Bot, adminOnly: true, tooltip: 'Live view of Claude code sessions started from Slack — watch in real time, type to steer, and end a session. Admin only.' },
  // NOTE: 'tools' lives up in the Pipeline cluster (moved 2026-06-15 — it was
  // buried last, below the scroll fold, so it read as "missing").
]

/** Every page id the menu knows — the layout always holds each of these exactly once (lib/nav/menu-layout.ts). */
const PAGE_IDS = defaultNavigation.map(n => n.id)

/** What the name box is doing: making a group (optionally putting a page straight into it) or renaming one. */
type Naming = { kind: 'new'; pageId?: string } | { kind: 'rename'; groupId: string }

export function Sidebar({
  user,
  userId,
  isAdmin = false,
  isOwner = false,
  extraNavIds = [],
  badgeCounts,
  enabledFeatures = [],
  initialMenuLayout = null,
  menuLayoutStatus = 'none',
}: SidebarProps) {
  const pathname = usePathname()
  // Inbox and WhatsApp are the same page told apart by the address, so the menu has to read the query too.
  const search = useSearchParams()?.toString() ?? ''
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [mfaDialogOpen, setMfaDialogOpen] = useState(false)
  const [livePortalChats, setLivePortalChats] = useState(badgeCounts?.portalChats ?? 0)
  const [liveTeamChat, setLiveTeamChat] = useState(badgeCounts?.teamChat ?? 0)
  // The TD Talk tab's own signal: unread DMs + group messages only (no @mentions, channels or client conversations).
  const [liveTalk, setLiveTalk] = useState(badgeCounts?.talk ?? 0)
  // Inbox = email only; WhatsApp has its own number (Telegram is not counted anywhere: the Inbox has no Telegram list to open).
  const [liveInbox, setLiveInbox] = useState(badgeCounts?.inbox ?? 0)
  const [liveWhatsapp, setLiveWhatsapp] = useState(badgeCounts?.whatsapp ?? 0)
  const [liveOverdue, setLiveOverdue] = useState(badgeCounts?.overdueInvoices ?? 0)
  const [liveReconReview, setLiveReconReview] = useState(badgeCounts?.reconciliationReview ?? 0)
  const [liveComm] = useState(badgeCounts?.commUnread ?? 0)
  const [liveDevBoard, setLiveDevBoard] = useState(badgeCounts?.devBoard ?? 0)
  // Marketing: what the team is waiting on Antonio for (@mentions, direct messages, lead chats); 0 until he has joined the team
  const [liveMarketing, setLiveMarketing] = useState(0)
  const [liveWhatsNew, setLiveWhatsNew] = useState(0)
  const pathnameRef = useRef(pathname)
  // Which Inbox screen is open now: its own number is not bumped while you are looking at it (it reads itself).
  const viewRef = useRef({ email: false, whatsapp: false })

  const { layout, commit, reset, canEdit } = useMenuLayout({
    userId,
    initial: initialMenuLayout,
    status: menuLayoutStatus,
    pageIds: PAGE_IDS,
    busy: editMode || naming !== null,
  })
  const flyoutMode = useFlyoutMode()
  const ctl = useFlyoutController()
  const { close: closeFlyout } = ctl

  // Keep pathname ref in sync for use inside realtime callback
  useEffect(() => {
    pathnameRef.current = pathname
    const wa = onWhatsappView(pathname, search)
    viewRef.current = { whatsapp: wa, email: (pathname === '/inbox' || pathname.startsWith('/inbox/')) && !wa }
  }, [pathname, search])

  // A panel never outlives the page it was opened on, and editing the menu or naming a group starts with every panel shut.
  useEffect(() => { closeFlyout() }, [pathname, search, editMode, naming, closeFlyout])
  const onWhatsapp = onWhatsappView(pathname, search)

  // Fetch badge counts via API (uses supabaseAdmin server-side to bypass RLS)
  useEffect(() => {
    const fetchBadges = () => {
      fetch('/api/dashboard/badges')
        .then(r => {
          if (!r.ok) return null
          return r.json()
        })
        .then(data => {
          if (!data) return
          if (typeof data.portalChats === 'number' && pathnameRef.current !== '/portal-chats') {
            setLivePortalChats(data.portalChats)
          }
          if (typeof data.teamChat === 'number' && !isChatTab(pathnameRef.current)) {
            setLiveTeamChat(data.teamChat)
          }
          if (typeof data.talk === 'number' && !isChatTab(pathnameRef.current)) {
            setLiveTalk(data.talk)
          }
          if (typeof data.inbox === 'number' && !viewRef.current.email) {
            setLiveInbox(data.inbox)
          }
          if (typeof data.whatsapp === 'number' && !viewRef.current.whatsapp) {
            setLiveWhatsapp(data.whatsapp)
          }
          if (typeof data.overdueInvoices === 'number') {
            setLiveOverdue(data.overdueInvoices)
          }
          if (typeof data.reconciliationReview === 'number') {
            setLiveReconReview(data.reconciliationReview)
          }
          if (typeof data.devBoard === 'number') {
            setLiveDevBoard(data.devBoard)
          }
          if (typeof data.marketing === 'number') setLiveMarketing(data.marketing)
        })
        .catch(() => {})
    }
    // Delay first fetch to ensure auth cookies are set after hydration
    const initialTimer = setTimeout(fetchBadges, 2000)
    const interval = setInterval(fetchBadges, 15_000)
    return () => { clearTimeout(initialTimer); clearInterval(interval) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the global "What's New" unhandled total for the Portal Chats badge.
  // Same source the Portal Chats page uses; staff-only endpoint (403 → ignored).
  useEffect(() => {
    const fetchWhatsNew = () => {
      fetch('/api/crm/admin-actions/whats-new?counts=true')
        .then(r => (r.ok ? r.json() : null))
        .then(data => {
          if (data && typeof data.total === 'number') setLiveWhatsNew(data.total)
        })
        .catch(() => {})
    }
    const initialTimer = setTimeout(fetchWhatsNew, 2000)
    const interval = setInterval(fetchWhatsNew, 30_000)
    return () => { clearTimeout(initialTimer); clearInterval(interval) }
  }, [])

  // When entering a page, refetch badges instead of resetting to 0
  // The badge disappears naturally when messages are actually read
  useEffect(() => {
    if (pathname === '/portal-chats' || pathname === '/inbox' || isChatTab(pathname)) {
      // Refetch after a short delay to allow read-marking to happen
      const timer = setTimeout(() => {
        fetch('/api/dashboard/badges')
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (!data) return
            if (typeof data.portalChats === 'number') setLivePortalChats(data.portalChats)
            if (typeof data.teamChat === 'number') setLiveTeamChat(data.teamChat)
            if (typeof data.talk === 'number') setLiveTalk(data.talk)
            if (typeof data.inbox === 'number') setLiveInbox(data.inbox)
            if (typeof data.whatsapp === 'number') setLiveWhatsapp(data.whatsapp)
            if (typeof data.devBoard === 'number') setLiveDevBoard(data.devBoard)
          })
          .catch(() => {})
      }, 3000)
      return () => clearTimeout(timer)
    }
  }, [pathname, onWhatsapp])

  // A new inbound chat message (WhatsApp or Telegram — the row alone does not say which): ask the server for the WhatsApp number
  // instead of adding one, so a Telegram message never lights the WhatsApp row. Skipped while the WhatsApp screen is open.
  // The question is the LIGHT one (`?only=whatsapp`: one cheap lookup, no Gmail) and bursts are coalesced to at most one call per
  // 10 seconds per tab — a bulk WhatsApp recovery or a busy group must not turn into one full badge check per message per tab.
  useEffect(() => {
    const supabase = createClient()
    let pending: ReturnType<typeof setTimeout> | null = null
    let lastRun = 0
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
          if (viewRef.current.whatsapp || pending) return
          const wait = Math.max(1000, 10_000 - (Date.now() - lastRun))
          pending = setTimeout(() => {
            pending = null
            lastRun = Date.now()
            fetch('/api/dashboard/badges?only=whatsapp')
              .then(r => (r.ok ? r.json() : null))
              .then(d => { if (d && typeof d.whatsapp === 'number' && !viewRef.current.whatsapp) setLiveWhatsapp(d.whatsapp) })
              .catch(() => {})
          }, wait)
        }
      )
      .subscribe()

    return () => {
      if (pending) clearTimeout(pending)
      supabase.removeChannel(channel)
    }
  }, [])

  // Subscribe to new client messages + internal team messages for real-time badge updates
  useEffect(() => {
    const supabase = createClient()
    // A new internal message could be channel chatter (which must NOT light the
    // Team Chat dot) or a DM/@mention (which must). We can't tell from the row
    // alone, so refetch the server's DM+mention-only count (debounced).
    let teamDebounce: ReturnType<typeof setTimeout> | null = null
    const refetchTeamChat = () => {
      if (teamDebounce) clearTimeout(teamDebounce)
      teamDebounce = setTimeout(() => {
        fetch('/api/dashboard/badges')
          .then(r => r.json())
          .then(d => {
            if (typeof d.teamChat === 'number') setLiveTeamChat(d.teamChat)
            if (typeof d.talk === 'number') setLiveTalk(d.talk)
          })
          .catch(() => {})
      }, 1000)
    }
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
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'internal_messages',
        },
        () => {
          if (!isChatTab(pathnameRef.current)) refetchTeamChat()
        }
      )
      .subscribe()

    return () => {
      if (teamDebounce) clearTimeout(teamDebounce)
      supabase.removeChannel(channel)
    }
  }, [])

  // Every page with its live red numbers applied.
  const liveItems: NavItem[] = defaultNavigation.map(item => {
    if (item.id === 'inbox' && liveInbox > 0) return { ...item, badge: liveInbox }
    if (item.id === 'whatsapp' && liveWhatsapp > 0) return { ...item, badge: liveWhatsapp }
    // Tasks badge removed — daily work tracked via message action tags instead
    if (item.id === 'portal-chats') return { ...item, badge: livePortalChats > 0 ? livePortalChats : undefined, purpleBadge: liveWhatsNew }
    // Team Chat shows a plain DOT (not a count) — signal only, for a new DM / @mention.
    if (item.id === 'team-chat' && liveTeamChat > 0) return { ...item, dotBadge: true }
    // TD Talk lights the same plain dot: a new direct message / group message / @mention.
    // Not while you are ON the tab: you are looking at the chat (it reads itself), so a dot there would only flicker.
    if (item.id === 'td-talk' && liveTalk > 0 && pathname !== '/td-talk') return { ...item, dotBadge: true }
    // The Marketing row and the Marketing Chat page are two doors to the same chat: both carry its unread number.
    // (same badgeKey, so a group holding both counts it once)
    if ((item.id === 'marketing' || item.id === 'marketing-chat') && liveMarketing > 0) return { ...item, badge: liveMarketing, badgeKey: 'marketing' }
    if (item.id === 'dev-board' && liveDevBoard > 0) return { ...item, badge: liveDevBoard }
    if (item.id === 'finance' && (liveOverdue + liveReconReview) > 0) return { ...item, badge: liveOverdue + liveReconReview }
    if (item.id === 'td-communication' && liveComm > 0) return { ...item, badge: liveComm }
    // The Calendar item opens the New Calendar for the people who may see it (never inside a window: no menu there anyway).
    if (item.id === 'calendar' && enabledFeatures.includes('new-calendar')) {
      return { ...item, href: '/new-calendar', icon: CalendarDays, tooltip: 'The day-by-day work list: what is on us, what is waiting on someone else, what is finished. Renewals and annual reports are on its third tab.' }
    }
    return item
  })
  const itemById = new Map(liveItems.map(i => [i.id, i]))
  const itemOf = (id: string) => itemById.get(id)

  // WHO may see a page is decided here, per page — never by the group it sits in — so no saved layout can unlock anything.
  const isVisible = (id: string): boolean => {
    const item = itemById.get(id)
    if (!item) return false
    if (item.adminOnly && !isAdmin && !extraNavIds.includes(item.id)) return false
    if (item.ownerOnly && !isOwner) return false
    if (item.featureFlag && !enabledFeatures.includes(item.featureFlag)) return false
    return true
  }

  const shownRows = visibleRows(layout, isVisible, true)
  const activeOf = (item: NavItem) => isNavItemActive(item, pathname, search)
  const groupChoices = visibleRows(layout, isVisible, false)
    .filter(r => r.type === 'group')
    .map(r => ({ id: r.id, name: (r as { name: string }).name }))

  /** "Move to…" for one page's ⋯ menu. Back to the main list puts it right after the group it left (not at the far bottom). */
  const moveFor = (item: NavItem): MoveMenu | undefined => {
    if (!canEdit) return undefined // the saved layout could not be read: do not offer moves that would save over it
    const current = containerOf(layout, item.id) ?? 'root'
    return {
      current,
      groups: groupChoices,
      onMove: to => commit(movePage(layout, item.id, to, to === 'root' && current !== 'root' ? { after: current } : {})),
      onNewGroup: () => setNaming({ kind: 'new', pageId: item.id }),
    }
  }

  const handleDeleteGroup = (groupId: string) => {
    const name = groupChoices.find(g => g.id === groupId)?.name ?? 'this group'
    if (window.confirm(`Delete the group “${name}”? Its pages are not deleted — they go back to the main list.`)) {
      commit(deleteGroup(layout, groupId))
    }
  }

  const handleReset = () => {
    if (window.confirm('Put the menu back to the standard groups? Your own groups and order will be removed.')) {
      void reset()
      setEditMode(false)
    }
  }

  const handleLogout = async () => {
    const supabase = createClient()
    // Floating windows are remembered per person on this computer — forget them at sign-out.
    clearAllWindows(browserStore())
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const displayName = user.email?.split('@')[0] ?? 'User'
  const nameOfGroup = (id: string) => groupChoices.find(g => g.id === id)?.name ?? ''

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
        <GlobalBackButton className="ml-1" />
        <span className="ml-2 font-semibold flex-1">TD Operations</span>
        <ParkedNotesTrigger compact />
        <StaffAlertsBell compact />
        <CaptureButton compact />
        <DashboardPushToggle compact refreshOnMount />
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
          {editMode ? (
            <>
              <div className="px-2 pb-2 mb-1 border-b border-sidebar-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 font-semibold">Edit menu</span>
                  <div className="flex gap-1">
                    <button onClick={handleReset} className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-amber-400 hover:bg-amber-500/10">
                      <RotateCcw className="h-3 w-3" />
                      Reset
                    </button>
                    <button onClick={() => setEditMode(false)} className="text-[10px] px-1.5 py-0.5 rounded text-emerald-400 hover:bg-emerald-500/10">
                      Done
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => setNaming({ kind: 'new' })}
                  className="w-full flex items-center justify-center gap-1.5 rounded-md border border-dashed border-sidebar-border px-2 py-1.5 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New group
                </button>
                <p className="text-[10px] leading-snug text-sidebar-foreground/40">Drag a page onto a group to put it inside, or out to the main list. Drag a group to move it.</p>
              </div>
              <EditMenuTree
                layout={layout}
                isVisible={isVisible}
                itemOf={itemOf}
                onCommit={commit}
                onRenameGroup={groupId => setNaming({ kind: 'rename', groupId })}
                onDeleteGroup={handleDeleteGroup}
              />
            </>
          ) : (
            shownRows.map(row => {
              if (row.type === 'page') {
                const item = itemById.get(row.id)
                if (!item) return null
                return (
                  <NavItemRow
                    key={item.id}
                    item={item}
                    isActive={activeOf(item)}
                    onMobileClose={() => setMobileOpen(false)}
                    move={moveFor(item)}
                  />
                )
              }
              const children = row.children.map(id => itemById.get(id)).filter((i): i is NavItem => !!i)
              return (
                <GroupRow
                  key={row.id}
                  group={{ id: row.id, name: row.name, empty: row.empty }}
                  items={children}
                  isActive={activeOf}
                  onMobileClose={() => setMobileOpen(false)}
                  moveFor={moveFor}
                  flyoutMode={flyoutMode}
                  ctl={ctl}
                />
              )
            })
          )}
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
          {!editMode && <WindowsLauncher items={flattenVisible(layout, isVisible).map(id => itemById.get(id)).filter((i): i is NavItem => !!i)} />}
          {!editMode && (() => {
            const note = 'Your saved menu could not be loaded, so it cannot be edited right now. Reload the page to try again.'
            const button = (
              <button
                onClick={() => setEditMode(true)}
                disabled={!canEdit}
                aria-label={canEdit ? 'Edit menu' : `Edit menu (not available). ${note}`}
                data-testid="edit-menu-button"
                className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/60 transition-colors disabled:pointer-events-none disabled:opacity-60"
              >
                <Pencil className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left">{canEdit ? 'Edit menu' : 'Edit menu (not available)'}</span>
              </button>
            )
            return canEdit ? button : <FastTooltip label={note}><span className="block w-full">{button}</span></FastTooltip>
          })()}
        </div>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-sidebar-border">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-sm truncate mr-2">
              <p className="font-medium capitalize">{displayName}</p>
              <p className="text-xs text-sidebar-foreground/50 truncate">{user.email}</p>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <ThemeToggle />
              <FastTooltip label="Change password">
                <button
                  onClick={() => setPasswordDialogOpen(true)}
                  className="p-1.5 rounded hover:bg-sidebar-accent"
                  aria-label="Change password"
                >
                  <KeyRound className="h-4 w-4" />
                </button>
              </FastTooltip>
              {/* Two-factor self-service: replace authenticator (planned phone
                  change) + regenerate backup codes. Both require a session
                  that has just passed a code. */}
              <FastTooltip label="Two-factor security">
                <button
                  onClick={() => setMfaDialogOpen(true)}
                  className="p-1.5 rounded hover:bg-sidebar-accent"
                  aria-label="Two-factor security"
                >
                  <ShieldCheck className="h-4 w-4" />
                </button>
              </FastTooltip>
              <FastTooltip label="Sign out">
                <button
                  onClick={handleLogout}
                  className="p-1.5 rounded hover:bg-sidebar-accent"
                  aria-label="Sign out"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </FastTooltip>
            </div>
          </div>
        </div>
      </aside>

      {/* Name a new group / rename one */}
      {naming && (
        <GroupNameDialog
          title={naming.kind === 'new' ? 'New group' : 'Rename group'}
          initial={naming.kind === 'rename' ? nameOfGroup(naming.groupId) : ''}
          submitLabel={naming.kind === 'new' ? 'Create' : 'Save'}
          onSubmit={name => {
            if (naming.kind === 'new') {
              const made = createGroup(layout, name)
              if (!made.ok || !made.layout || !made.id) return made.error ?? 'Could not make that group.'
              commit(naming.pageId ? movePage(made.layout, naming.pageId, made.id) : made.layout)
              return null
            }
            const renamed = renameGroup(layout, naming.groupId, name)
            if (!renamed.ok || !renamed.layout) return renamed.error ?? 'Could not rename that group.'
            commit(renamed.layout)
            return null
          }}
          onClose={() => setNaming(null)}
        />
      )}

      {/* Change Password Dialog */}
      {passwordDialogOpen && (
        <ChangePasswordDialog onClose={() => setPasswordDialogOpen(false)} />
      )}

      {/* Two-factor security (replace authenticator / new backup codes) */}
      {mfaDialogOpen && (
        <MfaSettingsDialog isOwner={isOwner} onClose={() => setMfaDialogOpen(false)} />
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
