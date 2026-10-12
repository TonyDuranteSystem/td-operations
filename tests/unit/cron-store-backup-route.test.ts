import { describe, it, expect, vi, beforeEach } from "vitest"

const sweepBackups = vi.fn()
const backupEnabled = vi.fn()
const runBackupAlarm = vi.fn()
const reportSystemError = vi.fn(async () => ({ fingerprint: "x" }))
const logCron = vi.fn()

vi.mock("@/lib/crm-store/backup", () => ({ sweepBackups: (...a: unknown[]) => sweepBackups(...a), backupEnabled: () => backupEnabled() }))
vi.mock("@/lib/crm-store/backup-alarm", () => ({ runBackupAlarm: () => runBackupAlarm() }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: (...a: unknown[]) => reportSystemError(...(a as [])) }))
vi.mock("@/lib/cron-log", () => ({ logCron: (...a: unknown[]) => logCron(...a) }))

import { GET } from "@/app/api/cron/store-backup/route"

const req = (secret?: string) => new Request("http://localhost/api/cron/store-backup", { headers: secret ? { authorization: `Bearer ${secret}` } : {} }) as never

describe("GET /api/cron/store-backup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = "s3cret"
  })

  it("refuses without the secret, and refuses when the secret is not configured (never fails open)", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req("wrong"))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req("s3cret"))).status).toBe(401)
    expect(sweepBackups).not.toHaveBeenCalled()
  })

  it("while the kill switch is off it queues nothing and checks nothing", async () => {
    backupEnabled.mockReturnValue(false)
    const res = await GET(req("s3cret"))
    expect(await res.json()).toEqual({ success: true, status: "disabled" })
    expect(sweepBackups).not.toHaveBeenCalled()
    expect(runBackupAlarm).not.toHaveBeenCalled()
  })

  it("when enabled and healthy it queues the work and raises nothing", async () => {
    backupEnabled.mockReturnValue(true)
    sweepBackups.mockResolvedValue({ status: "queued", owners: 2 })
    runBackupAlarm.mockResolvedValue({ problems: [], counts: {} })
    const body = await (await GET(req("s3cret"))).json()
    expect(body).toMatchObject({ success: true, swept: { status: "queued", owners: 2 }, problems: [] })
    expect(reportSystemError).not.toHaveBeenCalled()
  })

  it("when something is wrong it raises ONE system error carrying every problem", async () => {
    backupEnabled.mockReturnValue(true)
    sweepBackups.mockResolvedValue({ status: "queued", owners: 0 })
    runBackupAlarm.mockResolvedValue({ problems: ["1 storage(s) have failed their backup 3 or more times in a row", "2 storage(s) have changes waiting for backup for more than 6 hours"], counts: { owner_failing: 1, owner_late: 2 } })
    const res = await GET(req("s3cret"))
    expect(res.status).toBe(200)
    expect(reportSystemError).toHaveBeenCalledTimes(1)
    const arg = (reportSystemError.mock.calls[0] as unknown[])[0] as { message: string; context: { problems: string[] } }
    expect(arg.message).toMatch(/failed their backup/)
    expect(arg.message).toMatch(/waiting for backup/)
    expect(arg.context.problems).toHaveLength(2)
  })

  it("a crash is a 500 with the reason, logged — never a silent pass", async () => {
    backupEnabled.mockReturnValue(true)
    sweepBackups.mockRejectedValue(new Error("queue down"))
    const res = await GET(req("s3cret"))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: "queue down" })
    expect(logCron).toHaveBeenCalledWith(expect.objectContaining({ status: "error", error_message: "queue down" }))
  })
})
