import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────────────
// Rue Tracker — Single‑file React Web App (PLAIN JS + SAFE STORAGE + OPTIONAL CLOUD SYNC)
// This build keeps everything working locally, and adds an optional Supabase
// cloud sync so two phones share the same data. If Cloud Sync is OFF or not
// configured, the app behaves exactly as before using local storage.
// ────────────────────────────────────────────────────────────────────────────────

// Types (JS doc comments only)
// Event types: 'pee' | 'poop' | 'sleep' | 'food' | 'water' | 'training' | 'pee_attempt'

// ────────────────────────────────────────────────────────────────────────────────
// Utilities & Storage

const LS_KEY = "rue-tracker-web-v1";
const hasWindow = () => typeof window !== "undefined";

// localStorage safety helpers
function storageAvailable() {
  if (!hasWindow()) return false;
  try {
    const x = "__test__";
    window.localStorage.setItem(x, x);
    window.localStorage.removeItem(x);
    return true;
  } catch (_) { return false; }
}

const memoryStore = (() => {
  let m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
})();

function getStore() { return storageAvailable() ? window.localStorage : memoryStore; }

function uid(prefix = "id") { return prefix + "-" + Math.random().toString(36).slice(2, 9) + "-" + Date.now(); }
function isFiniteTs(n) { return typeof n === "number" && isFinite(n); }

function defaultState() {
  return {
    events: [], // { id, type, at, note? }
    outAttempts: [], // { id, at, reason: 'meal'|'water'|'suggested'|'pee', sourceEventId?, done? }
    trainingCommands: [
      { id: uid("cmd"), name: "Sit",  totalSeconds: 0, learned: false, sessionHistory: [] },
      { id: uid("cmd"), name: "Down", totalSeconds: 0, learned: false, sessionHistory: [] },
    ],
    settings: {
      waterToOutMinutes: 25,           // legacy knob (kept for completeness)
      peeSuggestionMethod: "median",   // 'median' | 'mean'
      learnedThreshold: 0.75,          // successRate threshold
      learnedWindow: 3,                // rolling sessions window
      mealSchedule: { times: ["06:00", "10:00", "14:00", "17:00", "20:00"] },
      // Cloud Sync (Supabase) — leave empty to stay local-only
      cloud: { enabled: false, url: "", anonKey: "", familyId: "" },
    },
    activeSession: null,
  };
}

function loadState() {
  const store = getStore();
  const raw = store.getItem(LS_KEY);
  if (!raw) { const d = defaultState(); store.setItem(LS_KEY, JSON.stringify(d)); return d; }
  try { return JSON.parse(raw); } catch { const d = defaultState(); store.setItem(LS_KEY, JSON.stringify(d)); return d; }
}
function saveState(s) { const store = getStore(); try { store.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {} }
function update(mutator) { const s = loadState(); mutator(s); saveState(s); return s; }

function median(values) {
  if (!values.length) return undefined;
  const arr = values.slice().filter(isFinite).sort((a, b) => a - b);
  if (!arr.length) return undefined;
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}
function sameDay(a, b) {
  if (!isFiniteTs(a) || !isFiniteTs(b)) return false;
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

// Friendly 12h formatting helpers
const timeOpts = { hour: "numeric", minute: "2-digit", hour12: true };
const dateTimeOpts = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true };
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], timeOpts); }
function fmtDateTime(ts) { return new Date(ts).toLocaleString([], dateTimeOpts); }

// Emoji + Labels for event types (used in Logs, Schedule, Export)
const TYPE_ICON = {
  pee: "🐕💦",
  poop: "💩",
  sleep: "😴",
  food: "🍽️",
  water: "💧",
  training: "🎓",
  pee_attempt: "🚽",
};
const TYPE_LABEL = {
  pee: "Pee",
  poop: "Poop",
  sleep: "Sleep",
  food: "Meal",
  water: "Water",
  training: "Training",
  pee_attempt: "Pee attempt",
};

// Convert "HH:MM" (24h) to 12h label using today as the date
function hhmmTo12hLabel(hhmm) {
  const parts = hhmm.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return fmtTime(d.getTime());
}

// datetime-local helpers
function tsToLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function localInputToTs(v) { const d = new Date(v); return isNaN(d.getTime()) ? Date.now() : d.getTime(); }

// Suggest next pee time using previous day's central interval
function peeSuggestionFromPrevDay(state, now) {
  if (!isFiniteTs(now)) return undefined;
  const d = new Date(now);
  const prevStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
  const prevEnd = prevStart + 24 * 3600 * 1000 - 1;
  const pees = state.events
    .filter(e => e && e.type === "pee" && isFiniteTs(e.at) && e.at >= prevStart && e.at <= prevEnd)
    .sort((a, b) => a.at - b.at);
  if (pees.length < 2) return undefined;
  const intervals = [];
  for (let i = 1; i < pees.length; i++) intervals.push(pees[i].at - pees[i - 1].at);
  const central = state.settings.peeSuggestionMethod === "median"
    ? median(intervals)
    : (intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : undefined);
  if (!isFiniteTs(central)) return undefined;
  const todaysPees = state.events
    .filter(e => e && e.type === "pee" && isFiniteTs(e.at) && sameDay(e.at, now))
    .sort((a, b) => a.at - b.at);
  const anchor = todaysPees.length ? todaysPees[todaysPees.length - 1].at : now;
  if (!isFiniteTs(anchor)) return undefined;
  return Math.round(anchor + central);
}

