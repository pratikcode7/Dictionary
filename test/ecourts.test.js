import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCaseHtml, parseCourtDate } from "../lib/ecourts.js";

test("parses the date formats eCourts uses", () => {
  assert.equal(parseCourtDate("07th November 2026"), "2026-11-07");
  assert.equal(parseCourtDate("1st December 2026"), "2026-12-01");
  assert.equal(parseCourtDate("Nov 07 2026"), "2026-11-07");
  assert.equal(parseCourtDate("26-11-2026"), "2026-11-26");
  assert.equal(parseCourtDate("12/01/2027"), "2027-01-12");
  assert.equal(parseCourtDate("not listed"), "");
});

// Shape of the case-status table the portal returns inside `casetype_list`.
const pending = `
<h2 class="h2class">16th Joint Civil Judge Junior Division, Pune</h2>
<table class="table case_status_table table-bordered">
  <tr><td><label>First Hearing Date</label></td><td>15th March 2023</td></tr>
  <tr><td><label><strong>Next Hearing Date</strong></label></td><td><strong>07th November 2026</strong></td></tr>
  <tr><td><label><strong>Case Stage</strong></label></td><td><label><strong>Order on Exh</strong></label></td></tr>
  <tr><td><label>Court Number and Judge</label></td><td><label>16-16th Jt Civil Judge J.D. &amp; ADDL CJM</label></td></tr>
</table>
<table class="table case_details_table"><tr><td>Case Type</td><td>Reg.Sum.Suit</td></tr>
<tr><td>Registration Number</td><td>93/2023</td></tr></table>`;

test("reads next date and stage from a pending case", () => {
  const r = parseCaseHtml(pending);
  assert.equal(r.nextDate, "2026-11-07");
  assert.equal(r.stage, "Order on Exh");
  assert.equal(r.court, "16-16th Jt Civil Judge J.D. & ADDL CJM");
  assert.equal(r.caseType, "Reg.Sum.Suit");
  assert.equal(r.registration, "93/2023");
  assert.equal(r.disposed, false);
});

test("recognises a disposed case", () => {
  const r = parseCaseHtml(`<table>
    <tr><td>Decision Date</td><td>14th October 2026</td></tr>
    <tr><td>Case Status</td><td>Case disposed</td></tr>
    <tr><td>Nature of Disposal</td><td>Contested--DISMISSED</td></tr></table>`);
  assert.equal(r.disposed, true);
  assert.equal(r.decisionDate, "2026-10-14");
  assert.equal(r.nextDate, "");
});
