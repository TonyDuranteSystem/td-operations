import { createClient } from '@/lib/supabase/server'
import { getTaxBoardData } from '@/lib/tax/board-data'
import { buildBoardColumns } from '@/lib/tax/tax-board'
import { TaxKanbanBoard } from '@/components/tax-returns/tax-kanban-board'

const currentYear = new Date().getFullYear()

export default async function TaxReturnsPage() {
  const supabase = createClient()
  const nowIso = new Date().toISOString()

  // The tax-season board tracks the return for the PRIOR calendar year (e.g.
  // in 2026 we file 2025 returns), matching the SD lifecycle.
  const taxYear = currentYear - 1
  const { columns, cards } = await getTaxBoardData(supabase, taxYear)

  const boardColumns = buildBoardColumns(columns, cards)
  const returnTypes = Array.from(
    new Set(cards.map(c => c.returnType).filter((t): t is string => !!t)),
  ).sort()

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tax Board {taxYear}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          In-flight tax returns by pipeline stage — MMLLC deadline Mar 15, SMLLC deadline Apr 15
        </p>
      </div>
      <TaxKanbanBoard columns={boardColumns} returnTypes={returnTypes} nowIso={nowIso} />
    </div>
  )
}
