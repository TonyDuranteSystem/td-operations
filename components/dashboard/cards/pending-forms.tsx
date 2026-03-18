import { createClient } from '@/lib/supabase/server'
import { FileCheck, ClipboardList } from 'lucide-react'
import { differenceInDays, parseISO } from 'date-fns'

interface PendingForm {
  type: string
  client_name: string
  sent_at: string
  days_waiting: number
}

export async function PendingFormsCard() {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]

  // Query all form tables for sent-not-submitted
  const formQueries = [
    { table: 'formation_forms', type: 'Formation', nameField: 'owner_first_name' },
    { table: 'onboarding_forms', type: 'Onboarding', nameField: 'owner_first_name' },
    { table: 'banking_forms', type: 'Banking', nameField: 'owner_first_name' },
    { table: 'itin_forms', type: 'ITIN', nameField: 'owner_first_name' },
    { table: 'tax_forms', type: 'Tax', nameField: 'company_name' },
    { table: 'closure_forms', type: 'Closure', nameField: 'owner_first_name' },
  ]

  const results = await Promise.allSettled(
    formQueries.map(async ({ table, type, nameField }) => {
      const { data } = await supabase
        .from(table)
        .select('*')
        .eq('status', 'sent')
        .order('created_at', { ascending: true })
        .limit(5)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((row: any) => ({
        type,
        client_name: (row[nameField] as string) ?? 'Unknown',
        sent_at: row.created_at as string,
        days_waiting: differenceInDays(parseISO(today), parseISO(row.created_at as string)),
      }))
    })
  )

  const pending: PendingForm[] = results
    .filter((r): r is PromiseFulfilledResult<PendingForm[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => b.days_waiting - a.days_waiting)
    .slice(0, 6)

  if (pending.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Pending Forms
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <FileCheck className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">No forms pending</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
        Pending Forms
      </h3>
      <div className="space-y-2">
        {pending.map((form, i) => (
          <div key={i} className="flex items-center gap-2 py-1.5 px-3 rounded-md bg-zinc-50 text-sm">
            <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate text-xs">{form.type}</p>
              <p className="text-xs text-muted-foreground truncate">{form.client_name}</p>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {form.days_waiting}d ago
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
