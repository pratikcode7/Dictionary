// Talks to the public eCourts district-court portal the same way its own web page does.
// The captcha is always typed by the advocate in Clerak; nothing here solves it.

const BASE = "https://services.ecourts.gov.in/ecourtindia_v6";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const CNR_PATTERN = /\b[A-Z]{4}\d{12}\b/;

function storeCookies(jar, res) {
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

const cookieHeader = (jar) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

const encodeSession = (jar) => Buffer.from(JSON.stringify(jar)).toString("base64url");

function decodeSession(session) {
  try {
    const jar = JSON.parse(Buffer.from(String(session), "base64url").toString("utf8"));
    if (jar && typeof jar === "object") return jar;
  } catch {}
  throw new Error("eCourts session expired. Load a new captcha.");
}

export async function startSession() {
  const jar = {};
  const home = await fetch(`${BASE}/`, { headers: { "User-Agent": UA } });
  storeCookies(jar, home);
  await home.arrayBuffer();
  if (!home.ok) throw new Error(`eCourts is not responding (${home.status}).`);

  const captcha = await fetch(`${BASE}/vendor/securimage/securimage_show.php?${Math.random()}`, {
    headers: { "User-Agent": UA, Cookie: cookieHeader(jar), Referer: `${BASE}/` },
  });
  storeCookies(jar, captcha);
  if (!captcha.ok) throw new Error(`eCourts captcha did not load (${captcha.status}).`);
  const type = captcha.headers.get("content-type") || "image/png";
  const image = Buffer.from(await captcha.arrayBuffer()).toString("base64");
  return { session: encodeSession(jar), captcha: `data:${type};base64,${image}` };
}

export async function searchByCnr({ session, cnr, code }) {
  const jar = decodeSession(session);
  const res = await fetch(`${BASE}/?p=cnr_status/searchByCNR/`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Cookie: cookieHeader(jar),
      Referer: `${BASE}/`,
      Origin: "https://services.ecourts.gov.in",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      // Sent by the portal's own ajaxCall() on every request.
      delimeter: "xhgdfre54",
      Qereet645: "xhgdfre54",
    },
    body: new URLSearchParams({ cino: cnr, fcaptcha_code: code, ajax_req: "true", app_token: "" }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`eCourts sent an unexpected reply (${res.status}).`);
  }
  if (data.errormsg) return { ok: false, retry: true, error: htmlToLines(data.errormsg).join(" ") };
  if (String(data.status) === "0" || !data.casetype_list) {
    return { ok: false, retry: true, error: "Wrong captcha or CNR. Load a new captcha and try again." };
  }
  return { ok: true, ...parseCaseHtml(data.casetype_list) };
}

export function htmlToLines(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(td|th|tr|p|div|li|label|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Reads "07th November 2026", "07-11-2026", "07/11/2026" or "Nov 07 2026" into YYYY-MM-DD.
export function parseCourtDate(text) {
  const s = String(text);
  let m = /(\d{1,2})(?:st|nd|rd|th)?[\s\-,]+([A-Za-z]{3,})[\s\-,]+(\d{4})/.exec(s);
  if (m) return iso(m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, m[1]);
  m = /([A-Za-z]{3,})[\s\-,]+(\d{1,2})(?:st|nd|rd|th)?[\s\-,]+(\d{4})/.exec(s);
  if (m) return iso(m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, m[2]);
  m = /(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{4})/.exec(s);
  if (m) return iso(m[3], Number(m[2]), m[1]);
  return "";
}

function iso(year, month, day) {
  if (month < 1 || month > 12) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function valueAfter(lines, label) {
  const i = lines.findIndex((l) => label.test(l));
  if (i < 0) return "";
  const sameLine = lines[i].replace(label, "").replace(/^[\s:]+/, "");
  return sameLine || (lines[i + 1] ?? "").replace(/^[\s:]+/, "");
}

export function parseCaseHtml(html) {
  const lines = htmlToLines(html);
  const nextHearingText = valueAfter(lines, /^Next (Hearing )?Date/i);
  const decisionText = valueAfter(lines, /^Decision Date/i);
  return {
    nextDate: parseCourtDate(nextHearingText),
    nextHearingText,
    stage: valueAfter(lines, /^Case Stage/i),
    status: valueAfter(lines, /^Case Status/i),
    disposed: Boolean(decisionText) || /disposed/i.test(valueAfter(lines, /^Nature of Disposal/i)),
    decisionDate: parseCourtDate(decisionText),
    court: valueAfter(lines, /^Court Number and Judge/i),
    caseType: valueAfter(lines, /^Case Type/i),
    registration: valueAfter(lines, /^Registration Number/i),
  };
}
