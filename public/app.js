// Clerak — moves today's court hearings in Google Calendar to their next eCourts date.

const $ = (sel, root = document) => root.querySelector(sel);

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");
const CNR_PATTERN = /\b[A-Z]{4}\d{12}\b/i;
const MAX_SCREENSHOTS = 8;
const MAX_IMAGE_EDGE = 1568;

// ---------- storage (never trusted to exist: private mode / blocked storage) ----------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`clerak.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`clerak.${key}`, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { localStorage.removeItem(`clerak.${key}`); } catch {}
  },
};

// ---------- dates (YYYY-MM-DD strings in the phone's local time zone) ----------
const pad = (n) => String(n).padStart(2, "0");
const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoToUTC = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const addDays = (iso, n) => new Date(isoToUTC(iso) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((isoToUTC(b) - isoToUTC(a)) / 86400000);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtShort = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
};
const fmtSpoken = (iso) => {
  const dt = new Date(isoToUTC(iso));
  return `${DAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].toLowerCase()}`;
};

// ---------- state ----------
const state = {
  config: { googleClientId: "", passcodeRequired: false, aiReady: false },
  boardDate: localISO(new Date()),
  calendarId: store.get("calendarId", "primary"),
  passcode: store.get("passcode", ""),
  voice: store.get("voice", true),
  events: [],
  eventsFor: "",
  plan: null,
  busy: false,
  mode: "boot",
};

// ---------- HUD helpers ----------
const ui = {
  log: $("#log"),
  hint: $("#orbHint"),
  consoleState: $("#consoleState"),
};

let typing = Promise.resolve();
function log(text, kind = "") {
  typing = typing.then(
    () =>
      new Promise((resolve) => {
        const li = document.createElement("li");
        if (kind) li.className = kind;
        li.classList.add("typing");
        ui.log.append(li);
        while (ui.log.children.length > 80) ui.log.firstElementChild.remove();
        let i = 0;
        const step = Math.max(1, Math.ceil(text.length / 40));
        const tick = () => {
          i = Math.min(text.length, i + step);
          li.textContent = text.slice(0, i);
          ui.log.scrollTop = ui.log.scrollHeight;
          if (i < text.length) setTimeout(tick, 14);
          else {
            li.classList.remove("typing");
            resolve();
          }
        };
        tick();
      }),
  );
  return typing;
}

