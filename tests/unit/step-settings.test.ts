import { describe, it, expect } from "vitest"
import { WAITING_ON_VALUES, WAITING_ON_LABELS, isWaitingOn, stageNotificationText, stepSettingsProblems } from "@/lib/services/step-settings"

describe("isWaitingOn", () => {
  it("accepts every allowed value", () => {
    for (const v of WAITING_ON_VALUES) expect(isWaitingOn(v)).toBe(true)
  })
  it("rejects anything else", () => {
    expect(isWaitingOn("Client")).toBe(false)
    expect(isWaitingOn("")).toBe(false)
    expect(isWaitingOn(null)).toBe(false)
    expect(isWaitingOn(undefined)).toBe(false)
    expect(isWaitingOn(3)).toBe(false)
  })
  it("has a label for every value", () => {
    for (const v of WAITING_ON_VALUES) expect(WAITING_ON_LABELS[v]).toBeTruthy()
  })
})

describe("stepSettingsProblems", () => {
  it("is empty for a normal list", () => {
    expect(
      stepSettingsProblems("CMRA Mailing Address", [
        { stage_name: "Lease Created", waiting_on: "client" },
        { stage_name: "CMRA Active", waiting_on: "none", completes_service: true },
      ]),
    ).toEqual([])
  })

  it("is empty with no done step and no settings", () => {
    expect(stepSettingsProblems("Company Formation", [{ stage_name: "Data Collection" }])).toEqual([])
  })

  it("refuses two done steps, naming both", () => {
    const p = stepSettingsProblems("DBA", [
      { stage_name: "Registered", completes_service: true },
      { stage_name: "Renewal Due", completes_service: true },
    ])
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('"Registered"')
    expect(p[0]).toContain('"Renewal Due"')
  })

  it("refuses an action-required step not waiting on the client", () => {
    const p = stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: "us" }])
    expect(p).toHaveLength(1)
    expect(p[0]).toContain("Client Signing")
  })

  it("accepts an action-required step waiting on the client, or not set", () => {
    expect(stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: "client" }])).toEqual([])
    expect(stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: null }])).toEqual([])
    expect(stepSettingsProblems("ITIN", [{ stage_name: "Client Signing" }])).toEqual([])
  })

  it("does not apply the registry rule to a same-named step of another service", () => {
    expect(stepSettingsProblems("EIN", [{ stage_name: "Client Signing", waiting_on: "us" }])).toEqual([])
  })
})

describe("stageNotificationText", () => {
  it("uses the done step's own client label when it has one", () => {
    expect(
      stageNotificationText({
        serviceName: "CMRA 2027", isCompleted: true, stageLabel: "Your office address is active", hasClientLabel: true,
      }),
    ).toEqual({ title: "CMRA 2027 — Your office address is active", body: "Your office address is active" })
  })
  it("keeps the generic wording for a done step without a client label", () => {
    expect(
      stageNotificationText({ serviceName: "EIN", isCompleted: true, stageLabel: "EIN Received", hasClientLabel: false }),
    ).toEqual({ title: "EIN is complete!", body: "Your service has been completed." })
  })
  it("an ordinary move says the step it moved to", () => {
    expect(
      stageNotificationText({ serviceName: "EIN", isCompleted: false, stageLabel: "Sign your SS-4", hasClientLabel: true }),
    ).toEqual({ title: "EIN update", body: "Status updated to: Sign your SS-4" })
  })
})
