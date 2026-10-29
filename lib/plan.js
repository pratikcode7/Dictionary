// Turns Claude's raw extraction + matching into a per-event plan the UI can show and apply.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function buildPlan({ eventIds, extraction, boardDate }) {
  const cases = new Map();
  for (const c of extraction.cases ?? []) {
    if (c?.ref) cases.set(c.ref, c);
  }

  const matchByEvent = new Map();
  for (const m of extraction.matches ?? []) {
    if (m?.event_id && !matchByEvent.has(m.event_id)) matchByEvent.set(m.event_id, m);
  }

  const usedRefs = new Set();
  const items = eventIds.map((eventId) => {
    const match = matchByEvent.get(eventId);
    const found = match?.case_ref ? cases.get(match.case_ref) : undefined;
    if (!found) {
      return {
        eventId,
        status: "unmatched",
        reason: match?.reason || "Not found in the screenshots.",
      };
    }
    usedRefs.add(found.ref);
    const base = {
      eventId,
      caseNumber: found.case_number,
      parties: found.parties,
      court: found.court,
      stage: found.stage,
      confidence: match.confidence,
      reason: match.reason,
    };
    if (!isIsoDate(found.next_date)) {
      return { ...base, status: "not_updated", reason: "eCourts shows no next date yet." };
    }
    if (found.next_date <= boardDate) {
      return { ...base, status: "not_updated", newDate: found.next_date, reason: "eCourts has not updated the next date yet." };
    }
    return { ...base, status: "move", newDate: found.next_date };
  });

  const unmatchedCases = [...cases.values()]
    .filter((c) => !usedRefs.has(c.ref))
    .map((c) => ({
      caseNumber: c.case_number,
      parties: c.parties,
      court: c.court,
      stage: c.stage,
      nextDate: isIsoDate(c.next_date) ? c.next_date : "",
    }));

  const listDate = isIsoDate(extraction.list_date) ? extraction.list_date : "";
  return {
    listDate,
    listDateMismatch: Boolean(listDate && listDate !== boardDate),
    items,
    unmatchedCases,
  };
}
