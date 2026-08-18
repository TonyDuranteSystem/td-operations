import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { getEntity } from '@/lib/research/entity-registry'
import type { Condition } from '@/lib/research/query-builder'
import { runEntitySearch } from '@/lib/research/run-entity-search'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const EXPORT_ROW_CAP = 5000

interface ExportBody {
  entities: string[]
  conditions?: Condition[]
}

/**
 * POST /api/research/export
 * Downloads the CURRENT filtered results as an .xlsx workbook — one sheet
 * per selected record type. Reuses runEntitySearch, the exact function the
 * on-screen results call, so the file can never disagree with the screen.
 * Admin-only, same gate as the search route.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: ExportBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const entityKeys = Array.isArray(body.entities) ? body.entities : []
  if (entityKeys.length === 0) {
    return NextResponse.json({ error: 'Select at least one record type' }, { status: 400 })
  }

  const entities = []
  for (const key of entityKeys) {
    const entity = getEntity(key)
    if (!entity) return NextResponse.json({ error: `Unknown entity "${key}"` }, { status: 400 })
    entities.push(entity)
  }

  const conditions = body.conditions ?? []

  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'TD Operations — Research'
  workbook.created = new Date()

  let anyTruncated = false

  for (const entity of entities) {
    // Pull every matching row up to the export cap, one page at a time —
    // the export must not silently stop at the same 50-row screen page the
    // UI uses; that would make "export to Excel" quietly wrong.
    const rows: Record<string, unknown>[] = []
    let page = 1
    let total = 0
    for (;;) {
      const result = await runEntitySearch(entity, conditions, page)
      total = result.total
      rows.push(...result.items)
      if (!result.truncated || rows.length >= EXPORT_ROW_CAP) break
      page += 1
    }
    if (rows.length < total) anyTruncated = true

    const sheet = workbook.addWorksheet(entity.label.slice(0, 31))
    const columns = [entity.displayField, ...entity.fields.map(f => f.key).filter(k => k !== entity.displayField)]
    sheet.columns = columns.map(key => ({
      header: entity.fields.find(f => f.key === key)?.label ?? key,
      key,
      width: 22,
    }))
    sheet.getRow(1).font = { bold: true }
    for (const row of rows) sheet.addRow(row)

    if (rows.length === 0) {
      sheet.addRow({ [columns[0]]: 'No matching records.' })
    }
  }

  if (anyTruncated) {
    const note = workbook.addWorksheet('Note')
    note.addRow(['This export was capped and does not include every matching row.'])
    note.addRow([`Cap: ${EXPORT_ROW_CAP} rows per record type. Narrow your filters to get a complete export.`])
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  const stamp = new Date().toISOString().slice(0, 10)

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="research-${stamp}.xlsx"`,
    },
  })
}
