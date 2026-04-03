'use client'

interface ClientSummary {
  id: string
  company_name: string
  outstanding: number
  overdue: number
  overdue_count: number
  invoice_count: number
}

interface Props {
  stats: { totalOutstanding: number; totalOverdue: number; overdueCount: number; clientCount: number }
  clientList: ClientSummary[]
}

export function OverviewTab({ stats, clientList }: Props) {
  // Top overdue clients
  const overdueClients = clientList
    .filter(c => c.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 10)

  // Top outstanding clients
  const outstandingClients = clientList
    .filter(c => c.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 10)

  return (
    <div className="p-6 space-y-6 overflow-y-auto max-h-[calc(100vh-200px)]">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Outstanding</p>
          <p className="text-2xl font-bold">${stats.totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Overdue</p>
          <p className="text-2xl font-bold text-red-600">${stats.totalOverdue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Overdue Invoices</p>
          <p className="text-2xl font-bold text-red-600">{stats.overdueCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Active Clients</p>
          <p className="text-2xl font-bold">{stats.clientCount}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Overdue clients */}
        <div className="rounded-lg border">
          <div className="px-4 py-3 border-b bg-red-50">
            <h3 className="font-medium text-red-800">Overdue by Client</h3>
          </div>
          <div className="divide-y">
            {overdueClients.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">No overdue invoices</p>
            )}
            {overdueClients.map(c => (
              <div key={c.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium">{c.company_name}</p>
                  <p className="text-xs text-muted-foreground">{c.overdue_count} overdue invoice{c.overdue_count !== 1 ? 's' : ''}</p>
                </div>
                <span className="text-sm font-bold text-red-600">${c.overdue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Outstanding clients */}
        <div className="rounded-lg border">
          <div className="px-4 py-3 border-b bg-blue-50">
            <h3 className="font-medium text-blue-800">Outstanding by Client</h3>
          </div>
          <div className="divide-y">
            {outstandingClients.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">No outstanding invoices</p>
            )}
            {outstandingClients.map(c => (
              <div key={c.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium">{c.company_name}</p>
                  <p className="text-xs text-muted-foreground">{c.invoice_count} invoice{c.invoice_count !== 1 ? 's' : ''}</p>
                </div>
                <div className="text-right">
                  <span className="text-sm font-bold text-blue-600">${c.outstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  {c.overdue > 0 && (
                    <p className="text-xs text-red-500">${c.overdue.toLocaleString()} overdue</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