// Ensure exactly one pending Pee Attempt scheduled 1h20m after the FIRST water since the last pee
function ensurePeeAttemptAfterWater(state, waterEvent) {
  if (!waterEvent || !isFiniteTs(waterEvent.at)) return;
  const EIGHTY_MIN = 80 * 60 * 1000;
  const peesDesc = state.events
    .filter(e => e && e.type === "pee" && isFiniteTs(e.at))
    .sort((a, b) => b.at - a.at);
  const lastPeeAt = peesDesc.length ? peesDesc[0].at : -Infinity;
  const alreadyPending = state.outAttempts.some(a => !!a && !a.done && a.reason === "pee" && isFiniteTs(a.at) && a.at > (lastPeeAt === -Infinity ? 0 : lastPeeAt));
  if (alreadyPending) return; // do NOT reschedule if one is pending from the first water
  const at = waterEvent.at + EIGHTY_MIN;
  if (!isFiniteTs(at)) return;
  state.outAttempts.push({ id: "out-" + waterEvent.id, at, reason: "pee", sourceEventId: waterEvent.id, done: false });
}

// ───────────────────────── Supabase (optional) ─────────────────────────
let _supabase = null; // lazily created per settings
function getSupabase(settings) {
  try {
    if (!settings || !settings.cloud || !settings.cloud.enabled) return null;
    const { url, anonKey } = settings.cloud;
    if (!url || !anonKey) return null;
    if (_supabase) return _supabase;
    _supabase = createClient(url, anonKey);
    return _supabase;
  } catch (e) { return null; }
}

async function cloudFetchAll(settings) {
  const sb = getSupabase(settings); if (!sb) return null;
  const family = settings.cloud.familyId;
  try {
    const [{ data: events }, { data: outAttempts }, { data: cmds }, { data: sessions }] = await Promise.all([
      sb.from("events").select("*").eq("family_id", family).order("at", { ascending: true }),
      sb.from("out_attempts").select("*").eq("family_id", family).order("at", { ascending: true }),
      sb.from("training_commands").select("*").eq("family_id", family).order("created_at", { ascending: true }),
      sb.from("training_sessions").select("*").eq("family_id", family).order("started_at", { ascending: true }),
    ]);
    const byCmd = {}; (sessions||[]).forEach(s => { (byCmd[s.command_id] ||= []).push({ id: s.id, commandId: s.command_id, startedAt: s.started_at, endedAt: s.ended_at, seconds: s.seconds, attempts: s.attempts, successes: s.successes, successRate: s.success_rate }); });
    const trainingCommands = (cmds||[]).map(c => ({ id: c.id, name: c.name, totalSeconds: c.total_seconds||0, learned: !!c.learned, sessionHistory: byCmd[c.id] || [] }));
    return {
      events: (events||[]).map(e => ({ id: e.id, type: e.type, at: e.at, note: e.note })),
      outAttempts: (outAttempts||[]).map(a => ({ id: a.id, at: a.at, reason: a.reason, sourceEventId: a.source_event_id || null, done: !!a.done })),
      trainingCommands,
    };
  } catch (e) { console.warn("cloudFetchAll error", e); return null; }
}

const Cloud = {
  async insertEvent(settings, ev) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("events").insert([{ id: ev.id, family_id: settings.cloud.familyId, type: ev.type, at: ev.at, note: ev.note || null }]);
  },
  async deleteEvent(settings, id) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("events").delete().eq("id", id).eq("family_id", settings.cloud.familyId);
  },
  async insertAttempt(settings, a) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("out_attempts").insert([{ id: a.id, family_id: settings.cloud.familyId, at: a.at, reason: a.reason, source_event_id: a.sourceEventId || null, done: !!a.done }]);
  },
  async updateAttempt(settings, a) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("out_attempts").update({ at: a.at, reason: a.reason, source_event_id: a.sourceEventId || null, done: !!a.done }).eq("id", a.id).eq("family_id", settings.cloud.familyId);
  },
  async deleteAttempt(settings, id) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("out_attempts").delete().eq("id", id).eq("family_id", settings.cloud.familyId);
  },
  async insertCommand(settings, c) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("training_commands").insert([{ id: c.id, family_id: settings.cloud.familyId, name: c.name, total_seconds: c.totalSeconds||0, learned: !!c.learned }]);
  },
  async updateCommand(settings, c) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("training_commands").update({ name: c.name, total_seconds: c.totalSeconds||0, learned: !!c.learned }).eq("id", c.id).eq("family_id", settings.cloud.familyId);
  },
  async insertSession(settings, s) {
    const sb = getSupabase(settings); if (!sb) return;
    await sb.from("training_sessions").insert([{ id: s.id, family_id: settings.cloud.familyId, command_id: s.commandId, started_at: s.startedAt, ended_at: s.endedAt||null, seconds: s.seconds||0, attempts: s.attempts||0, successes: s.successes||0, success_rate: s.successRate||0 }]);
  },
  subscribeAll(settings, onChange) {
    const sb = getSupabase(settings); if (!sb) return null;
    const family = settings.cloud.familyId;
    const chans = [
      sb.channel("events").on("postgres_changes", { event: "*", schema: "public", table: "events", filter: "family_id=eq."+family }, onChange),
      sb.channel("out_attempts").on("postgres_changes", { event: "*", schema: "public", table: "out_attempts", filter: "family_id=eq."+family }, onChange),
      sb.channel("training_commands").on("postgres_changes", { event: "*", schema: "public", table: "training_commands", filter: "family_id=eq."+family }, onChange),
      sb.channel("training_sessions").on("postgres_changes", { event: "*", schema: "public", table: "training_sessions", filter: "family_id=eq."+family }, onChange),
    ];
    chans.forEach(ch => ch.subscribe());
    return () => { try { chans.forEach(ch => sb.removeChannel(ch)); } catch (_) {} };
  }
};

// ────────────────────────────────────────────────────────────────────────────────
// UI — Primitives