const HINTS = {
  boot: "INITIALISING",
  idle: "TAP TO ENGAGE",
  auth: "LINKING GOOGLE",
  scan: "SYNCING",
  think: "ANALYSING",
  ready: "REVIEW READY",
  apply: "UPDATING",
  done: "MISSION COMPLETE",
  error: "TAP TO RETRY",
  listen: "LISTENING…",
  await: "TAP · ADD SCREENSHOTS",
};
let thinkTimer;
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.state = mode;
  ui.hint.textContent = HINTS[mode] ?? "";
  ui.consoleState.textContent = mode.toUpperCase();
  clearInterval(thinkTimer);
  if (mode === "think") {
    const started = Date.now();
    thinkTimer = setInterval(() => {
      ui.consoleState.textContent = `ANALYSING ${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);
  }
  rings.target = { boot: 1, idle: 1, auth: 2.5, scan: 4, think: 7, ready: 1.4, apply: 5, done: 1.2, error: 0.4, listen: 3, await: 1.6 }[mode] ?? 1;
}

function setChip(id, cls) {
  const chip = $(id);
  chip.classList.remove("on", "warn", "bad", "busy");
  if (cls) chip.classList.add(cls);
}

function setStats({ hearings, moved, pending } = {}) {
  if (hearings !== undefined) $("#statHearings").textContent = hearings;
  if (moved !== undefined) $("#statMoved").textContent = moved;
  if (pending !== undefined) $("#statPending").textContent = pending;
}

// ---------- voice ----------
let voicePick;
function pickVoice() {
  if (voicePick !== undefined) return voicePick;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const prefer = ["Daniel", "Google UK English Male", "Arthur", "Oliver", "Rishi", "Microsoft Ryan"];
  voicePick =
    prefer.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean) ||
    voices.find((v) => v.lang === "en-GB") ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null;
  return voicePick;
}
function speak(text) {
  if (!state.voice || !("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.03;
    u.pitch = 0.82;
    u.onstart = () => (rings.talking = true);
    u.onend = u.onerror = () => (rings.talking = false);
    speechSynthesis.speak(u);
  } catch {}
}

// ---------- server API ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(state.passcode && { "x-clerak-passcode": state.passcode }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) openSheet("settings");
    throw new Error(data.error || `Server error ${res.status}`);
  }
  return data;
}

// ---------- Google sign-in (OAuth redirect: works in Safari and in the home-screen app) ----------
function googleToken() {
  const g = store.get("google", null);
  return g && g.exp > Date.now() ? g.token : null;
}

function beginGoogleLogin() {
  const nonce = crypto.randomUUID();
  store.set("oauthState", nonce);
  const params = new URLSearchParams({
    client_id: state.config.googleClientId,
    redirect_uri: `${location.origin}/`,
    response_type: "token",
    scope: GOOGLE_SCOPES,
    include_granted_scopes: "true",
    state: nonce,
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

function captureGoogleRedirect() {
  if (!location.hash) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has("access_token") && !p.has("error")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  if (p.get("error")) return { error: `Google sign-in cancelled (${p.get("error")}).` };
  if (p.get("state") !== store.get("oauthState", null)) return { error: "Google sign-in check failed. Try again." };
  store.del("oauthState");
  const expiresIn = Number(p.get("expires_in")) || 3600;
  store.set("google", { token: p.get("access_token"), exp: Date.now() + (expiresIn - 60) * 1000 });
  return { ok: true };
}

async function gcal(path, { method = "GET", body, query } = {}) {
  const token = googleToken();
  if (!token) throw new Error("Google link expired. Tap the core to reconnect.");
  const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401) {
    store.del("google");
    setChip("#chipGoogle", "warn");
    throw new Error("Google link expired. Tap the core to reconnect.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Google Calendar: ${data?.error?.message || res.status}`);
  return data;
}

const calPath = () => `calendars/${encodeURIComponent(state.calendarId)}/events`;
const eventDay = (e) => e.start?.date ?? localISO(new Date(e.start.dateTime));

async function loadEvents(force = false) {
  if (!force && state.eventsFor === `${state.calendarId}|${state.boardDate}`) return state.events;
  const [y, m, d] = state.boardDate.split("-").map(Number);
  const data = await gcal(calPath(), {
    query: {
      timeMin: new Date(y, m - 1, d).toISOString(),
      timeMax: new Date(y, m - 1, d + 1).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    },
  });
  state.events = (data.items ?? []).filter((e) => e.status !== "cancelled" && eventDay(e) === state.boardDate);
  state.eventsFor = `${state.calendarId}|${state.boardDate}`;
  setStats({ hearings: state.events.length });
  return state.events;
}

function shiftedTimes(event, newDate) {
  const shift = daysBetween(eventDay(event), newDate);
  if (event.start.date) {
    return {
      start: { date: addDays(event.start.date, shift) },
      end: { date: addDays(event.end.date, shift) },
    };
  }
  const move = (t) => ({
    dateTime: new Date(new Date(t.dateTime).getTime() + shift * 86400000).toISOString(),
    ...(t.timeZone && { timeZone: t.timeZone }),
  });
  return { start: move(event.start), end: move(event.end) };
}

async function moveEvent(event, newDate) {
  const before = { start: event.start, end: event.end };
  const updated = await gcal(`${calPath()}/${encodeURIComponent(event.id)}`, {
    method: "PATCH",
    body: shiftedTimes(event, newDate),
  });
  rememberUndo({ id: event.id, title: event.summary, ...before });
  return updated;
}

// Every move is recorded so "Undo last update" can put hearings back.
function rememberUndo(entry) {
  const undo = store.get("undo", null);
  const key = `${state.calendarId}|${state.boardDate}`;
  const run = undo?.key === key ? undo : { key, calendarId: state.calendarId, moves: [] };
  run.moves = run.moves.filter((m) => m.id !== entry.id).concat(entry);
  store.set("undo", run);
}

async function undoLast() {
  const run = store.get("undo", null);
  if (!run?.moves?.length) return log("Nothing to undo.", "dim");
  closeSheets();
  setMode("apply");
  log(`Reverting ${run.moves.length} hearing(s)…`);
  let ok = 0;
  for (const m of run.moves) {
    try {
      await gcal(`calendars/${encodeURIComponent(run.calendarId)}/events/${encodeURIComponent(m.id)}`, {
        method: "PATCH",
        body: { start: m.start, end: m.end },
      });
      ok++;
      log(`Restored: ${m.title}`, "ok");
    } catch (err) {
      log(`Could not restore ${m.title}: ${err.message}`, "err");
    }
  }
  store.del("undo");
  state.eventsFor = "";
  setMode("done");
  speak(`${ok} hearings restored.`);
}

// ---------- screenshots ----------
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read ${file.name || "a screenshot"}.`));
    };
    img.src = url;
  });
}

// ---------- the main mission ----------
function preflight() {
  if (!state.config.googleClientId) {
    setMode("error");
    log("GOOGLE_CLIENT_ID is not set on the server. See README → Setup.", "err");
    return false;
  }
  if (state.config.passcodeRequired && !state.passcode) {
    log("Enter your Clerak passcode in Settings first.", "warn");
    openSheet("settings");
    $("#passcodeInput").focus();
    return false;
  }
  if (!googleToken()) {
    setMode("auth");
    log("Linking Google Calendar…");
    speak("Linking your Google calendar.");
    setTimeout(beginGoogleLogin, 700);
    return false;
  }
  return true;
}

function onOrbTap() {
  if (state.busy) return;
  speak(""); // unlocks speech on iPhone while we still have the tap
  if (!preflight()) return;
  if (!state.config.aiReady) {
    log("ANTHROPIC_API_KEY is not set on the server. Use LIVE eCOURTS, or add the key.", "err");
    return;
  }
  log(`Select your eCourts "Todays Case List" screenshots (up to ${MAX_SCREENSHOTS}).`, "dim");
  const picker = $("#filePicker");
  picker.value = "";
  picker.click();
}

async function runMission(files) {
  if (!files.length) return;
  if (files.length > MAX_SCREENSHOTS) {
    log(`Using the first ${MAX_SCREENSHOTS} screenshots.`, "warn");
    files = files.slice(0, MAX_SCREENSHOTS);
  }
  state.busy = true;
  setMode("scan");
  setChip("#chipAI", "busy");
  log(`${files.length} screenshot(s) received. Syncing calendar for ${fmtShort(state.boardDate)}…`);
  try {
    const [images, events] = await Promise.all([Promise.all(files.map(shrinkImage)), loadEvents(true)]);
    setChip("#chipGoogle", "on");
    if (!events.length) {
      setMode("idle");
      setChip("#chipAI", "on");
      log(`No events in your calendar on ${fmtShort(state.boardDate)}. Change the board date in Settings if needed.`, "warn");
      speak("I found no hearings in your calendar for that day.");
      return;
    }
    log(`${events.length} hearings found in calendar.`, "ok");
    setMode("think");
    speak(`${events.length} hearings found. Reading the eCourts board.`);
    log("Reading eCourts board and cross-referencing case numbers…");

    const plan = await api("/api/analyze", {
      images,
      boardDate: state.boardDate,
      events: events.map((e) => ({ id: e.id, title: e.summary ?? "", location: e.location ?? "", notes: e.description ?? "" })),
    });
    state.plan = plan;
    setChip("#chipAI", "on");
    const moves = plan.items.filter((i) => i.status === "move").length;
    const needYou = plan.items.length - moves;
    setStats({ moved: 0, pending: needYou });
    log(`Analysis complete: ${moves} new date(s) found, ${needYou} need your attention.`, moves ? "ok" : "warn");
    if (plan.listDateMismatch) log(`Heads up: screenshots show the list for ${fmtShort(plan.listDate)}.`, "warn");
    renderPlan();
    setMode("ready");
    $("#btnReview").disabled = false;
    $("#btnReview").classList.add("attn");
    speak(`I found ${moves} new dates. Say engage to apply them, or review to hear them.`);
    openSheet("plan");
  } catch (err) {
    setMode("error");
    setChip("#chipAI", "bad");
    log(err.message, "err");
    speak("Something went wrong. Check the terminal.");
  } finally {
    state.busy = false;
    if (state.plan) updateEngage();
  }
}

// ---------- mission brief ----------
const eventById = (id) => state.events.find((e) => e.id === id);

function renderPlan() {
  const plan = state.plan;
  const list = $("#planList");
  list.replaceChildren();
  $("#planTitle").textContent = `Hearings of ${fmtShort(state.boardDate)}`;

  const warn = $("#planWarn");
  warn.hidden = !plan.listDateMismatch;
  if (plan.listDateMismatch) {
    warn.textContent = `These screenshots show the case list for ${fmtShort(plan.listDate)}, but you are updating ${fmtShort(state.boardDate)}. Check before engaging.`;
  }

  const order = { move: 0, not_updated: 1, unmatched: 2 };
  const items = [...plan.items].sort((a, b) => order[a.status] - order[b.status]);
  for (const item of items) {
    const ev = eventById(item.eventId);
    if (!ev) continue;
    const li = document.createElement("li");
    li.className = `plan-item ${item.status === "move" ? "move" : "skip"} ${item.confidence ?? ""}`;
    li.dataset.eventId = item.eventId;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "plan-check";
    check.setAttribute("aria-label", `Move ${ev.summary}`);
    check.disabled = item.status !== "move";
    check.checked = item.status === "move" && item.confidence !== "low";

    const main = document.createElement("div");
    main.className = "plan-main";
    const title = document.createElement("div");
    title.className = "plan-title";
    title.textContent = ev.summary || "(no title)";
    const meta = document.createElement("div");
    meta.className = "plan-meta";
    meta.textContent = [item.caseNumber, item.stage, item.caseNumber ? "" : ev.location].filter(Boolean).join(" · ");
    const tag = document.createElement("span");
    const tagText = {
      move: `${(item.confidence || "").toUpperCase()} MATCH`,
      not_updated: "NOT UPDATED ON eCOURTS",
      unmatched: "NOT ON BOARD",
    }[item.status];
    tag.className = `plan-tag ${item.status === "move" ? item.confidence : "wait"}`;
    tag.textContent = tagText;
    tag.title = item.reason ?? "";
    const reason = document.createElement("div");
    reason.className = "plan-meta";
    reason.textContent = item.reason ?? "";
    main.append(title, meta, tag, reason);

    const date = document.createElement("div");
    date.className = "plan-date";
    const from = document.createElement("span");
    from.className = "plan-from";
    from.textContent = fmtShort(state.boardDate);
    const to = document.createElement("input");
    to.type = "date";
    to.className = "plan-to";
    to.value = item.newDate ?? "";
    to.min = addDays(state.boardDate, 1);
    to.disabled = item.status !== "move";
    to.setAttribute("aria-label", `New date for ${ev.summary}`);
    to.addEventListener("change", () => {
      item.newDate = to.value;
      check.checked = Boolean(to.value);
      updateEngage();
    });
    check.addEventListener("change", updateEngage);
    date.append(from);
    if (item.newDate) date.append(to);

    li.append(check, main, date);
    list.append(li);
  }

  const extra = plan.unmatchedCases ?? [];
  $("#extraCases").hidden = extra.length === 0;
  $("#extraSummary").textContent = `${extra.length} case(s) on eCourts board but not in this calendar`;
  $("#extraList").replaceChildren(
    ...extra.map((c) => {
      const li = document.createElement("li");
      li.textContent = `${c.caseNumber} — ${c.parties}${c.nextDate ? ` → ${fmtShort(c.nextDate)}` : ""}`;
      return li;
    }),
  );
  updateEngage();
}

function selectedMoves() {
  return [...document.querySelectorAll("#planList .plan-item")]
    .filter((li) => $(".plan-check", li).checked && !li.classList.contains("done"))
    .map((li) => ({ li, item: state.plan.items.find((i) => i.eventId === li.dataset.eventId) }))
    .filter(({ item }) => item?.newDate && item.newDate > state.boardDate);
}

function updateEngage() {
  const n = selectedMoves().length;
  const btn = $("#btnEngage");
  btn.disabled = n === 0 || state.busy;
  const anyDone = Boolean(document.querySelector("#planList .plan-item.done"));
  btn.textContent = n ? `ENGAGE · MOVE ${n}` : anyDone ? "ALL UPDATED ✓" : "NOTHING SELECTED";
}

async function engage() {
  const moves = selectedMoves();
  if (!moves.length || state.busy) return;
  state.busy = true;
  updateEngage();
  setMode("apply");
  speak(`Engaging. Moving ${moves.length} hearings.`);
  log(`Updating ${moves.length} hearing(s) in Google Calendar…`);
  let done = 0;
  for (const { li, item } of moves) {
    const ev = eventById(item.eventId);
    const tag = $(".plan-tag", li);
    try {
      await moveEvent(ev, item.newDate);
      done++;
      li.classList.add("done");
      $(".plan-check", li).disabled = true;
      $(".plan-to", li).disabled = true;
      tag.className = "plan-tag high";
      tag.textContent = "UPDATED ✓";
      log(`${ev.summary} → ${fmtShort(item.newDate)}`, "ok");
    } catch (err) {
      li.classList.add("failed");
      tag.className = "plan-tag fail";
      tag.textContent = "FAILED";
      log(`${ev.summary}: ${err.message}`, "err");
    }
  }
  state.busy = false;
  state.eventsFor = "";
  const total = Number($("#statMoved").textContent) || 0;
  setStats({ moved: total + done });
  setMode(done === moves.length ? "done" : "error");
  $("#btnReview").classList.remove("attn");
  updateEngage();
  log(`Mission complete. ${done} of ${moves.length} hearings moved. Say "undo" or tap UNDO to revert.`, done ? "ok" : "err");
  speak(done === moves.length ? `All done. ${done} hearings updated.` : `${done} of ${moves.length} hearings updated. Check the failures.`);
}

// ---------- live eCourts check ----------
const findCnr = (e) => {
  const m = `${e.description ?? ""} ${e.location ?? ""} ${e.summary ?? ""}`.match(CNR_PATTERN);
  return m ? m[0].toUpperCase() : "";
};

async function openLive() {
  if (state.busy) return;
  if (!preflight()) return;
  openSheet("live");
  const list = $("#liveList");
  list.replaceChildren(Object.assign(document.createElement("li"), { className: "live-item", textContent: "Syncing calendar…" }));
  try {
    const events = await loadEvents();
    setChip("#chipGoogle", "on");
    list.replaceChildren(...events.map(liveItem));
    if (!events.length) list.textContent = `No events on ${fmtShort(state.boardDate)}.`;
  } catch (err) {
    list.textContent = err.message;
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function liveItem(ev) {
  const li = el("li", { className: "live-item" });
  const result = el("div", { className: "live-result" });
  const row = el("div", { className: "live-row" });
  li.append(
    el("div", { className: "plan-title", textContent: ev.summary || "(no title)" }),
    el("div", { className: "plan-meta", textContent: ev.location || "" }),
    row,
    result,
  );

  const showCnr = () => {
    const cnr = findCnr(ev);
    row.replaceChildren();
    if (cnr) {
      const check = el("button", { className: "mini go", type: "button", textContent: "CHECK eCOURTS" });
      check.addEventListener("click", () => showCaptcha(cnr));
      row.append(el("span", { className: "live-cnr", textContent: cnr }), check);
    } else {
      const input = el("input", {
        type: "text",
        placeholder: "16-char CNR e.g. MHPU010012342023",
        maxLength: 16,
        autocapitalize: "characters",
        autocomplete: "off",
        spellcheck: false,
      });
      const save = el("button", { className: "mini go", type: "button", textContent: "SAVE CNR" });
      save.addEventListener("click", async () => {
        const cnr = input.value.trim().toUpperCase();
        if (!/^[A-Z]{4}\d{12}$/.test(cnr)) {
          result.className = "live-result err";
          result.textContent = "CNR is 4 letters + 12 digits (16 characters).";
          return;
        }
        save.disabled = true;
        try {
          const description = ev.description ? `${ev.description}\nCNR: ${cnr}` : `CNR: ${cnr}`;
          const updated = await gcal(`${calPath()}/${encodeURIComponent(ev.id)}`, { method: "PATCH", body: { description } });
          ev.description = updated.description;
          result.className = "live-result ok";
          result.textContent = "CNR saved in event notes.";
          showCnr();
        } catch (err) {
          result.className = "live-result err";
          result.textContent = err.message;
          save.disabled = false;
        }
      });
      row.append(input, save);
    }
  };

  const showCaptcha = async (cnr) => {
    result.className = "live-result";
    result.textContent = "Opening eCourts…";
    setChip("#chipCourts", "busy");
    let session;
    try {
      const data = await api("/api/ecourts/captcha");
      session = data.session;
      setChip("#chipCourts", "on");
      result.textContent = "";
      const img = el("img", { className: "captcha-img", src: data.captcha, alt: "eCourts captcha" });
      const code = el("input", { type: "text", placeholder: "Type captcha", maxLength: 6, autocomplete: "off", autocapitalize: "off", spellcheck: false });
      const go = el("button", { className: "mini go", type: "button", textContent: "VERIFY" });
      const again = el("button", { className: "mini", type: "button", textContent: "↻", ariaLabel: "New captcha" });
      again.addEventListener("click", () => showCaptcha(cnr));
      const submit = async () => {
        go.disabled = true;
        result.className = "live-result";
        result.textContent = "Asking eCourts…";
        try {
          const r = await api("/api/ecourts/case", { session, cnr, code: code.value });
          if (!r.ok) {
            result.className = "live-result err";
            result.textContent = r.error;
            if (r.retry) showCaptcha(cnr);
            return;
          }
          showCaseResult(cnr, r);
        } catch (err) {
          result.className = "live-result err";
          result.textContent = err.message;
          go.disabled = false;
        }
      };
      go.addEventListener("click", submit);
      code.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      row.replaceChildren(img, code, go, again);
      code.focus();
    } catch (err) {
      setChip("#chipCourts", "bad");
      result.className = "live-result err";
      result.textContent = err.message;
    }
  };

  const showCaseResult = (cnr, r) => {
    showCnr();
    const facts = [r.stage && `Stage: ${r.stage}`, r.court].filter(Boolean).join(" · ");
    if (r.disposed) {
      result.className = "live-result wait";
      result.textContent = `Case disposed${r.decisionDate ? ` on ${fmtShort(r.decisionDate)}` : ""}. ${facts}`;
      return;
    }
    if (!r.nextDate || r.nextDate <= state.boardDate) {
      result.className = "live-result wait";
      result.textContent = `eCourts next date: ${r.nextHearingText || "not set"} (not updated yet). ${facts}`;
      return;
    }
    result.className = "live-result ok";
    result.textContent = `Next hearing: ${fmtShort(r.nextDate)}. ${facts}`;
    const move = el("button", { className: "mini go", type: "button", textContent: `MOVE TO ${fmtShort(r.nextDate)}` });
    move.addEventListener("click", async () => {
      move.disabled = true;
      try {
        await moveEvent(ev, r.nextDate);
        move.textContent = "MOVED ✓";
        log(`${ev.summary} → ${fmtShort(r.nextDate)} (live eCourts)`, "ok");
        speak(`Moved to ${fmtSpoken(r.nextDate)}.`);
        setStats({ moved: (Number($("#statMoved").textContent) || 0) + 1 });
        state.eventsFor = "";
      } catch (err) {
        result.className = "live-result err";
        result.textContent = err.message;
        move.disabled = false;
      }
    });
    row.replaceChildren(move);
  };

  showCnr();
  return li;
}

// ---------- voice commands ----------
let recognizer = null;

function reply(text, kind = "") {
  log(`CLERAK: ${text}`, kind);
  speak(text);
}

function greeting() {
  const hour = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

const RECOGNITION_ERRORS = {
  "not-allowed": "Microphone is blocked. Allow the microphone for this site in your browser settings.",
  "service-not-allowed": "Speech recognition is off. On iPhone: Settings → General → Keyboard → Enable Dictation.",
  "no-speech": "I didn't hear anything. Tap the mic and speak.",
  "audio-capture": "No microphone found.",
  network: "Voice recognition needs an internet connection.",
};

function listen() {
  if (recognizer) {
    recognizer.stop();
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    reply("Voice input isn't available in this browser. Open Clerak in Safari or Chrome.", "warn");
    return;
  }
  speak(""); // unlocks spoken replies on iPhone while we still have the tap
  const r = new Recognition();
  r.lang = "en-IN";
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 3;
  const resume = state.mode;
  let heard = [];
  r.onstart = () => {
    setMode("listen");
    $("#btnMic").classList.add("live");
  };
  r.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    ui.hint.textContent = result[0].transcript.toUpperCase().slice(-26);
    if (result.isFinal) {
      heard = Array.from({ length: result.length }, (_, i) => result[i].transcript.trim()).filter(Boolean);
    }
  };
  r.onerror = (e) => {
    const msg = RECOGNITION_ERRORS[e.error];
    if (msg) log(msg, e.error === "no-speech" ? "dim" : "err");
  };
  r.onend = () => {
    recognizer = null;
    $("#btnMic").classList.remove("live");
    if (state.mode === "listen") setMode(["boot", "listen", "error"].includes(resume) ? "idle" : resume);
    if (heard.length) handleCommand(heard);
  };
  recognizer = r;
  try {
    r.start();
  } catch (err) {
    recognizer = null;
    log(`Mic error: ${err.message}`, "err");
  }
}

function spokenDay(text) {
  const today = localISO(new Date());
  if (/\bday after tomorrow\b/.test(text)) return addDays(today, 2);
  if (/\btomorrow\b/.test(text)) return addDays(today, 1);
  if (/\byesterday\b/.test(text)) return addDays(today, -1);
  if (/\b(today|aaj)\b/.test(text)) return today;
  return "";
}

function voiceUpdate() {
  if (!preflight()) return;
  if (!state.config.aiReady) {
    reply("My AI key is missing on the server. Add ANTHROPIC_API_KEY in Vercel.", "err");
    return;
  }
  setMode("await");
  reply(`On it. Tap the core and pick your eCourts screenshots for ${fmtSpoken(state.boardDate)}.`);
}

function voiceEngage() {
  if (!state.plan) return reply('There is nothing to engage yet. Say "update the dates" first.');
  if (!selectedMoves().length) return reply("Nothing is waiting to move. The ready hearings are already updated.");
  openSheet("plan");
  engage();
}

function voiceReview() {
  if (!state.plan) return reply('Nothing to review yet. Say "update the dates" first.');
  openSheet("plan");
  const moves = state.plan.items.filter((i) => i.status === "move" && eventById(i.eventId));
  const need = state.plan.items.length - moves.length;
  const spoken = moves.slice(0, 5).map((i) => `${eventById(i.eventId).summary} to ${fmtSpoken(i.newDate)}`);
  const more = moves.length > 5 ? `, and ${moves.length - 5} more` : "";
  reply(
    `${moves.length} hearings can move${spoken.length ? `: ${spoken.join(", ")}${more}` : ""}. ` +
      `${need} need your attention. Say engage to apply.`,
  );
}

async function voiceStatus() {
  if (!googleToken()) return reply('Your Google calendar is not linked yet. Say "update the dates" to link it.');
  try {
    const events = await loadEvents();
    let msg = `${events.length} hearings in your calendar for ${fmtSpoken(state.boardDate)}.`;
    if (state.plan) {
      const moved = Number($("#statMoved").textContent) || 0;
      const need = state.plan.items.filter((i) => i.status !== "move").length;
      msg += ` ${moved} updated, ${selectedMoves().length} ready to move, ${need} need your attention.`;
    }
    reply(msg);
  } catch (err) {
    reply(err.message, "err");
  }
}

const COMMANDS = [
  {
    test: /\b(stop|cancel|quiet|silence|never ?mind|bas|ruko)\b/,
    run: () => {
      closeSheets();
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      log("Standing by.", "dim");
    },
  },
  {
    test: /\b(help|what can you do|commands?)\b/,
    run: () =>
      reply(
        'Say "update the dates" to start. Then "engage" to move them, "review" to hear the list, ' +
          '"status" for a summary, "undo" to put them back, or "live check" for eCourts by CNR. ' +
          'You can add "tomorrow" or "yesterday" to change the day.',
      ),
  },
  { test: /\b(undo|revert|restore|put (them|it) back|wapas|vapas)\b/, run: () => { reply("Reverting the last update."); undoLast(); } },
  { test: /\b(review|brief|read|show( me)?( the)? (list|plan|dates|cases))\b/, run: voiceReview },
  { test: /\b(engage|confirm|apply|go ahead|proceed|yes|do it|move (them|all|it)|haan|kar do)\b/, run: voiceEngage },
  { test: /\b(live|cnr|captcha|e ?courts? (check|link|site|website))\b/, run: () => { reply("Opening the live eCourts link."); openLive(); } },
  { test: /\b(settings?|setup|passcode)\b/, run: () => { reply("Opening settings."); openSheet("settings"); } },
  { test: /\b(status|report|summary|how many|kitne|pending)\b/, run: voiceStatus },
  {
    test: /\b(update|start|begin|run|sync|scan|dates?|hearings?|tarikh|taarikh|tareekh|badlo|screenshots?|calendar)\b/,
    run: voiceUpdate,
  },
  {
    test: /\b(hello|hi|hey|namaste|namaskar|good (morning|afternoon|evening)|clerak|clerk)\b/,
    run: () => reply(`${greeting()}. Ready when you are. Say "update the dates".`),
  },
];

function handleCommand(alternatives) {
  log(`YOU: "${alternatives[0]}"`, "dim");
  if (state.busy) return reply("One moment, I'm still working.");
  for (const text of alternatives.map((t) => t.toLowerCase())) {
    const day = spokenDay(text);
    if (day && /\b(change|set|switch|board|make it)\b/.test(text) && !/\b(update|start|run|scan)\b/.test(text)) {
      setBoardDate(day);
      return reply(`Board date set to ${fmtSpoken(day)}.`);
    }
    const cmd = COMMANDS.find((c) => c.test.test(text));
    if (cmd) {
      if (day && day !== state.boardDate) {
        setBoardDate(day);
        log(`Board date: ${fmtShort(day)}.`, "dim");
      }
      cmd.run();
      return;
    }
  }
  reply('Sorry, I didn\'t catch that. Say "update the dates", or "help".');
}

// ---------- sheets ----------
function openSheet(name) {
  closeSheets();
  $(`#${name}Sheet`).hidden = false;
}
function closeSheets() {
  document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeSheets();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheets());

