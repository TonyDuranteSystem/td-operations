import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdmin, isDashboardUser } from '@/lib/auth'
import {
  Activity,
  AlertTriangle,
  HeartPulse,
  Rocket,
  Settings,
  Workflow,
  Wrench,
  Printer,
  PenLine,
  FileSpreadsheet,
  type LucideIcon,
} from 'lucide-react'

interface ToolTile {
  name: string
  href: string
  description: string
  icon: LucideIcon
  adminOnly?: boolean
  comingSoon?: boolean
  /** Optional secondary action links rendered as buttons at the bottom of the card. */
  links?: { label: string; href: string }[]
}

// The operator tools, gathered out of the main sidebar into one hub.
const TOOLS: ToolTile[] = [
  {
    name: 'Fax',
    href: '/tools/fax',
    description: 'Send a document by fax via Faxage — enter a number, attach a file, send.',
    icon: Printer,
    links: [
      { label: 'Send Fax', href: '/tools/fax' },
      { label: 'Fax History', href: '/tools/fax/history' },
    ],
  },
  {
    name: 'E-Sign',
    href: '/tools/esign',
    description: 'Send documents for e-signature — upload a PDF, place fields, send, track.',
    icon: PenLine,
    links: [
      { label: 'New Envelope', href: '/tools/esign/new' },
      { label: 'Envelopes', href: '/tools/esign' },
    ],
  },
  {
    name: 'P&L / Balance Sheet',
    href: '/tools/pnl',
    description: 'Run the tax-financials review for any client — upload statements + prior-year return, review, and download the P&L and Balance Sheet.',
    icon: FileSpreadsheet,
  },
  {
    name: 'System Health',
    href: '/system-health',
    description: 'Live system visibility — crons, audit findings, deploys, work locks, stuck clients.',
    icon: Activity,
    adminOnly: true,
  },
  {
    name: 'Exceptions',
    href: '/exceptions',
    description: 'What is broken right now — partial activations, audit findings, failed jobs and emails, webhook events awaiting review.',
    icon: AlertTriangle,
    adminOnly: true,
  },
  {
    name: 'Workflow Issues',
    href: '/workflow-issues',
    description: 'Automations that failed to start a task — no matching workflow, ambiguous match, or failure. Catches issues with no client attached too.',
    icon: Workflow,
  },
  {
    name: 'Client Health',
    href: '/client-health',
    description: 'Stuck activations, orphan records, wrong account types, and data integrity issues.',
    icon: HeartPulse,
  },
  {
    name: 'Portal Launch',
    href: '/portal-launch',
    description: 'Client portal management — create portal users, send invitations.',
    icon: Rocket,
  },
  {
    name: 'Config',
    href: '/config',
    description: 'Edit SOPs, pipeline stages, and dev tasks through a guarded surface instead of raw SQL.',
    icon: Settings,
    adminOnly: true,
  },
  {
    name: 'Dev Tools',
    href: '/dev-tools',
    description: 'Developer utilities — database queries, system status, and debugging tools.',
    icon: Wrench,
    adminOnly: true,
  },
]

export default async function ToolsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isDashboardUser(user)) {
    redirect('/')
  }
  const admin = isAdmin(user)

  const visible = TOOLS.filter(t => !t.adminOnly || admin)

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tools</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Operator tools — system health, exceptions, client health, config, and more.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map(tool => {
          const Icon = tool.icon
          const inner = (
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-zinc-100 group-hover:bg-blue-50 flex items-center justify-center shrink-0 transition-colors">
                <Icon className="h-5 w-5 text-zinc-600 group-hover:text-blue-600 transition-colors" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-800 group-hover:text-blue-700 transition-colors flex items-center gap-2">
                  {tool.name}
                  {tool.comingSoon && (
                    <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-500">
                      Coming soon
                    </span>
                  )}
                </h2>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {tool.description}
                </p>
              </div>
            </div>
          )
          // Placeholder tiles render as a non-navigating, dimmed card.
          if (tool.comingSoon) {
            return (
              <div key={tool.href} className="rounded-lg border bg-white p-5 opacity-60 cursor-default">
                {inner}
              </div>
            )
          }
          // Tiles with multiple actions render secondary link buttons instead of
          // wrapping the whole card in a single <Link> (no nested anchors).
          if (tool.links && tool.links.length > 0) {
            return (
              <div key={tool.href} className="group rounded-lg border bg-white p-5 hover:border-blue-300 hover:shadow-sm transition-all">
                {inner}
                <div className="mt-4 flex flex-wrap gap-2">
                  {tool.links.map(link => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              </div>
            )
          }
          return (
            <Link
              key={tool.href}
              href={tool.href}
              className="group rounded-lg border bg-white p-5 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              {inner}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
