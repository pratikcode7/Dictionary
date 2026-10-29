import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, isIsoDate } from "../lib/plan.js";

const extraction = {
  list_date: "2026-10-29",
  cases: [
    { ref: "C1", case_number: "Sessions Case/428/2017", parties: "State Vs Sudam Gaikwad", court: "DJ-10", next_date: "2026-11-26", stage: "Evidence" },
    { ref: "C2", case_number: "R.C.S./1066/2025", parties: "Kailas Kadu Vs Dilip Kadu", court: "23rd Jt CJSD", next_date: "2026-10-29", stage: "W.S. and Say" },
    { ref: "C3", case_number: "Spl.Case/646/2026", parties: "State Vs Anil Mohite", court: "DJ-10", next_date: "2026-11-07", stage: "Charge" },
    { ref: "C4", case_number: "R.C.S./1564/2024", parties: "Sharayu Vs Rajesh Kondale", court: "15th Jt CJSD", next_date: "2027-01-12", stage: "Unready Board" },
  ],
  matches: [
    { event_id: "e1", case_ref: "C1", confidence: "high", reason: "S.C.No.428/17 matches" },
    { event_id: "e2", case_ref: "C2", confidence: "high", reason: "RCS 1066/25 matches" },
    { event_id: "e3", case_ref: "", confidence: "low", reason: "No such case on board" },
    { event_id: "e4", case_ref: "C3", confidence: "low", reason: "Names partly match" },
    { event_id: "ghost", case_ref: "C4", confidence: "high", reason: "unknown event" },
  ],
};

test("builds one item per calendar event with the right status", () => {
  const plan = buildPlan({ eventIds: ["e1", "e2", "e3", "e4", "e5"], extraction, boardDate: "2026-10-29" });
  const byId = Object.fromEntries(plan.items.map((i) => [i.eventId, i]));

  assert.equal(byId.e1.status, "move");
  assert.equal(byId.e1.newDate, "2026-11-26");
  assert.equal(byId.e1.stage, "Evidence");

  assert.equal(byId.e2.status, "not_updated", "next date equal to board date is not an update");
  assert.equal(byId.e3.status, "unmatched");
  assert.equal(byId.e4.status, "move");
  assert.equal(byId.e4.confidence, "low");
  assert.equal(byId.e5.status, "unmatched", "events the model skipped are still listed");
  assert.equal(plan.items.length, 5, "unknown event ids from the model are ignored");
});

test("lists board cases that matched no calendar event", () => {
  const plan = buildPlan({ eventIds: ["e1", "e2", "e3", "e4"], extraction, boardDate: "2026-10-29" });
  assert.deepEqual(
    plan.unmatchedCases.map((c) => c.caseNumber),
    ["R.C.S./1564/2024"],
  );
});

test("flags screenshots from a different day", () => {
  const plan = buildPlan({ eventIds: ["e1"], extraction, boardDate: "2026-10-30" });
  assert.equal(plan.listDateMismatch, true);
  assert.equal(plan.items[0].status, "move");
});

test("rejects malformed next dates", () => {
  const bad = { ...extraction, cases: [{ ...extraction.cases[0], next_date: "2026-02-30" }] };
  const plan = buildPlan({ eventIds: ["e1"], extraction: bad, boardDate: "2026-10-29" });
  assert.equal(plan.items[0].status, "not_updated");
  assert.equal(isIsoDate("2026-11-07"), true);
  assert.equal(isIsoDate("07-11-2026"), false);
});