// ---------- settings ----------
function setBoardDate(iso) {
  if (!iso) return;
  state.boardDate = iso;
  state.eventsFor = "";
  state.plan = null;
  $("#btnReview").disabled = true;
  $("#boardDateText").textContent = fmtShort(iso);
  $("#boardDateInput").value = iso;
  setStats({ hearings: "--", pending: "--" });
}

async function loadCalendars() {
  try {
    const data = await gcal("users/me/calendarList", { query: { minAccessRole: "writer" } });
    const select = $("#calendarSelect");
    select.replaceChildren(
      ...(data.items ?? []).map((c) => el("option", { value: c.primary ? "primary" : c.id, textContent: c.summaryOverride || c.summary })),
    );
    select.value = state.calendarId;
    if (select.value !== state.calendarId) select.value = "primary";
  } catch {}
}

function initSettings() {
  $("#boardDateInput").addEventListener("change", (e) => setBoardDate(e.target.value));
  $("#boardDateBtn").addEventListener("click", () => openSheet("settings"));
  $("#passcodeField").hidden = !state.config.passcodeRequired;
  const pass = $("#passcodeInput");
  pass.value = state.passcode;
  pass.addEventListener("change", () => {
    state.passcode = pass.value.trim();
    store.set("passcode", state.passcode);
  });
  const voice = $("#voiceToggle");
  voice.checked = state.voice;
  voice.addEventListener("change", () => {
    state.voice = voice.checked;
    store.set("voice", state.voice);
  });
  $("#calendarSelect").addEventListener("change", (e) => {
    state.calendarId = e.target.value;
    store.set("calendarId", state.calendarId);
    state.eventsFor = "";
  });
  $("#btnUndo").addEventListener("click", undoLast);
  const googleBtn = $("#btnGoogle");
  googleBtn.textContent = googleToken() ? "Disconnect Google" : "Connect Google";
  googleBtn.addEventListener("click", () => {
    if (googleToken()) {
      store.del("google");
      googleBtn.textContent = "Connect Google";
      setChip("#chipGoogle", "warn");
      log("Google disconnected.", "dim");
    } else {
      closeSheets();
      preflight();
    }
  });
}