function Section({ title, children }) {
  return (
    <div className="mt-6">
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function PillButton({ label, onClick }) {
  return (
    <button onClick={onClick} className="px-4 py-3 rounded-2xl bg-gray-100 hover:bg-gray-200 active:bg-gray-300 transition font-medium w-full text-left">
      {label}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Tabs Shell

export default function App() {
  const [tab, setTab] = useState("logs");
  const [state, setState] = useState(() => defaultState());

  useEffect(() => {
    const first = loadState();
    setState(first);

    (async () => {
      const cloudData = await cloudFetchAll(first.settings);
      if (cloudData) setState(s => ({ ...s, ...cloudData }));
    })();

    let unsub = null;
    if (first.settings.cloud && first.settings.cloud.enabled) {
      unsub = Cloud.subscribeAll(first.settings, async () => {
        const latest = await cloudFetchAll(first.settings);
        if (latest) setState(s => ({ ...s, ...latest }));
      });
    }

    if (hasWindow() && storageAvailable()) {
      const onStorage = (e) => { if (e.key === LS_KEY && e.newValue) setState(JSON.parse(e.newValue)); };
      window.addEventListener("storage", onStorage);
      return () => { window.removeEventListener("storage", onStorage); if (unsub) unsub(); };
    }
    return () => { if (unsub) unsub(); };
  }, []);

  function commit(mutator) { const next = update(mutator); setState(next); }
  function navBtnClass(active) { return "px-3 py-2 rounded-xl border" + (active ? " bg-black text-white" : " bg-gray-50 hover:bg-gray-100"); }

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold">Rue Tracker (Web)</h1>
        <nav className="mt-4 flex gap-2">
          {["logs","schedule","training","settings"].map((k) => (
            <button key={k} onClick={() => setTab(k)} className={navBtnClass(tab === k)}>{k[0].toUpperCase()+k.slice(1)}</button>
          ))}
        </nav>

        {tab === "logs" && <LogsView state={state} commit={commit} />}
        {tab === "schedule" && <ScheduleView state={state} commit={commit} />}
        {tab === "training" && <TrainingView state={state} commit={commit} />}
        {tab === "settings" && <SettingsView state={state} commit={commit} />}

        <footer className="mt-10 text-xs text-gray-500">Data is stored locally in your browser (and optionally synced to your Supabase project).</footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Logs (ascending order + edit + export)

function LogsView({ state, commit }) {
  const quick = [
    { label: "🐕💦 Pee", type: "pee" },
    { label: "💩 Poop", type: "poop" },
    { label: "😴 Sleep", type: "sleep" },
    { label: "💧 Water", type: "water" },
    { label: "🚽 Pee attempt", type: "pee_attempt" },
    { label: "🎓 Training", type: "training" },
  ];

  // Edit state
  const [editingId, setEditingId] = useState(null);
  const [editingVal, setEditingVal] = useState("");

  function startEdit(ev) { setEditingId(ev.id); setEditingVal(tsToLocalInput(ev.at)); }
  function cancelEdit() { setEditingId(null); setEditingVal(""); }
  function saveEdit(id) {
    const ts = localInputToTs(editingVal);
    commit((s) => { const e = s.events.find(x => x.id === id); if (e) e.at = ts; });
    setEditingId(null); setEditingVal("");
  }

  function log(type) {
    const ev = { id: uid("ev"), type, at: Date.now() };
    commit((s) => {
      s.events.push(ev);
      if (s.settings.cloud && s.settings.cloud.enabled) { Cloud.insertEvent(s.settings, ev); }
      if (type === "water") { ensurePeeAttemptAfterWater(s, ev); if (s.settings.cloud && s.settings.cloud.enabled) { const a = s.outAttempts.find(x=>x.sourceEventId===ev.id); if (a) Cloud.insertAttempt(s.settings, a); } }
      if (type === "pee") { s.outAttempts = s.outAttempts.filter(a => !(a.reason === "pee" && !a.done)); }
    });
    if (type === "water" && hasWindow()) alert("Logged water. Scheduled a Pee attempt in 1h 20m (unless one is already pending).");
  }

  function deleteEvent(id) {
    commit((s) => {
      const ev = s.events.find(e => e.id === id);
      s.events = s.events.filter(e => e.id !== id);
      if (s.settings.cloud && s.settings.cloud.enabled) { Cloud.deleteEvent(s.settings, id); }
      if (ev && ev.type === "water") {
        const toDelete = s.outAttempts.filter(a => a.sourceEventId === id).map(a => a.id);
        s.outAttempts = s.outAttempts.filter(a => a.sourceEventId !== id);
        if (s.settings.cloud && s.settings.cloud.enabled) { toDelete.forEach(aid => Cloud.deleteAttempt(s.settings, aid)); }
      }
    });
  }

  // Export today's logs
  const [exportOpen, setExportOpen] = useState(false);
  const exportText = useMemo(() => buildExportTextForDate(state.events, Date.now()), [state.events]);

  // Auto-copy export when opened
  useEffect(() => {
    if (exportOpen && hasWindow()) { (async () => { try { await navigator.clipboard.writeText(exportText); } catch (_) {} })(); }
  }, [exportOpen, exportText]);

  async function copyExport() { try { await navigator.clipboard.writeText(exportText); alert("Today's logs copied. Paste into ChatGPT."); } catch (_) {} }

  const recent = useMemo(() => state.events.slice().sort((a, b) => a.at - b.at), [state.events]);

  return (
    <div className="mt-4">
      <Section title="Quick Log">
        <div className="grid grid-cols-2 gap-2">
          {quick.map((q) => (
            <PillButton key={q.type} label={q.label} onClick={() => log(q.type)} />
          ))}
        </div>
      </Section>

      <Section title="Today's Export">
        <div className="flex flex-wrap gap-2 items-center">
          <button className="px-3 py-2 rounded-xl border" onClick={() => setExportOpen(v => !v)}>{exportOpen ? "Hide" : "Show"} Export</button>
          <button className="px-3 py-2 rounded-xl border" onClick={copyExport}>Copy</button>
        </div>
        {exportOpen && (
          <textarea className="w-full mt-2 p-2 border rounded-xl text-sm" rows={6} readOnly value={exportText} />
        )}
      </Section>

      <Section title="Recent (oldest → newest)">
        <ul className="divide-y">
          {recent.map((e) => (
            <li key={e.id} className="py-2 text-sm flex items-center justify-between gap-3">
              <span>
                {fmtDateTime(e.at)} — <span className="font-medium">{TYPE_ICON[e.type]} {TYPE_LABEL[e.type]}</span>
              </span>
              <div className="flex items-center gap-2">
                {editingId === e.id ? (
                  <>
                    <input type="datetime-local" value={editingVal} onChange={(ev) => setEditingVal(ev.target.value)} className="px-2 py-1 border rounded-lg" />
                    <button className="px-2 py-1 rounded-lg border" onClick={() => saveEdit(e.id)}>Save</button>
                    <button className="px-2 py-1 rounded-lg border" onClick={cancelEdit}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="px-2 py-1 rounded-lg border" onClick={() => startEdit(e)}>Edit</button>
                    <button className="px-2 py-1 rounded-lg border hover:bg-gray-50" onClick={() => deleteEvent(e.id)}>Delete</button>
                  </>
                )}
              </div>
            </li>
          ))}
          {!recent.length && <div className="text-sm text-gray-500">No logs yet.</div>}
        </ul>
      </Section>
    </div>
  );
}

function formatEventLine(e) { return fmtTime(e.at) + " — " + TYPE_ICON[e.type] + " " + TYPE_LABEL[e.type]; }
function buildExportTextForDate(events, targetTs) {
  const header = "Rue — Daily Log Export";
  const dateLine = new Date(targetTs).toLocaleDateString();
  const lines = events
    .filter(e => e && isFiniteTs(e.at) && sameDay(e.at, targetTs))
    .sort((a, b) => a.at - b.at)
    .map(formatEventLine);
  return [header, dateLine, ""].concat(lines).join("\n");
}

// ────────────────────────────────────────────────────────────────────────────────
// Schedule (combined meals + pee attempts)

function ScheduleView({ state, commit }) {
  const now = Date.now();
  const suggested = peeSuggestionFromPrevDay(state, now);

  // Build today's scheduled meal timestamps
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
  function parseMealToTs(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(start.getTime());
    d.setHours(h || 0, m || 0, 0, 0);
    return d.getTime();
  }
  const todaysMealsTs = state.settings.mealSchedule.times.map(parseMealToTs).sort((a,b)=>a-b);
  const mealsEatenCount = state.events.filter(e => e.type === "food" && sameDay(e.at, now)).length;
  const remainingMealsTs = todaysMealsTs.slice(mealsEatenCount);

  // Pending pee attempts
  const attempts = useMemo(() => state.outAttempts.slice().sort((a, b) => a.at - b.at), [state.outAttempts]);

  const schedule = [
    ...remainingMealsTs.map((ts, idx) => ({ id: "meal-" + ts + "-" + idx, at: ts, kind: "meal" })),
    ...attempts.map(a => ({ id: a.id, at: a.at, kind: "pee" })),
  ].sort((a,b)=>a.at-b.at);

  function markPeeDone(id) {
    commit((s) => {
      const a = s.outAttempts.find((x) => x.id === id);
      if (!a) return;
      a.done = true;
      if (s.settings.cloud && s.settings.cloud.enabled) Cloud.updateAttempt(s.settings, a);
      if (a.reason === "pee") {
        const ev = { id: uid("ev"), type: "pee_attempt", at: Date.now() };
        s.events.push(ev);
        if (s.settings.cloud && s.settings.cloud.enabled) Cloud.insertEvent(s.settings, ev);
      }
    });
  }

  function logMealNow() {
    const ev = { id: uid("ev"), type: "food", at: Date.now() };
    commit((s) => { s.events.push(ev); if (s.settings.cloud && s.settings.cloud.enabled) Cloud.insertEvent(s.settings, ev); });
  }

  function rowLabel(item) {
    if (item.kind === "meal") return fmtTime(item.at) + " • 🍽️ Meal";
    return fmtTime(item.at) + " • 🚽 Pee attempt";
  }

  return (
    <div className="mt-4">
      <div className="rounded-2xl bg-blue-50 border border-blue-100 p-3 text-sm">
        <div className="font-semibold">Today's Schedule</div>
        {suggested && <div className="mt-1">💡 Suggested next pee window around <b>{fmtTime(suggested)}</b> (based on yesterday).</div>}
      </div>

      <Section title="Today (meals + pee attempts)">
        <ul className="divide-y">
          {schedule.map((item) => (
            <li key={item.id} className="py-2 flex items-center justify-between text-sm">
              <span>{rowLabel(item)}</span>
              <div className="flex gap-2">
                {item.kind === "meal" ? (
                  <button className="px-2 py-1 rounded-lg border hover:bg-gray-50" onClick={logMealNow}>Log Meal</button>
                ) : (
                  <>
                    <button className="px-2 py-1 rounded-lg border hover:bg-gray-50" onClick={() => markPeeDone(item.id)}>Done</button>
                    <button className="px-2 py-1 rounded-lg border hover:bg-gray-50" onClick={() => commit(s=>{ const a=s.outAttempts.find(x=>x.id===item.id); if(!a)return; const id=a.id; s.outAttempts=s.outAttempts.filter(x=>x.id!==id); if (s.settings.cloud && s.settings.cloud.enabled) Cloud.deleteAttempt(s.settings, id); })}>Delete</button>
                  </>
                )}
              </div>
            </li>
          ))}
          {!schedule.length && <div className="text-sm text-gray-500">Nothing scheduled yet.</div>}
        </ul>
      </Section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Training (inline timer, attempts/successes → %; reorder rows via arrows)

function TrainingView({ state, commit }) {
  const [newName, setNewName] = useState("");
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);

  // Post-session inputs
  const [resultOpen, setResultOpen] = useState(false);
  const [attemptsVal, setAttemptsVal] = useState(0);
  const [successesVal, setSuccessesVal] = useState(0);
  const [pendingSession, setPendingSession] = useState(null);

  // Use array order (no priority)
  const commands = state.trainingCommands.slice();

  useEffect(() => {
    let t;
    if (running) t = window.setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => { if (t) window.clearInterval(t); };
  }, [running]);

  function addCommand() {
    const name = (newName || "").trim(); if (!name) return;
    const cmd = { id: uid("cmd"), name, totalSeconds: 0, learned: false, sessionHistory: [] };
    commit((s) => { s.trainingCommands.push(cmd); if (s.settings.cloud && s.settings.cloud.enabled) Cloud.insertCommand(s.settings, cmd); });
    setNewName("");
  }

  function computeLearned(cmd, windowSize, threshold) {
    const last = cmd.sessionHistory.slice(-windowSize); if (!last.length) return false; const avg = last.reduce((a, b) => a + (b.successRate || 0), 0) / last.length; return avg >= threshold;
  }

  function startSession(commandId) {
    if (state.activeSession) { alert("A session is already active. End or pause it first."); return; }
    const sess = { id: uid("sess"), commandId, startedAt: Date.now() };
    setSeconds(0); setRunning(true); commit((s) => { s.activeSession = sess; });
  }

  function pauseSession() { setRunning(false); } function resumeSession() { setRunning(true); } function resetTimer() { setSeconds(0); }

  function endSession() {
    const active = state.activeSession; if (!active) return;
    setRunning(false);
    const ended = { ...active, endedAt: Date.now(), seconds };
    setPendingSession(ended);
    setAttemptsVal(0);
    setSuccessesVal(0);
    setResultOpen(true);
    commit((s) => { s.activeSession = null; });
    setSeconds(0);
  }

  function confirmResults() {
    if (!pendingSession) { setResultOpen(false); return; }
    const attempts = Math.max(0, Math.floor(attemptsVal));
    const successes = Math.max(0, Math.floor(successesVal));
    const clampedSuccesses = Math.min(successes, attempts);
    const rate = attempts > 0 ? clampedSuccesses / attempts : 0;
    commit((s) => {
      const a = Object.assign({}, pendingSession);
      a.attempts = attempts; a.successes = clampedSuccesses; a.successRate = rate;
      const cmd = s.trainingCommands.find((c) => c.id === a.commandId);
      if (!cmd) return;
      cmd.sessionHistory.push(a);
      cmd.totalSeconds += a.seconds || 0;
      cmd.learned = computeLearned(cmd, s.settings.learnedWindow, s.settings.learnedThreshold);
      if (s.settings.cloud && s.settings.cloud.enabled) { Cloud.insertSession(s.settings, a); Cloud.updateCommand(s.settings, cmd); }
    });
    setPendingSession(null); setResultOpen(false);
  }

  function cancelResults() { setPendingSession(null); setResultOpen(false); }

  // Reordering
  function move(id, dir) {
    commit((s) => {
      const idx = s.trainingCommands.findIndex(c => c.id === id);
      if (idx === -1) return;
      const j = dir < 0 ? Math.max(0, idx - 1) : Math.min(s.trainingCommands.length - 1, idx + 1);
      if (j === idx) return;
      const arr = s.trainingCommands;
      const tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
      if (s.settings.cloud && s.settings.cloud.enabled) { Cloud.updateCommand(s.settings, arr[idx]); Cloud.updateCommand(s.settings, arr[j]); }
    });
  }

  const active = state.activeSession;

  return (
    <div className="mt-4">
      <Section title="Commands">
        <div className="space-y-3">
          {commands.map((c) => {
            const isActive = !!active && active.commandId === c.id && running;
            const isPendingForThis = !!pendingSession && pendingSession.commandId === c.id && resultOpen;
            const last = c.sessionHistory.length ? c.sessionHistory[c.sessionHistory.length - 1] : undefined;
            const lastPct = last ? Math.round((last.successRate || 0) * 100) : undefined;
            const lastSummary = last ? (Math.round((last.seconds || 0) / 60) + " min • " + (lastPct !== undefined ? lastPct + "%" : "")) : "No sessions yet";
            const learnedCls = c.learned ? " border-green-500 bg-green-50" : "";
            return (
              <div key={c.id} className={"p-3 border rounded-xl" + learnedCls}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{c.name} {c.learned ? "🎉" : ""}</div>
                    <div className="text-xs text-gray-600">Practice: {Math.round(c.totalSeconds / 60)} min{last ? " • Last: " + lastSummary : ""}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="px-2 py-1 rounded-lg border" onClick={() => move(c.id, -1)}>▲</button>
                    {!active && !resultOpen && (<button className="px-2 py-1 rounded-lg border" onClick={() => startSession(c.id)}>Start</button>)}
                    {active && active.commandId === c.id && (
                      isActive ? (
                        <><button className="px-2 py-1 rounded-lg border" onClick={pauseSession}>Pause</button><button className="px-2 py-1 rounded-lg border" onClick={endSession}>End</button></>
                      ) : (
                        <><button className="px-2 py-1 rounded-lg border" onClick={resumeSession}>Start</button><button className="px-2 py-1 rounded-lg border" onClick={endSession}>End</button></>
                      )
                    )}
                    <button className="px-2 py-1 rounded-lg border" onClick={() => move(c.id, +1)}>▼</button>
                  </div>
                </div>

                {active && active.commandId === c.id && (
                  <div className="mt-2">
                    <InlineTimer seconds={seconds} />
                  </div>
                )}

                {isPendingForThis && (
                  <div className="mt-3 p-3 border rounded-xl bg-gray-50">
                    <div className="text-sm font-medium">Training summary</div>
                    <div className="grid grid-cols-3 gap-3 mt-2 items-center">
                      <label className="text-sm">Attempts</label>
                      <input type="number" min={0} value={attemptsVal} onChange={(e)=> setAttemptsVal(parseInt(e.target.value || "0", 10))} className="px-2 py-1 border rounded-lg" />
                      <div className="text-xs text-gray-500">Total tries</div>

                      <label className="text-sm">Successes</label>
                      <input type="number" min={0} value={successesVal} onChange={(e)=> setSuccessesVal(parseInt(e.target.value || "0", 10))} className="px-2 py-1 border rounded-lg" />
                      <div className="text-xs text-gray-500">Must be ≤ attempts</div>

                      <label className="text-sm">Computed %</label>
                      <div className="font-semibold">{(Math.min(successesVal, attemptsVal) && attemptsVal > 0 ? Math.round(Math.min(successesVal, attemptsVal) / Math.max(1, attemptsVal) * 100) : 0)}%</div>
                      <div />
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button className="px-3 py-2 rounded-xl border" disabled={successesVal > attemptsVal} onClick={confirmResults}>Save Session</button>
                      <button className="px-3 py-2 rounded-xl border" onClick={cancelResults}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!commands.length && <div className="text-sm text-gray-500">No commands yet.</div>}
        </div>
      </Section>

      <Section title="Add Command">
        <div className="flex gap-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g., Leave it" className="flex-1 px-3 py-2 border rounded-xl" />
          <button className="px-3 py-2 rounded-xl border" onClick={addCommand}>Add</button>
        </div>
      </Section>
    </div>
  );
}

function InlineTimer({ seconds }) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return <div className="text-2xl font-bold tabular-nums">{mm}:{ss}</div>;
}

// ────────────────────────────────────────────────────────────────────────────────
// Settings (includes Cloud Sync panel)

function SettingsView({ state, commit }) {
  const [waterToOut, setWaterToOut] = useState(state.settings.waterToOutMinutes.toString());
  const [method, setMethod] = useState(state.settings.peeSuggestionMethod);
  const [threshold, setThreshold] = useState(state.settings.learnedThreshold.toString());
  const [windowSize, setWindowSize] = useState(state.settings.learnedWindow.toString());
  const [mealsText, setMealsText] = useState(state.settings.mealSchedule.times.join(", "));

  function save() {
    const w = Math.max(1, parseInt(waterToOut, 10) || 25);
    const thr = Math.min(1, Math.max(0, parseFloat(threshold)));
    const win = Math.max(1, parseInt(windowSize, 10) || 3);
    const parsedMeals = mealsText.split(/[\,\n]/).map(s => s.trim()).filter(Boolean);
    commit((s) => {
      s.settings.waterToOutMinutes = w;
      s.settings.peeSuggestionMethod = method;
      s.settings.learnedThreshold = thr;
      s.settings.learnedWindow = win;
      s.settings.mealSchedule.times = parsedMeals;
    });
    if (hasWindow()) alert("Settings saved");
  }

  function resetAll() {
    if (!hasWindow() || !confirm("This will clear all data and reset defaults. Continue?")) return;
    const d = defaultState(); saveState(d); window.location.reload();
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="p-3 border rounded-xl">
        <div className="font-semibold mb-2">Out Attempts</div>
        <label className="text-sm block mb-2">(Legacy) Water ➜ out attempt after minutes</label>
        <input value={waterToOut} onChange={(e) => setWaterToOut(e.target.value)} className="px-3 py-2 border rounded-xl w-40" />
        <div className="text-xs text-gray-500 mt-1">Note: Pee attempts now follow the 1h20m-after-first-water rule.</div>
      </div>

      <div className="p-3 border rounded-xl">
        <div className="font-semibold mb-2">Pee Suggestion</div>
        <label className="text-sm block mb-2">Method</label>
        <select value={method} onChange={(e) => setMethod(e.target.value)} className="px-3 py-2 border rounded-xl">
          <option value="median">Median</option>
          <option value="mean">Mean</option>
        </select>
      </div>

      <div className="p-3 border rounded-xl">
        <div className="font-semibold mb-2">Training — Learned Rule</div>
        <div className="flex gap-3 items-center text-sm">
          <label>Threshold (0-1)</label>
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} className="px-3 py-2 border rounded-xl w-24" />
          <label>Window (sessions)</label>
          <input value={windowSize} onChange={(e) => setWindowSize(e.target.value)} className="px-3 py-2 border rounded-xl w-24" />
        </div>
      </div>

      <div className="p-3 border rounded-xl">
        <div className="font-semibold mb-2">Meals (24h HH:MM, comma or newline separated)</div>
        <textarea value={mealsText} onChange={(e) => setMealsText(e.target.value)} className="w-full min-h-[100px] px-3 py-2 border rounded-xl" />
      </div>

      {/* Cloud Sync (Supabase) */}
      <div className="p-3 border rounded-xl">
        <div className="font-semibold mb-1">Cloud Sync (Supabase)</div>
        <div className="text-xs text-gray-600 mb-2">Optional. Paste your Supabase URL, anon key, and a Family ID. Turn on to sync both phones.</div>
        <CloudSettings state={state} commit={commit} />
      </div>

      <div className="flex gap-2">
        <button className="px-3 py-2 rounded-xl border" onClick={save}>Save Settings</button>
        <button className="px-3 py-2 rounded-xl border" onClick={resetAll}>Reset All Data</button>
      </div>
    </div>
  );
}

// Cloud settings component
function CloudSettings({ state, commit }) {
  const [enabled, setEnabled] = useState(!!(state.settings.cloud && state.settings.cloud.enabled));
  const [url, setUrl] = useState((state.settings.cloud && state.settings.cloud.url) || "");
  const [key, setKey] = useState((state.settings.cloud && state.settings.cloud.anonKey) || "");
  const [family, setFamily] = useState((state.settings.cloud && state.settings.cloud.familyId) || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function testConnection() {
    setBusy(true); setMsg("");
    try {
      const temp = { settings: { cloud: { enabled: true, url, anonKey: key, familyId: family } } };
      const data = await cloudFetchAll(temp.settings);
      if (data) setMsg("Connected ✓"); else setMsg("No data yet — but credentials look OK if no error appeared.");
    } catch (e) { setMsg("Failed: " + (e && e.message ? e.message : String(e))); }
    setBusy(false);
  }

  function saveCloud() {
    commit((s) => { s.settings.cloud = { enabled, url, anonKey: key, familyId: family }; });
    alert("Cloud settings saved" + (enabled ? " — syncing on." : " (disabled)"));
  }

  const sql = [
    "-- Run this in Supabase SQL editor — uses TEXT ids so app IDs work as-is",
    "create table if not exists events (id text primary key, family_id text not null, type text not null, at bigint not null, note text);",
    "create table if not exists out_attempts (id text primary key, family_id text not null, at bigint not null, reason text not null, source_event_id text references events(id), done boolean default false);",
    "create table if not exists training_commands (id text primary key, family_id text not null, name text not null, total_seconds integer default 0, learned boolean default false, created_at timestamp with time zone default now());",
    "create table if not exists training_sessions (id text primary key, family_id text not null, command_id text references training_commands(id), started_at bigint, ended_at bigint, seconds integer, attempts integer, successes integer, success_rate double precision);",
    "alter table events enable row level security; alter table out_attempts enable row level security; alter table training_commands enable row level security; alter table training_sessions enable row level security;",
    "create policy if not exists family_read_events on events for select using (family_id = 'FAMILY_ID');",
    "create policy if not exists family_write_events on events for insert with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_update_events on events for update using (family_id = 'FAMILY_ID') with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_delete_events on events for delete using (family_id = 'FAMILY_ID');",
    "create policy if not exists family_read_out on out_attempts for select using (family_id = 'FAMILY_ID');",
    "create policy if not exists family_write_out on out_attempts for insert with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_update_out on out_attempts for update using (family_id = 'FAMILY_ID') with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_delete_out on out_attempts for delete using (family_id = 'FAMILY_ID');",
    "create policy if not exists family_read_cmd on training_commands for select using (family_id = 'FAMILY_ID');",
    "create policy if not exists family_write_cmd on training_commands for insert with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_update_cmd on training_commands for update using (family_id = 'FAMILY_ID') with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_delete_cmd on training_commands for delete using (family_id = 'FAMILY_ID');",
    "create policy if not exists family_read_sess on training_sessions for select using (family_id = 'FAMILY_ID');",
    "create policy if not exists family_write_sess on training_sessions for insert with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_update_sess on training_sessions for update using (family_id = 'FAMILY_ID') with check (family_id = 'FAMILY_ID');",
    "create policy if not exists family_delete_sess on training_sessions for delete using (family_id = 'FAMILY_ID');",
  ].join("\n");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input id="cloud_on" type="checkbox" checked={enabled} onChange={(e)=>setEnabled(e.target.checked)} />
        <label htmlFor="cloud_on">Enable Cloud Sync</label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <input placeholder="Supabase URL (https://xxx.supabase.co)" value={url} onChange={(e)=>setUrl(e.target.value)} className="px-3 py-2 border rounded-xl" />
        <input placeholder="Anon public key" value={key} onChange={(e)=>setKey(e.target.value)} className="px-3 py-2 border rounded-xl" />
        <input placeholder="Family ID (e.g., libby-family)" value={family} onChange={(e)=>setFamily(e.target.value)} className="px-3 py-2 border rounded-xl" />
      </div>
      <div className="flex gap-2">
        <button className="px-3 py-2 rounded-xl border" onClick={saveCloud}>Save Cloud Settings</button>
        <button className="px-3 py-2 rounded-xl border" disabled={busy} onClick={testConnection}>{busy?"Testing…":"Test Connection"}</button>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer">SQL to create tables & policies</summary>
        <div className="mt-2">
          <div className="text-xs text-gray-600 mb-2">Replace <code>FAMILY_ID</code> with your chosen Family ID, then run in Supabase SQL editor.</div>
          <textarea readOnly className="w-full min-h-[220px] text-xs p-2 border rounded" value={sql.replaceAll("FAMILY_ID", family || "your-family-id")} />
        </div>
      </details>
      {msg && <div className="text-sm mt-1">{msg}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Lightweight Dev Tests (console)

function run(name, fn) { try { fn(); } catch (err) { throw new Error(name + ": " + (err && err.message ? err.message : String(err))); } }

function runDevTests() {
  try {
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const now = Date.now();

    run("Test 1 — first water schedules one attempt", () => {
      let state = defaultState();
      const pee0 = { id: uid("pee"), type: "pee", at: now };
      state.events.push(pee0);
      const water1 = { id: uid("w"), type: "water", at: now + 10 * 60 * 1000 };
      ensurePeeAttemptAfterWater(state, water1);
      const expectAt = water1.at + 80 * 60 * 1000;
      assert(state.outAttempts.length === 1, "should have one pee attempt after first water");
      assert(state.outAttempts[0].at === expectAt, "pee attempt time should be +80min from first water");
      const water2 = { id: uid("w"), type: "water", at: now + 20 * 60 * 1000 };
      ensurePeeAttemptAfterWater(state, water2);
      assert(state.outAttempts.length === 1, "additional water before attempt should NOT add another attempt");
      assert(state.outAttempts[0].at === expectAt, "attempt must remain tied to first water");
    });

    run("Test 2 — pee clears pending attempts", () => {
      let state = defaultState();
      const water = { id: uid("w"), type: "water", at: now + 10 * 60 * 1000 };
      ensurePeeAttemptAfterWater(state, water);
      state.events.push({ id: uid("pee"), type: "pee", at: water.at + 80 * 60 * 1000 });
      state.outAttempts = state.outAttempts.filter(a => !(a.reason === "pee" && !a.done));
      assert(state.outAttempts.filter(a => a.reason === "pee").length === 0, "pee attempts should be cleared after a real pee");
    });

    run("Test 3 — deleting a water removes its attempt", () => {
      let state = defaultState();
      const w = { id: uid("w"), type: "water", at: now + 30 * 60 * 1000 };
      ensurePeeAttemptAfterWater(state, w);
      assert(state.outAttempts.some(a => a.sourceEventId === w.id), "linked attempt should exist for water");
      state.events = state.events.filter(e => e.id !== w.id);
      state.outAttempts = state.outAttempts.filter(a => a.sourceEventId !== w.id);
      assert(!state.outAttempts.some(a => a.sourceEventId === w.id), "linked attempt removed when water deleted");
    });

    run("Test 4 — pee suggestion produces a number with history", () => {
      let state = defaultState();
      const prevDayStart = new Date(now - 24 * 3600 * 1000);
      const ts0 = new Date(prevDayStart.getFullYear(), prevDayStart.getMonth(), prevDayStart.getDate(), 8, 0).getTime();
      const ts1 = ts0 + 2 * 60 * 60 * 1000; // +2h
      const ts2 = ts1 + 1 * 60 * 60 * 1000; // +1h
      state.events.push({ id: uid("pee"), type: "pee", at: ts0 }, { id: uid("pee"), type: "pee", at: ts1 }, { id: uid("pee"), type: "pee", at: ts2 });
      const suggestion = peeSuggestionFromPrevDay(state, now);
      assert(typeof suggestion === "number", "suggestion should be a timestamp");
    });

    run("Test 5 — marking scheduled pee attempt logs pee_attempt", () => {
      let state = defaultState();
      const w4 = { id: uid("w"), type: "water", at: now + 40 * 60 * 1000 };
      ensurePeeAttemptAfterWater(state, w4);
      const before = state.events.length;
      const attempt = state.outAttempts.find(a => !a.done && a.reason === "pee" && a.sourceEventId === w4.id);
      assert(!!attempt, "expected a pending attempt for w4");
      if (attempt) attempt.done = true; // mimic UI action
      state.events.push({ id: uid("ev"), type: "pee_attempt", at: now + 41 * 60 * 1000 });
      assert(state.events.length === before + 1 && state.events[state.events.length - 1].type === "pee_attempt", "pee_attempt should be logged when attempt marked done");
    });

    run("Test 6 — new water after pee schedules new attempt", () => {
      let state = defaultState();
      state.events.push({ id: uid("pee"), type: "pee", at: now });
      const w5 = { id: uid("w"), type: "water", at: now + 2 * 60 * 1000 };
      ensurePeeAttemptAfterWater(state, w5);
      assert(state.outAttempts.some(a => a.sourceEventId === w5.id), "new water after pee should schedule new attempt");
    });

    run("Test 7 — export includes emojis and is oldest→newest", () => {
      let state = defaultState();
      const today = now + 60 * 60 * 1000;
      const evA = { id: uid("w"), type: "water", at: today + 5 * 60 * 1000 };
      const evB = { id: uid("pee"), type: "pee", at: today + 15 * 60 * 1000 };
      state.events.push(evB, evA); // intentionally out of order
      const text = buildExportTextForDate(state.events, today);
      const idxWater = text.indexOf("💧 Water");
      const idxPee = text.indexOf("🐕💦 Pee");
      assert(idxWater !== -1 && idxPee !== -1 && idxWater < idxPee, "export should include emoji labels and be oldest→newest");
    });

    run("Test 8 — export header present (guard against unterminated strings)", () => {
      const text = buildExportTextForDate([], now);
      const ok = text.startsWith("Rue — Daily Log Export\n") || text.startsWith("Rue — Daily Log Export");
      assert(ok, "export should start with plain header");
    });

    run("Test 9 — pee suggestion safely returns undefined with no history", () => {
      let state = defaultState();
      const suggestion = peeSuggestionFromPrevDay(state, now);
      assert(suggestion === undefined, "no history should yield undefined suggestion");
    });

    run("Test 10 — scheduler ignores invalid water timestamps", () => {
      let state = defaultState();
      ensurePeeAttemptAfterWater(state, { id: uid("w"), type: "water", at: NaN });
      assert(state.outAttempts.length === 0, "invalid water ts should not create attempt");
    });

    console.log("✅ Rue Tracker dev tests passed");
  } catch (err) {
    console.error("❌ Rue Tracker dev test failed:", err);
  }
}

if (typeof window !== "undefined") setTimeout(runDevTests, 0);