// ---------- the reactor rings ----------
const rings = {
  groups: [],
  angle: [],
  speed: 1,
  target: 1,
  talking: false,
  bars: [],
};

function buildRings() {
  const svg = $("#rings");
  const NS = "http://www.w3.org/2000/svg";
  rings.groups = [...svg.querySelectorAll(".ring")];
  rings.angle = rings.groups.map(() => Math.random() * 360);

  const markers = $("#markers");
  for (let i = 0; i < 3; i++) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M0 -206 L7 -196 L-7 -196 Z");
    p.setAttribute("transform", `rotate(${i * 120})`);
    markers.append(p);
  }

  const bars = $("#bars");
  const COUNT = 72;
  for (let i = 0; i < COUNT; i++) {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", "-1.4");
    r.setAttribute("y", "-222");
    r.setAttribute("width", "2.8");
    r.setAttribute("height", "10");
    r.setAttribute("transform", `rotate(${(i * 360) / COUNT})`);
    bars.append(r);
    rings.bars.push({ el: r, h: 4 });
  }
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let lastFrame = performance.now();
function animateRings(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  rings.speed += (rings.target - rings.speed) * Math.min(1, dt * 2.2);
  const k = reducedMotion ? 0.15 : rings.speed;
  rings.groups.forEach((g, i) => {
    rings.angle[i] = (rings.angle[i] + Number(g.dataset.speed) * k * dt) % 360;
    g.setAttribute("transform", `rotate(${rings.angle[i].toFixed(2)})`);
  });

  const energetic = rings.talking || ["think", "scan", "apply", "listen"].includes(state.mode);
  for (const [i, b] of rings.bars.entries()) {
    const wave = (Math.sin(now / 260 + i * 0.5) + 1) * 0.5;
    const goal = energetic && !reducedMotion ? 4 + Math.random() * 16 + wave * 6 : 3 + wave * 4;
    b.h += (goal - b.h) * 0.25;
    b.el.setAttribute("height", b.h.toFixed(1));
    b.el.setAttribute("y", (-208 - b.h).toFixed(1));
  }
  requestAnimationFrame(animateRings);
}

// ---------- ambient particles ----------
function startParticles() {
  const canvas = $("#particles");
  const ctx = canvas.getContext("2d");
  let w, h, dots;
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = canvas.width = innerWidth * dpr;
    h = canvas.height = innerHeight * dpr;
    dots = Array.from({ length: 46 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25 * dpr,
      vy: (Math.random() - 0.5) * 0.25 * dpr,
      r: (Math.random() * 1.4 + 0.4) * dpr,
    }));
  };
  resize();
  addEventListener("resize", resize);
  const color = () => getComputedStyle(document.body).getPropertyValue("--glow").trim() || "#22e4ff";
  let glow = color();
  setInterval(() => (glow = color()), 800);
  const frame = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = glow;
    ctx.strokeStyle = glow;
    const boost = reducedMotion ? 0 : Math.min(4, rings.speed);
    for (const d of dots) {
      d.x = (d.x + d.vx * (1 + boost) + w) % w;
      d.y = (d.y + d.vy * (1 + boost) + h) % h;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    const near = (w / 7) ** 2;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dx = dots[i].x - dots[j].x;
        const dy = dots[i].y - dots[j].y;
        const dist = dx * dx + dy * dy;
        if (dist < near) {
          ctx.globalAlpha = 0.12 * (1 - dist / near);
          ctx.beginPath();
          ctx.moveTo(dots[i].x, dots[i].y);
          ctx.lineTo(dots[j].x, dots[j].y);
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function startClock() {
  const tick = () => {
    $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- boot ----------
async function boot() {
  buildRings();
  requestAnimationFrame(animateRings);
  startParticles();
  startClock();
  setMode("boot");
  setBoardDate(state.boardDate);
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => (voicePick = undefined);

  const redirect = captureGoogleRedirect();

  log("CLERAK v1.0 — legal operations intelligence online.");
  try {
    state.config = await api("/api/config");
  } catch {
    log("Server unreachable. Check your internet connection.", "err");
  }
  initSettings();

  log(`Board date: ${fmtShort(state.boardDate)}.`, "dim");
  setChip("#chipAI", state.config.aiReady ? "on" : "bad");
  setChip("#chipCourts", "on");
  if (redirect?.error) log(redirect.error, "err");
  if (googleToken()) {
    setChip("#chipGoogle", "on");
    log(redirect?.ok ? "Google Calendar link established." : "Google Calendar linked.", "ok");
    loadCalendars();
    loadEvents()
      .then((ev) => log(`${ev.length} hearing(s) in calendar today.`, "dim"))
      .catch((err) => log(err.message, "warn"));
  } else {
    setChip("#chipGoogle", "warn");
  }
  if (!state.config.googleClientId) log("Setup needed: GOOGLE_CLIENT_ID is missing. See README.", "err");
  if (!state.config.aiReady) log("Setup needed: ANTHROPIC_API_KEY is missing. See README.", "err");

  setMode("idle");
  log(
    googleToken()
      ? "Tap the core and pick your eCourts screenshots."
      : "Tap the core to link Google Calendar.",
  );
  log('Or tap the mic and say "update the dates". Say "help" for all commands.', "dim");
  if (redirect?.ok) speak("Google calendar linked. Tap the core when ready.");
}

$("#orb").addEventListener("click", onOrbTap);
$("#filePicker").addEventListener("change", (e) => runMission([...e.target.files]));
$("#btnEngage").addEventListener("click", engage);
$("#btnReview").addEventListener("click", () => state.plan && openSheet("plan"));
$("#btnLive").addEventListener("click", openLive);
$("#btnSettings").addEventListener("click", () => openSheet("settings"));
$("#btnMic").addEventListener("click", listen);
$("#btnUndoDock").addEventListener("click", undoLast);

boot();
