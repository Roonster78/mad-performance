/* MAD Boxenmauer: widget dashboard for training and race days.
   Vanilla JS, no build. State lives in localStorage; maps via Leaflet (vendor/),
   radar from RainViewer, forecast from Open-Meteo, OCR via Tesseract.js (loaded on demand). */
(() => {
'use strict';

const LS_KEY = 'mad-boxenmauer-v1';
const TRACKS = window.MAD_TRACKS || [];
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const fromMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const uid = () => Math.random().toString(36).slice(2, 9);
const fmtDur = mins => {
  const s = Math.max(0, Math.round(mins * 60));
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
};
const DAY_FMT = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const DAY_SHORT = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

// In-page confirmation (no confirm(): it is blocked inside embedded viewers). First click arms, second click runs.
function armConfirm(btn, label, action) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; action(); return; }
  btn.dataset.orig = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; } }, 4000);
}

/* ---------- Schedule vocabulary ---------- */
const KINDS = {
  session:     { label: 'Fahrzeit' },
  briefing:    { label: 'Fahrerbesprechung', mand: true },
  tyres:       { label: 'Reifen',            mand: true },
  transponder: { label: 'Transponder',       mand: true },
  papers:      { label: 'Papierabnahme',     mand: true },
  scrut:       { label: 'Techn. Abnahme',    mand: true },
  lunch:       { label: 'Pause' },
  rental:      { label: 'Leihkart' },
  other:       { label: 'Sonstiges' },
};
// Keyword sets in DE / EN / IT, checked in this order (first hit wins).
const KIND_RULES = [
  ['briefing',    /fahrerbesprech|briefing|riunione|drivers?.?meeting|besprechung/i],
  ['scrut',       /techn|scrutin|verifiche tec|abnahme.*tech|wiegen|parc ferm/i],
  ['papers',      /papier|dokument|administrat|verifiche sport|nennung|lizenz|einschreib|anmeld|registration|registrier|accredit/i],
  ['transponder', /transponder|trasponder|mylaps/i],
  ['tyres',       /reifen|tyre|tire|pneumatic|gomme/i],
  ['lunch',       /mittag|lunch|pausa|pause|break|essen/i],
  ['rental',      /leihkart|rental|noleggio|verleih|mietkart|indoor/i],
  ['session',     /training|practice|prove|qualif|quali|zeittrain|heat|manche|rennen|race|gara|finale?|warm.?up|lauf|session|turn|pre.?final|super.?heat|test/i],
];
const CLASS_RE = /\b(KZ2?\s?Masters?|X30\s?Masters?|Bambini|Baby|Mini\s?(?:ROK|X30|Max|60|GR3)?|X30\s?(?:Mini|Junior|Senior|Master|Shifter|Super\s?Shifter)?|OK-?N\s?(?:Junior|Senior|J|S)?|OK\s?(?:Junior|Senior|J|N)?|OKJ|OKN|KZ2?|KZ\s?2|Rotax\s?(?:Micro|Mini|Junior|Senior|Max|DD2|Masters?)?|DD2|ROK\s?\w*|IAME\s?\w*|Shifter\s?1[89]0\s?kg|Shifter|GKC\s?\d+|Schaltkart\w*|Junior|Senior|Masters?|Gentlemen|Super ?Heavy|Leihkart\w*)\b/i;

function classify(title) {
  for (const [k, re] of KIND_RULES) if (re.test(title)) return k;
  return 'other';
}
function detectClass(title) {
  const m = CLASS_RE.exec(title);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

/* Dates in schedule headers: "SATURDAY 03/10/2026", "Sa. 03.10.2026", "GIOVEDI' 12 NOVEMBRE 2026". */
const MONTHS = ['gen|jan|ene', 'feb|fév', 'mar|mär|maer', 'apr|avr', 'mag|mai|may', 'giu|jun|juin', 'lug|jul|juil', 'ago|aug|aoû', 'set|sep', 'ott|okt|oct', 'nov', 'dic|dez|dec|déc'];
const WEEKDAY_RE = /\b(mon|tue|wed|thu|fri|sat|sun|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|luned|marted|mercoled|gioved|venerd|sabato|domenica|mo|di|mi|do|fr|sa|so)[a-zìé']*\.?\b/i;
function findDate(line) {
  let m = /\b(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b/.exec(line);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${y}-${pad(+m[2])}-${pad(+m[1])}`;
  }
  m = /\b(\d{1,2})\.?\s+([a-zäéû]{3,})\.?\s+(\d{4})\b/i.exec(line);
  if (m) {
    const mon = MONTHS.findIndex(p => new RegExp(`^(${p})`, 'i').test(m[2]));
    if (mon >= 0) return `${m[3]}-${pad(mon + 1)}-${pad(+m[1])}`;
  }
  return null;
}

/* Turn pasted, OCR or PDF text into schedule rows. Handles "08:00-08:30 Title", "8.00 Title", "08h00",
   blocks where the time sits on its own line above the title, day headers (multi-day events) and
   race lines with a second time for pre-grid closing ("R1 13:30 13:25 X30 Senior Heat 1"). */
// Remarks columns of race timetables that say nothing about what happens when.
const REMARK_RE = /registered|scanned|tyres"|^"|tyres only|reifen nur/i;
const isHeaderLine = l => /asn|visa|version|dmsb|seite \d|page \d|promoter|organi[sz]|veranstalter/i.test(l) ||
  (l.match(/\b(time|class|session|remarks|pre-grid|closing|group|zeit|uhrzeit|fahrzeit|klassen?|gruppe|orario|categoria)\b/gi) || []).length >= 2;
// Block headings above a group of rows ("Session 2 - Zeittraining") become a prefix of those rows' titles.
const SECTION_RE = /^session\s*\d+\s*[-–:]\s*(.+)$/i;
// A pause announced on its own line without a time ("MITTAGSPAUSE") spans the gap to the next row.
const GAP_BREAK_RE = /^(mittagspause|mittag|lunch|pausa pranzo|pause)\b/i;
function parseScheduleText(text) {
  const out = [];
  const T = String.raw`(\d{1,2})\s?[:.hH]\s?(\d{2})(?![.\d])`;
  const timeRe = new RegExp(`${T}(?:\\s*(?:[-–—~]|bis|to|al|a)\\s*${T})?(?:\\s+${T})?`);
  let pending = null, prevEntry = null, date = null, section = '', gapBreak = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const cols = raw.replace(/[|_]+/g, '  ').trim().split(/\s{2,}|\t/).map(c => c.trim()).filter(Boolean);
    const line = cols.join(' ');
    if (!line) continue;
    // "Stand 06.09.2026" / "Version 3 - 01.10." is the document date, not an event day
    const d = /\b(stand|version|v\d)\b/i.test(line) ? null : findDate(line);
    // blank out dates (12.10. / 03/10/2026) so they are not read as times
    const scan = line.replace(/\b\d{1,2}[./]\d{1,2}[./](?:\d{2,4})?/g, s => ' '.repeat(s.length));
    let m = timeRe.exec(scan);
    if (d && (!m || WEEKDAY_RE.test(line))) { date = d; pending = prevEntry = null; section = ''; continue; }
    // whole-hour ranges such as "Registrierung 14-17 Uhr"
    const hr = !m && /\b(\d{1,2})\s?[-–]\s?(\d{1,2})\s?Uhr\b/i.exec(scan);
    if (hr && +hr[1] < 24 && +hr[2] <= 24 && +hr[1] < +hr[2]) {
      if (/alternativ/i.test(line) && out.length) { // "(alternativ: Sonntag 8-9 Uhr)" belongs to the row above
        const last = out[out.length - 1], note = line.replace(/^\((.*)\)$/, '$1');
        last.note = last.note ? `${last.note} · ${note}` : note;
        continue;
      }
      m = Object.assign([hr[0], hr[1], '00', hr[2], '00'], { index: hr.index });
    }
    if (!m && SECTION_RE.test(line)) { section = SECTION_RE.exec(line)[1].replace(/\s*\(.*\)\s*$/, '').trim(); prevEntry = pending = null; continue; }
    if (!m && GAP_BREAK_RE.test(line) && out.length) {
      const last = out[out.length - 1];
      gapBreak = { id: uid(), date, start: last.end || last.start, end: '', pregrid: '', title: line.replace(/\s+/g, ' '), kind: 'lunch', cls: '', remind: false };
      prevEntry = pending = null; continue;
    }
    const ok = (x, y) => x != null && +x < 24 && +y < 60;
    if (m && ok(m[1], m[2])) {
      const start = `${pad(+m[1])}:${pad(+m[2])}`;
      const end = ok(m[3], m[4]) ? `${pad(+m[3])}:${pad(+m[4])}` : '';
      const pregrid = !end && ok(m[5], m[6]) && (+m[5] * 60 + +m[6]) < toMin(start) ? `${pad(+m[5])}:${pad(+m[6])}` : '';
      // rebuild the title from the remaining columns, dropping run numbers (R12) and filler like "all"
      const rest = (line.slice(0, m.index) + '  ' + line.slice(m.index + m[0].length))
        .replace(/\bR\d{1,3}\b/g, ' ').replace(/^[\s:\-–—.,]+|[\s:\-–—.,]+$/g, '').trim();
      let title = rest.replace(/^(until|bis|ab|from|fino alle|entro)\b/i, '').replace(/\s+/g, ' ').trim();
      // a run time right after the clock time ("13 Minuten", "10 Minuten + 1 Runde") gives the end
      const dur = /^\s*(\d{1,3})\s*(?:minuten|min\.?|minutes|minuti)\b(\s*\+\s*\d+\s*(?:runden?|laps?|giri?))?/i.exec(rest);
      if (end || pregrid || m[0].includes(' ')) {
        const parts = raw.split(/\s{2,}|\t/)
          .map(c => c.trim()).filter(c => c && !new RegExp(`^${T}`).test(c) && !/^[-–—]$|^R\d{1,3}$|^all$|^alle$|^tutti$/i.test(c) && !REMARK_RE.test(c));
        if (parts.length) title = parts.join(' · ').replace(/^[\s:\-–—.,]+/, '');
      }
      title = title.replace(/^\s*\d{1,3}\s*(?:minuten|min\.?|minutes|minuti)\b(\s*\+\s*\d+\s*(?:runden?|laps?|giri?))?(\s*\/\s*tracktime.*?minuten)?\s*(·\s*)?/i, '')
        .replace(hr ? /\b\d{1,2}\s?[-–]\s?\d{1,2}\b\s*/ : /$^/, '').replace(/\bUhr\b\s*/g, '').replace(/\b(?:ab |um |gegen )?ca\.\s*/i, '')
        .replace(/\s*:\s*(?=\()/, ' ').replace(/[\s:·]+$/, '').trim();
      // group lines under a block heading get the heading ("Zeittraining Gruppe 3 - SENIOR"); other lines don't
      if (section && title && (detectClass(title) || /\b(gruppe|group|gruppo)\b/i.test(title)) && !KIND_RULES.find(([k]) => k === 'session')[1].test(title)) title = `${section} ${title}`;
      const endT = end || (dur ? fromMin(toMin(start) + +dur[1] + (dur[2] ? 2 : 0)) : '');
      if (gapBreak) { gapBreak.end = start; if (gapBreak.date === date) out.push(gapBreak); gapBreak = null; }
      const e = { id: uid(), date, start, end: endT, pregrid, title, kind: 'other', cls: '', remind: false };
      out.push(e);
      pending = title ? null : e;
      prevEntry = e;
    } else if (pending) {
      pending.title = line; pending = null;
    } else if (prevEntry && line.length < 60 && !/^\d+$/.test(line) && !REMARK_RE.test(line) && !isHeaderLine(line)) {
      // note on the line right below an entry, e.g. a class name or "Briefing Room"
      const note = line.replace(/^\((.*)\)$/, '$1');
      prevEntry.note = prevEntry.note ? `${prevEntry.note} · ${note}` : note;
      prevEntry = null;
    } else {
      prevEntry = null;
    }
  }
  const firstDay = out.find(e => e.date)?.date;
  for (const e of out) { if (e.date) break; e.date = firstDay; }
  return finishRows(out.filter(e => e.title));
}
function finishRows(rows) {
  rows.forEach(e => {
    e.id = e.id || uid();
    if (!KINDS[e.kind] || e.kind === 'other') e.kind = classify(e.title || '');
    if (e.kind === 'other' && e.note) e.kind = classify(e.note);
    if (!e.cls) e.cls = detectClass(e.title || '') || detectClass(e.note || '');
    // a bare class name in a training plan is that class's track time
    if (e.kind === 'other' && e.cls && !/leihkart/i.test(e.cls)) e.kind = 'session';
    if (e.remind == null || e.remind === false) e.remind = !!KINDS[e.kind]?.mand;
    if (e.note && !e.title.includes(e.note)) e.title = `${e.title} (${e.note})`;
    delete e.note;
  });
  // Briefings are often printed as one block with several start times per class group, and the
  // word "Briefing" only next to one of them: pull its neighbours (in printed order) in.
  rows.forEach((e, i) => {
    if (e.kind !== 'briefing' || e.end) return;
    for (const dir of [-1, 1]) {
      for (let j = i + dir; rows[j]; j += dir) {
        const o = rows[j];
        if (o.date !== e.date || o.end || o.pregrid || o.kind === 'briefing' || Math.abs(toMin(o.start) - toMin(e.start)) > 90 || classify(o.title) !== 'other') break;
        o.kind = 'briefing'; o.remind = true;
        o.title = `Fahrerbesprechung · ${o.title}`;
      }
    }
  });
  return rows.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || toMin(a.start) - toMin(b.start));
}

/* ---------- Persistent state ---------- */
const DEFAULT_LAYOUTS = {
  race: [
    { type: 'clock', x: 0, y: 0, w: 4, h: 2 }, { type: 'next', x: 4, y: 0, w: 4, h: 2 }, { type: 'weather', x: 8, y: 0, w: 4, h: 5 },
    { type: 'radar', x: 0, y: 2, w: 8, h: 5 }, { type: 'schedule', x: 8, y: 5, w: 4, h: 7 },
    { type: 'live', x: 0, y: 7, w: 8, h: 6 }, { type: 'tasks', x: 8, y: 12, w: 4, h: 4 }, { type: 'notes', x: 0, y: 13, w: 8, h: 2 },
  ],
  training: [
    { type: 'clock', x: 0, y: 0, w: 4, h: 2 }, { type: 'next', x: 4, y: 0, w: 4, h: 2 }, { type: 'weather', x: 8, y: 0, w: 4, h: 5 },
    { type: 'radar', x: 0, y: 2, w: 8, h: 6 }, { type: 'schedule', x: 8, y: 5, w: 4, h: 8 }, { type: 'notes', x: 0, y: 8, w: 8, h: 2 },
  ],
};
const DEFAULT_TASKS = [
  { id: 't-papers', label: 'Papierabnahme / Nennung', kind: 'papers' },
  { id: 't-tyres', label: 'Reifen abholen und registrieren', kind: 'tyres' },
  { id: 't-transp', label: 'Transponder abholen', kind: 'transponder' },
  { id: 't-scrut', label: 'Technische Abnahme', kind: 'scrut' },
  { id: 't-brief', label: 'Fahrerbesprechung', kind: 'briefing' },
];
const withIds = list => list.map(w => ({ id: uid(), ...w }));

function loadState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { s = {}; }
  return {
    mode: s.mode || 'training',
    trackId: s.trackId || 'southgarda',
    customTracks: s.customTracks || [],
    layouts: s.layouts || { race: withIds(DEFAULT_LAYOUTS.race), training: withIds(DEFAULT_LAYOUTS.training) },
    schedule: s.schedule || {},
    tasks: s.tasks || DEFAULT_TASKS,
    taskDone: s.taskDone || {},
    myClass: s.myClass ?? '',
    myKarts: s.myKarts ?? '',
    lead: s.lead ?? 15,
    remindSessions: s.remindSessions ?? true,
    rainAlert: s.rainAlert ?? true,
    sound: false,
    notes: s.notes || '',
    fired: s.fired || {},
    seeded: s.seeded || false,
    liveAdded: s.liveAdded || false,
    events: s.events || {},
    eventCls: s.eventCls || '',
    eventKarts: s.eventKarts || '',
  };
}
let FRESH = false; // first start on this device/browser
try { FRESH = !localStorage.getItem(LS_KEY); } catch { /* storage blocked */ }
const state = loadState();
// Layouts saved before the live-timing widget existed get it once on race days.
if (!state.liveAdded) {
  state.liveAdded = true;
  if (!state.layouts.race.some(w => w.type === 'live')) state.layouts.race.push({ id: uid(), type: 'live', w: 8, h: 6 });
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ ...state, sound: undefined })); } catch { /* private mode: keep in memory */ }
  }, 150);
}

const allTracks = () => [...TRACKS, ...state.customTracks];
const currentTrack = () => allTracks().find(t => t.id === state.trackId) || TRACKS[0];

/* ---------- Prepared events ---------- */
// A race weekend we prepared in advance: track, framework schedule and the official links.
// Rows marked `vorl.` are the publicly announced framework; the official PDF import replaces them.
const EEC_GROUPS = ['Gruppe 1 - MINI', 'Gruppe 2 - JUNIOR', 'Gruppe 3 - SENIOR', 'Gruppe 4 - SHIFTER 180 KG', 'Gruppe 5 - SHIFTER 190 KG', 'Gruppe 6 - GKC 100'];
// one block per session: every group in turn, `step` minutes apart, each running `len` minutes
const eecBlock = (title, from, step, len) => EEC_GROUPS.map((g, i) => {
  const s = toMin(from) + i * step;
  return [fromMin(s), fromMin(s + len), `${title} ${g}`];
});
// 54. Trofeo delle Industrie, South Garda Karting Lonato, 12.–15.11.2026.
// Official timetable "Programma ufficiale" Version N.1 (update 06.11.2026), trofeodelleindustrie.it.
// Our karts: #445 Stiffel and #453 Goetz, both OKN, both odd numbers ("dispari").
// cls values are exact: 'OKN ungerade' / 'OKN gerade' for split sessions, 'OKN' for sessions of the whole class.
const TDI = { okn: 'OKN', oknj: 'OKN Junior', kz2: 'KZ2', u10: 'Mini Gr.3 U10', mini: 'Mini Gr.3' };
// split sessions (even/odd numbers) for classes in `order`, `step` minutes apart, each `len` minutes
const tdiSplit = (title, from, order, step, len) => order.flatMap((c, i) => [['gerade', 0], ['ungerade', 1]].map(([par, k]) => {
  const s = toMin(from) + (i * 2 + k) * step, cls = c === 'okn' ? `OKN ${par}` : TDI[c];
  return [fromMin(s), fromMin(s + len), `${title} ${TDI[c]} (${par} Nr.)`, { cls }];
}));
const tdiRace = (start, c, title, laps, extra = {}) => {
  const len = Math.round(laps * 0.9) + 2; // ca. 50 s per lap plus formation lap
  return [start, fromMin(toMin(start) + len), `${title} ${TDI[c]} · ${laps} Runden`, { cls: TDI[c], ...extra }];
};
const tdiNotOurs = (start, end, title, c) => [start, end, title, { cls: TDI[c], remind: false }];
const TDI_FP = ['okn', 'oknj', 'kz2', 'u10', 'mini'];
const TROFEO_2026 = {
  id: 'trofeo-industrie-2026', rev: 1, name: '54. Trofeo delle Industrie', short: 'Trofeo Industrie',
  from: '2026-11-12', to: '2026-11-15', track: 'southgarda', live: 'apex-southgarda', cls: 'OKN, OKN ungerade', karts: '445, 453',
  stream: 'dVMSiuHKyxE', entries: 'trofeo-industrie-2026',
  info: 'OKN: 72 Starter · #445 Stiffel, #453 Goetz (MAD Performance)',
  schedule: {
    '2026-11-12': [
      ['07:15', '', 'Fahrerlager öffnet · Transponder-Ausgabe an der Vorstart-Einfahrt', { remind: false }],
      ...tdiSplit('Freies Training 1', '08:00', TDI_FP, 12, 10),
      ...tdiSplit('Freies Training 2', '10:00', TDI_FP, 12, 10),
      ['12:00', '12:20', 'Pause'],
      ...tdiSplit('Freies Training 3', '12:20', TDI_FP, 12, 10),
      ...tdiSplit('Freies Training 4', '14:20', TDI_FP, 12, 10),
      tdiNotOurs('12:30', '13:30', 'Papierabnahme Mini Gr.3 und U10 (Umschlag mit Streckenplan, Aufklebern, Armbändern)', 'mini'),
      tdiNotOurs('13:40', '14:40', 'Papierabnahme KZ2, danach Reifengutschein am VEGA-Truck', 'kz2'),
      ['14:50', '15:50', 'Papierabnahme OKN im Rennbüro, danach Reifengutschein am MG-Zelt', { cls: 'OKN' }],
      tdiNotOurs('16:00', '17:00', 'Papierabnahme OKN Junior, danach Reifengutschein am MG-Zelt', 'oknj'),
      ['14:00', '18:00', 'Reifenausgabe im Parc fermé (alle Klassen)'],
      ['19:30', '', 'Fahrerlager schließt', { remind: false }],
    ],
    '2026-11-13': [
      ['07:15', '', 'Fahrerlager öffnet · Technische Abnahme UNILOG nur Mini', { remind: false }],
      tdiNotOurs('08:10', '08:30', 'Fahrerbesprechung OKN Junior (Zelt im Fahrerlager)', 'oknj'),
      tdiNotOurs('08:40', '09:00', 'Fahrerbesprechung Mini Gr.3 (Zelt im Fahrerlager)', 'mini'),
      tdiNotOurs('09:10', '09:30', 'Fahrerbesprechung KZ2 (Zelt im Fahrerlager)', 'kz2'),
      ['09:40', '10:00', 'Fahrerbesprechung OKN (Zelt im Fahrerlager)', { cls: 'OKN' }],
      tdiNotOurs('10:10', '10:30', 'Fahrerbesprechung Mini Gr.3 U10 (Zelt im Fahrerlager)', 'u10'),
      ...tdiSplit('Offizielles Training (8 min, mit Transponder)', '08:15', ['kz2', 'okn', 'u10', 'mini', 'oknj'], 11, 8),
      ...['kz2', 'okn', 'u10', 'mini', 'oknj'].flatMap((c, i) => [1, 2].map(k => {
        const s = toMin('10:10') + (i * 2 + k - 1) * 11;
        return [fromMin(s), fromMin(s + 6), `Zeittraining ${TDI[c]} ${k}. Serie (6 min)`, { cls: TDI[c] }];
      })),
      ['12:00', '12:45', 'Pause'],
      ...[['12:50', 'kz2', 'A–B'], ['13:10', 'kz2', 'C–D'], ['13:30', 'okn', 'A–B'], ['13:50', 'okn', 'C–D'], ['14:10', 'u10', 'A–B'],
        ['14:30', 'u10', 'C–D'], ['14:50', 'mini', 'A–B'], ['15:10', 'mini', 'C–D'], ['15:30', 'oknj', 'A–B'], ['15:50', 'oknj', 'C–D']]
        .map(([t, c, g]) => tdiRace(t, c, `Heat ${g}`, /mini|u10/.test(c) ? 8 : 12)),
      ['19:30', '', 'Fahrerlager schließt', { remind: false }],
    ],
    '2026-11-14': [
      ['07:15', '', 'Fahrerlager öffnet', { remind: false }],
      ...tdiSplit('Warm-up (8 min, Transponder Pflicht)', '08:00', ['okn', 'oknj', 'u10', 'mini', 'kz2'], 11, 8),
      ...[['10:00', 'okn', 'A–C'], ['10:20', 'okn', 'B–D'], ['10:40', 'oknj', 'A–C'], ['11:00', 'oknj', 'B–D'], ['11:20', 'u10', 'A–C'],
        ['11:35', 'u10', 'B–D'], ['11:50', 'mini', 'A–C'], ['12:05', 'mini', 'B–D'], ['12:20', 'kz2', 'A–C'], ['12:40', 'kz2', 'B–D'],
        ['13:20', 'okn', 'A–D'], ['13:40', 'okn', 'B–C'], ['14:00', 'oknj', 'A–D'], ['14:20', 'oknj', 'B–C'], ['14:40', 'u10', 'A–D'],
        ['14:55', 'u10', 'B–C'], ['15:10', 'mini', 'A–D'], ['15:25', 'mini', 'B–C'], ['15:40', 'kz2', 'A–D'], ['16:00', 'kz2', 'B–C']]
        .map(([t, c, g]) => tdiRace(t, c, `Heat ${g}`, /mini|u10/.test(c) ? 8 : 12)),
      ['12:50', '13:15', 'Pause'],
      ['19:30', '', 'Fahrerlager schließt', { remind: false }],
    ],
    '2026-11-15': [
      ['07:15', '', 'Fahrerlager öffnet', { remind: false }],
      ...tdiSplit('Warm-up (8 min, Transponder Pflicht)', '08:00', ['oknj', 'u10', 'mini', 'okn', 'kz2'], 11, 8),
      ...[['10:00', 'oknj', 'A', 16], ['10:20', 'oknj', 'B', 16], ['10:40', 'u10', 'A', 10], ['11:00', 'u10', 'B', 10], ['11:20', 'mini', 'A', 10],
        ['11:40', 'mini', 'B', 10], ['12:00', 'okn', 'A', 16], ['12:20', 'okn', 'B', 16], ['12:40', 'kz2', 'A', 16], ['13:00', 'kz2', 'B', 16]]
        .map(([t, c, g, laps]) => tdiRace(t, c, `Vorfinale ${g}`, laps)),
      ['13:15', '13:45', 'Pause'],
      ...[['14:00', '13:50', 'u10', 10], ['14:30', '14:20', 'mini', 10], ['15:00', '14:50', 'oknj', 18], ['15:30', '15:20', 'okn', 18], ['16:00', '15:50', 'kz2', 20]]
        .map(([t, grid, c, laps]) => tdiRace(t, c, 'Finale', laps, { pregrid: grid })),
      ['17:00', '', 'Siegerehrung am Podium im Fahrerlager (erste 3 je Klasse, im Rennoverall)'],
      ['19:30', '', 'Fahrerlager schließt', { remind: false }],
    ],
  },
  links: [
    ['Zeitplan (PDF)', 'https://www.trofeodelleindustrie.it/wp-content/uploads/2026/11/Programma-ufficiale-Industrie-2026.pdf'],
    ['Nennliste (PDF)', 'https://www.trofeodelleindustrie.it/wp-content/uploads/2026/11/Provisional-entry-list-6-november.pdf'],
    ['Ausschreibung', 'https://www.trofeodelleindustrie.it/wp-content/uploads/2026/09/Bollettino-info-eng-industrie-2026.pdf'],
    ['Aushang', 'https://www.trofeodelleindustrie.it/?page_id=9&lang=en'],
    ['Livetiming', 'https://www.apex-timing.com/live-timing/southgardakarting/index.html'],
    ['Livestream', 'https://youtube.com/live/dVMSiuHKyxE'],
    ['Streckenplan', 'https://www.trofeodelleindustrie.it/?page_id=45&lang=en'],
  ],
};
// Official plans V1 (Stand 06.09.2026); the Saturday PDF wrongly prints 21.03.2026, it is the 24.10.
const EVENTS = [{
  id: 'eec-kerpen-2026', rev: 2, name: 'Eifel-Erft-Cup Finale Kerpen', short: 'EEC Finale Kerpen',
  from: '2026-10-24', to: '2026-10-25', track: 'kerpen', live: 'eec-kerpen', cls: 'OK-N Senior, Gruppe 3', karts: '194, Stiffel',
  schedule: {
    '2026-10-24': [
      ['14:00', '17:00', 'Registrierung (KCK-Clubhaus), alternativ So 8–9 Uhr'],
      ['14:00', '17:00', 'Technische Abnahme (TK-Garagen), alternativ So 8–9 Uhr'],
      ['17:30', '', 'Fahrerbesprechung Gruppe MINI/JUNIOR (KCK-Clubhaus)', { remind: false }],
      ...[0, 1, 2, 3, 4, 5].flatMap(r => eecBlock(`Freies Training ${r + 1}`, fromMin(9 * 60 + r * 90), 15, 13)),
    ],
    '2026-10-25': [
      ['08:00', '09:00', 'Registrierung nur falls nicht am Samstag (KCK-Clubhaus)', { remind: false }],
      ['08:00', '09:00', 'Technische Abnahme nur falls nicht am Samstag (TK-Garagen)', { remind: false }],
      ...eecBlock('Warm-up', '08:30', 10, 10),
      ...eecBlock('Zeittraining', '09:30', 10, 10),
      ...eecBlock('Rennen 1', '10:40', 20, 12),
      ['12:32', '13:20', 'Mittagspause (Motorenruhe)'],
      ...eecBlock('Rennen 2', '13:20', 20, 12),
      ...eecBlock('Rennen 3', '15:30', 20, 12),
      ['17:30', '', 'Siegerehrung nach Tageswertung am KCK-Clubhaus'],
    ],
  },
  links: [
    ['Zeitplan Sa (PDF)', 'https://www.adac-sport.com/KCK_FruehjahrsCup_942/docs/33_Zeitplan_EifelErft_Cup_Samstag_24102026_V1_6_Gruppen.pdf'],
    ['Zeitplan So (PDF)', 'https://www.adac-sport.com/KCK_FruehjahrsCup_942/docs/34_Zeitplan_EifelErft_Cup_Sonntag_25102026_V1_6_Gruppen.pdf'],
    ['Teilnehmerliste', 'https://www.adac-sport.com/KCK_FruehjahrsCup_942/TW_ON_Teilnehmerliste.php'],
    ['Aushang', 'https://www.adac-sport.com/KCK_FruehjahrsCup_942/TW_ON_Virtueller_Aushang.php'],
    ['KCK-News (Livetiming)', 'https://www.kart-club-kerpen.de/news.html'],
    ['Ergebnisse', 'https://www.motorsport-events.se/camp/?dir=Clubsport%2F01%20KCK%20Kerpen%2FRace%204'],
  ],
}, TROFEO_2026];
// The event to offer: one running on that day, or starting within the next 7 days.
function eventFor(day) {
  return EVENTS.find(ev => day >= ev.from && day <= ev.to) ||
    EVENTS.find(ev => ev.from > day && ev.from <= shiftDay(day, 7));
}
function loadEvent(ev) {
  state.trackId = ev.track;
  for (const [day, rows] of Object.entries(ev.schedule)) {
    // keep a schedule the team already imported (e.g. the official PDF), replace only empty, example or our own days
    const cur = state.schedule[day] || [];
    if (cur.length && !cur.every(e => e.event || /BEISPIEL/.test(e.title))) continue;
    state.schedule[day] = finishRows(rows.map(([start, end, title, extra]) => ({ start, end, title, kind: 'other', event: ev.id, ...extra })))
      .map(e => (rows.find(r => r[2] === e.title)?.[3]?.remind === false ? { ...e, remind: false } : e));
  }
  // set class and kart numbers unless the team entered their own (an earlier event default counts as not own)
  if (ev.cls && (!state.myClass || state.myClass === state.eventCls)) state.myClass = state.eventCls = ev.cls;
  if (ev.karts && (!state.myKarts || state.myKarts === state.eventKarts)) state.myKarts = state.eventKarts = ev.karts;
  if (state.myClass === 'Junior' && !state.eventCls) state.myClass = state.eventCls = ev.cls; // default of the first preview
  const race = state.layouts.race;
  for (const w of race) if (w.type === 'live') w.src = ev.live;
  const added = [];
  if (ev.stream && !race.some(w => w.type === 'stream')) race.push(added[added.length] = { id: uid(), type: 'stream', w: 4, h: 4 });
  if (ev.entries && !race.some(w => w.type === 'field')) race.push(added[added.length] = { id: uid(), type: 'field', w: 8, h: 6 });
  if (added.length) { // first time: arrange the race-day board for the event, unknown extra widgets go below
    const P = { clock: [0, 0, 4, 2], next: [4, 0, 4, 2], weather: [8, 0, 4, 5], radar: [0, 2, 8, 5], schedule: [8, 5, 4, 8],
      live: [0, 7, 8, 6], stream: [8, 13, 4, 4], field: [0, 13, 8, 6], tasks: [8, 17, 4, 4], notes: [0, 19, 8, 2] };
    const seen = new Set();
    for (const w of race) {
      const p = !seen.has(w.type) && P[w.type]; seen.add(w.type);
      if (p) [w.x, w.y, w.w, w.h] = p; else { delete w.x; delete w.y; }
    }
  }
  const wxw = !added.length && race.find(w => w.type === 'weather' && w.h < 5);
  if (wxw && Number.isInteger(wxw.x)) { // room for the weekend forecast; neighbours move down
    for (const b of resolveLayout(race.map(boxOf), { ...boxOf(wxw), h: 5 })) Object.assign(race.find(i => i.id === b.id), b);
  }
  state.events[ev.id] = ev.rev || 1;
  save(); refreshTrackSelect(); onTrackChange(); setMode('race');
}

// Seed today with a clearly marked example race schedule on first start so the widgets show something.
function seedExample() {
  if (state.seeded) return;
  state.seeded = true;
  const today = dateKey(new Date());
  if (eventFor(today)) { save(); return; } // a prepared race weekend is coming: no example data
  if (!state.schedule[today]) {
    const base = Math.max(7 * 60, Math.floor(nowMin() / 15) * 15 - 60);
    const t = m => `${pad(Math.floor((base + m) / 60) % 24)}:${pad((base + m) % 60)}`;
    state.schedule[today] = finishRows([
      ['', 0, 45, 'BEISPIEL Papierabnahme'], ['', 30, 75, 'BEISPIEL Reifen und Transponder abholen'],
      ['', 75, 85, 'BEISPIEL Freies Training OK Junior'], ['', 95, 105, 'BEISPIEL Freies Training KZ2'],
      ['', 120, 180, 'BEISPIEL Technische Abnahme'], ['', 150, 170, 'BEISPIEL Fahrerbesprechung'],
      ['', 190, 250, 'BEISPIEL Mittagspause'], ['', 255, 265, 'BEISPIEL Zeittraining OK Junior'],
      ['', 300, 315, 'BEISPIEL Heat 1 OK Junior'],
    ].map(([, a, b, title]) => ({ start: t(a), end: t(b), title, kind: 'other' })));
  }
  save();
}

/* ---------- Alerts, sound, notifications ---------- */
let audioCtx = null;
function beep(times = 3) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.35;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      o.start(t0); o.stop(t0 + 0.3);
    }
  } catch { /* no audio */ }
}
function showAlert(key, timeText, text, cls = '') {
  if ($(`.alert[data-key="${CSS.escape(key)}"]`)) return;
  const el = h('div', { class: `alert ${cls}`, 'data-key': key },
    h('span', { class: 'a-time', text: timeText }), h('span', { class: 'a-text', text }),
    h('button', { type: 'button', onclick: () => el.remove() }, 'OK'));
  $('#alerts').append(el);
  beep(cls === 'rain' ? 2 : 3);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(`MAD · ${timeText}`, { body: text, tag: key }); } catch { /* blocked in frames */ }
  }
}

function relevantEntries(day = dateKey(new Date())) {
  return (state.schedule[day] || []).slice().sort((a, b) => toMin(a.start) - toMin(b.start));
}
const normCls = v => String(v || '').toLowerCase().replace(/[\s\-_.]+/g, '');
const isMine = e => {
  const c = state.myClass.trim().toLowerCase();
  if (!c) return false;
  const mine = c.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  // rows of a prepared event carry an exact class ('OKN' must not match 'OKN Junior')
  if (e.event && e.cls) return mine.some(x => normCls(x) === normCls(e.cls));
  return mine.some(x => `${e.title} ${e.cls}`.toLowerCase().includes(x));
};
// a mandatory appointment that belongs to another class (e.g. another class's briefing) is not ours
const isMandForUs = e => !!KINDS[e.kind]?.mand && (!e.event || !e.cls || isMine(e));
const wantsReminder = e => e.remind || (state.remindSessions && e.kind === 'session' && isMine(e));

function checkReminders() {
  const day = dateKey(new Date()), n = nowMin();
  for (const e of relevantEntries(day)) {
    if (!wantsReminder(e)) continue;
    const s = toMin(e.pregrid || e.start);
    // lead reminder stays due until the start (so it still fires if the page was opened late); start reminder for 2 min
    const steps = [[s - state.lead, s, `in ${Math.ceil(s - n)} min`], [s, s + 2, 'jetzt']];
    for (const [from, until, label] of steps) {
      const key = `${day}|${e.id}|${from}`;
      if (n >= from && n < until && !state.fired[key]) {
        state.fired[key] = true; save();
        showAlert(key, e.pregrid || e.start, `${e.pregrid ? 'Vorstart schließt' : KINDS[e.kind]?.label || ''}: ${e.title} (${label})`);
      }
    }
  }
  // forget reminders from other days
  for (const k of Object.keys(state.fired)) if (!k.startsWith(day)) delete state.fired[k];
}

/* ---------- Widgets ---------- */
const WIDGETS = {
  clock: {
    title: 'Uhr', desc: 'Große Uhrzeit mit Datum',
    mount(body) {
      const t = h('div', { class: 'clock-time' }), d = h('div', { class: 'clock-date' });
      body.append(h('div', { class: 'clock' }, t, d));
      return { tick() {
        const now = new Date();
        t.innerHTML = `${pad(now.getHours())}:${pad(now.getMinutes())}<span class="sec">:${pad(now.getSeconds())}</span>`;
        d.textContent = DAY_FMT.format(now);
      } };
    },
  },

  next: {
    title: 'Nächster Termin', desc: 'Countdown bis zum nächsten Pflichttermin oder Turn der eigenen Klasse',
    mount(body) {
      const box = h('div', { class: 'next' });
      body.append(box);
      let sig = '';
      return { tick() {
        const n = nowMin(), today = dateKey(new Date()), list = relevantEntries();
        const important = l => l.filter(e => isMandForUs(e) || isMine(e) || (e.remind && !(e.event && e.cls)));
        const pool = important(list).length ? important(list) : list;
        const running = pool.find(e => toMin(e.start) <= n && toMin(e.end || e.start) > n);
        const due = e => toMin(e.pregrid || e.start);
        const upcoming = pool.filter(e => due(e) > n).sort((a, b) => due(a) - due(b));
        let e = upcoming[0], left = e ? due(e) - n : 0, dayTxt = '', after = upcoming[1];
        if (!e) { // nothing left today: look ahead up to a week (e.g. the race weekend starting in two days)
          for (let i = 1; i <= 7 && !e; i++) {
            const d = shiftDay(today, i), l = important(relevantEntries(d)).filter(x => x.kind !== 'other' || x.cls);
            if (l.length) { e = l.sort((x, y) => due(x) - due(y))[0]; after = null; left = i * 1440 + due(e) - n; dayTxt = `${DAY_SHORT.format(new Date(d + 'T12:00'))} · `; }
          }
        }
        const key = `${e?.id}|${running?.id}|${Math.floor(left)}|${Math.floor(Date.now() / 1000)}`;
        if (key === sig) return; sig = key;
        box.replaceChildren();
        if (running) box.append(h('div', { class: 'next-after next-run', text: `Läuft: ${running.title} bis ${running.end}` }));
        if (!e) { box.append(h('div', { class: 'next-title', text: list.length ? 'Heute keine weiteren Termine' : 'Kein Zeitplan für heute' })); return; }
        box.append(
          h('div', { class: 'next-label', text: dayTxt + (e.pregrid ? `Vorstart schließt ${e.pregrid} · Start ${e.start}` : `${KINDS[e.kind]?.label || 'Termin'} um ${e.start}`) }),
          h('div', { class: 'next-title', text: e.title }),
          h('div', { class: `next-count ${left <= state.lead ? 'soon' : ''}`, text: left >= 1440 ? `${Math.floor(left / 1440)} T ${fmtDur(left % 1440)}` : fmtDur(left) }),
          after ? h('div', { class: 'next-after', text: `Danach ${after.start} ${after.title}` }) : '');
      } };
    },
  },

  radar: {
    title: 'Regenradar', desc: 'Satellitenkarte mit Live-Regenradar, frei zoombar',
    mount(body, inst) { return mountRadar(body, inst); },
  },

  weather: {
    title: 'Wetter & Regen', desc: 'Regenprognose der nächsten Stunden für die Strecke',
    mount(body) { return mountWeather(body); },
  },

  schedule: {
    title: 'Tageszeitplan', desc: 'Zeitplan mit Klassen, Pausen, Pflichtterminen und Erinnerungen',
    mount(body, inst) { return mountSchedule(body, inst); },
  },

  tasks: {
    title: 'Renntag-Checkliste', desc: 'Papierabnahme, Reifen, Transponder, Technik, Briefing abhaken',
    mount(body) { return mountTasks(body); },
  },

  live: {
    title: 'Livetiming', desc: 'Live-Ergebnisse (Apex Timing direkt, andere Anbieter als Webseite), eigene Karts hervorgehoben',
    mount(body, inst) { return mountLive(body, inst); },
  },

  stream: {
    title: 'Livestream', desc: 'Offizieller Livestream der Veranstaltung (YouTube), eingebettet',
    mount(body, inst) { return mountStream(body, inst); },
  },

  field: {
    title: 'Starterfeld', desc: 'Nennliste der eigenen Klasse mit Teams, Chassis und Motoren, eigene Fahrer hervorgehoben',
    mount(body, inst) { return mountField(body, inst); },
  },

  notes: {
    title: 'Notizen', desc: 'Freies Notizfeld für Teamchef und Mechaniker',
    mount(body) {
      const ta = h('textarea', { class: 'notes', placeholder: 'Notizen, Setup, Reifendruck…' });
      ta.value = state.notes;
      ta.addEventListener('input', () => { state.notes = ta.value; save(); });
      body.append(ta);
      return {};
    },
  },
};

/* ---------- Livestream ---------- */
const activeEvent = () => eventFor(dateKey(new Date())) || EVENTS.find(ev => state.events[ev.id]);
const ytId = v => { const m = /(?:youtu\.be\/|v=|live\/|embed\/)([\w-]{11})/.exec(v || '') || /^([\w-]{11})$/.exec((v || '').trim()); return m ? m[1] : ''; };
function mountStream(body, inst) {
  const root = h('div', { class: 'stream' });
  body.append(root);
  let showCfg = false;
  function render() {
    const id = ytId(inst.yt) || activeEvent()?.stream || '';
    const watch = id ? `https://www.youtube.com/watch?v=${id}` : '';
    const input = h('input', { value: inst.yt || '', placeholder: 'YouTube-Link oder Video-ID' });
    root.replaceChildren(...[
      h('div', { class: 'live-bar' },
        h('span', { class: 'live-title', text: id ? (activeEvent()?.name ? `${activeEvent().name} · YouTube` : 'YouTube') : 'Kein Stream eingestellt' }),
        id ? h('a', { class: 'btn small ghost', href: watch, target: '_blank', rel: 'noopener', title: 'Stream in der YouTube-App oder einem eigenen Fenster öffnen' }, 'Auf YouTube ↗') : null,
        h('button', { type: 'button', class: 'icon-btn', title: 'Anderen Stream einstellen', onclick: () => { showCfg = !showCfg; render(); } }, '⚙')),
      showCfg ? h('form', { class: 'live-cfg', onsubmit: ev => { ev.preventDefault(); inst.yt = input.value.trim(); showCfg = false; save(); render(); } },
        h('label', { class: 'field' }, h('span', { text: 'YouTube-Link (leer = Stream der Veranstaltung)' }), input),
        h('div', { class: 'row-btns' }, h('button', { class: 'btn primary small', type: 'submit' }, 'Übernehmen'))) : null,
      !id ? h('div', { class: 'empty', text: 'Über ⚙ einen YouTube-Link eintragen.' })
        // YouTube refuses embeds without a web origin (file://), so offer the link there
        : location.protocol === 'file:' ? h('div', { class: 'empty' }, 'Eingebettet läuft der Stream nur in der Online-Version. ', h('a', { href: watch, target: '_blank', rel: 'noopener' }, 'Auf YouTube ansehen ↗'))
          : h('div', { class: 'stream-frame' }, h('iframe', { src: `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0&modestbranding=1`, title: 'Livestream',
            allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin' })),
    ].filter(Boolean));
  }
  render();
  return { day: render };
}

/* ---------- Starterfeld (entry list) ---------- */
function mountField(body, inst) {
  const root = h('div', { class: 'field-w' });
  body.append(root);
  let q = '';
  const count = arr => Object.entries(arr.reduce((m, v) => ({ ...m, [v]: (m[v] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  function render() {
    const ev = activeEvent(), data = ev && window.MAD_ENTRIES?.[ev.entries];
    if (!data) { root.replaceChildren(h('div', { class: 'empty', text: 'Für diese Veranstaltung ist keine Nennliste hinterlegt.' })); return; }
    const rows = data.rows.filter(r => !q || r.join(' ').toLowerCase().includes(q));
    const ours = data.rows.filter(r => isOurKart(r[0], r[1]));
    const de = data.rows.filter(r => r[2] === 'DEU').length;
    const stat = (label, list, n) => h('div', { class: 'fw-stat' }, h('span', { class: 'fw-k', text: label }),
      h('span', { class: 'fw-bars' }, list.slice(0, n).map(([k, v]) => h('span', { class: 'fw-bar', title: `${k}: ${v} von ${data.rows.length}`, style: `--p:${v / data.rows.length}` }, h('b', { text: v }), ` ${k}`))));
    const search = h('input', { type: 'search', class: 'fw-search', placeholder: 'Suchen: Nr., Name, Team, Chassis …', value: q, title: 'Filtert die Nennliste nach Startnummer, Name, Team, Chassis oder Motor' });
    search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); const pos = search.selectionStart; render(); const s2 = $('.fw-search', root); s2.focus(); s2.setSelectionRange(pos, pos); });
    root.replaceChildren(
      h('div', { class: 'fw-head' },
        h('div', { class: 'fw-kpi', title: 'Genannte Fahrer in der eigenen Klasse' }, h('b', { text: data.rows.length }), h('span', { text: `${data.cls} Starter` })),
        h('div', { class: 'fw-kpi', title: 'Davon aus Deutschland' }, h('b', { text: de }), h('span', { text: 'aus DEU' })),
        h('div', { class: 'fw-kpi ours', title: 'Unsere Fahrer (Einstellungen → Startnummern)' }, h('b', { text: ours.map(r => '#' + r[0]).join(' ') || '–' }), h('span', { text: 'MAD Performance' })),
        h('div', { class: 'fw-stats' }, stat('Motor', count(data.rows.map(r => r[5])), 4), stat('Chassis', count(data.rows.map(r => r[4])), 5))),
      search,
      h('div', { class: 'table-wrap fw-table' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Nr', 'Fahrer', 'Nat', 'Bewerber', 'Chassis', 'Motor'].map(t => h('th', { text: t })))),
        h('tbody', {}, rows.map(r => h('tr', { class: isOurKart(r[0], r[1]) ? 'ours' : '' }, r.map((v, i) => h('td', { class: i === 0 ? 'num' : '', text: v }))))))),
      h('div', { class: 'live-foot' }, h('span', { class: 'muted', text: `Vorläufige Nennliste, Stand ${data.stand}. Alle Klassen: ${Object.entries(data.total).map(([k, v]) => `${k} ${v}`).join(' · ')}` })));
  }
  render();
  return { day: render, data: render };
}

/* ---------- Radar ---------- */
const RV_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const rv = { host: '', frames: [], loadedAt: 0, error: '' };
// Tracks without ALFANO GPS data get their outline from OpenStreetMap (raceways within 500 m),
// cached per track; an empty answer is cached for a day so we don't ask again on every render.
const OSM_KEY = 'mad-boxenmauer-osm';
function osmCache() { try { return JSON.parse(localStorage.getItem(OSM_KEY)) || {}; } catch { return {}; } }
const osmPending = {};
function osmOutline(t) {
  const hit = osmCache()[t.id];
  if (hit && (hit.segs.length || Date.now() - hit.at < 864e5)) return Promise.resolve(hit.segs);
  return osmPending[t.id] ||= (async () => {
    try {
      const q = `[out:json][timeout:20];way(around:500,${t.lat},${t.lon})[highway=raceway];out geom;`;
      const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: q }) });
      if (!res.ok) throw new Error(res.status);
      const segs = (await res.json()).elements.filter(e => e.geometry?.length > 1)
        .map(e => e.geometry.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]));
      const cache = osmCache(); cache[t.id] = { segs, at: Date.now() };
      try { localStorage.setItem(OSM_KEY, JSON.stringify(cache)); } catch {}
      return segs;
    } catch { return null; } finally { delete osmPending[t.id]; }
  })();
}

async function loadRadarFrames() {
  if (Date.now() - rv.loadedAt < 4 * 60e3 && rv.frames.length) return rv;
  try {
    const r = await fetch(RV_URL, { cache: 'no-store' });
    const j = await r.json();
    rv.host = j.host;
    rv.frames = [...(j.radar?.past || []).map(f => ({ ...f, nowcast: false })), ...(j.radar?.nowcast || []).map(f => ({ ...f, nowcast: true }))];
    rv.loadedAt = Date.now(); rv.error = '';
  } catch (err) { rv.error = 'Radar nicht erreichbar (offline oder in dieser Vorschau blockiert).'; }
  return rv;
}

function mountRadar(body, inst) {
  const mapEl = h('div', { class: 'map' });
  const msg = h('div', { class: 'map-msg', hidden: true });
  const legend = h('div', { class: 'map-legend' }, 'leicht', h('i'), 'stark');
  const play = h('button', { type: 'button', title: 'Animation' }, '▶');
  const slider = h('input', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Radarzeit' });
  const ftime = h('span', { class: 'frame-time', text: '–' });
  const zoomBtns = [['Strecke', 16], ['Umland', 10], ['Region', 8], ['Übersicht', 6]].map(([l, z]) =>
    h('button', { type: 'button', onclick: () => map.setView([trk.lat, trk.lon], z) }, l));
  const radarToggle = h('button', { type: 'button', class: 'on', title: 'Radar ein/aus' }, 'Radar');
  body.append(mapEl, msg, legend, h('div', { class: 'map-bar' }, play, slider, ftime, radarToggle, ...zoomBtns));

  let trk = currentTrack();
  const map = L.map(mapEl, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([trk.lat, trk.lon], inst.zoom || 9);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Bild: Esri, Maxar, Earthstar Geographics',
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, opacity: .85,
  }).addTo(map);
  map.attributionControl.addAttribution('Radar: <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>');

  const trackLayer = L.layerGroup().addTo(map);
  function drawTrack() {
    trackLayer.clearLayers();
    trk = currentTrack();
    if (trk.outline?.length) L.polyline(trk.outline, { color: '#ef2b33', weight: 4, opacity: .95 }).addTo(trackLayer);
    else {
      const t = trk, segs = osmCache()[t.id]?.segs;
      if (segs?.length) L.polyline(segs, { color: '#ef2b33', weight: 3, opacity: .9 }).bindTooltip('Streckenverlauf: © OpenStreetMap').addTo(trackLayer);
      else if (!segs) osmOutline(t).then(r => { if (r?.length && currentTrack().id === t.id) drawTrack(); });
    }
    L.circleMarker([trk.lat, trk.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#ef2b33', fillOpacity: 1 })
      .bindTooltip(trk.name).addTo(trackLayer);
    for (const km of [10, 25, 50, 100]) {
      L.circle([trk.lat, trk.lon], { radius: km * 1000, color: '#fff', weight: 1, opacity: .55, dashArray: '4 6', fill: false, interactive: false }).addTo(trackLayer);
      L.marker([trk.lat + km / 111.2, trk.lon], { interactive: false, icon: L.divIcon({ className: 'ring-label', html: `${km} km`, iconSize: [40, 14], iconAnchor: [20, 16] }) }).addTo(trackLayer);
    }
  }
  drawTrack();

  // Long press / right click sets a custom track position.
  map.on('contextmenu', ev => {
    const input = h('input', { placeholder: 'Name der Strecke', style: 'width:100%;margin:4px 0' });
    const form = h('form', { onsubmit: e => {
      e.preventDefault();
      const name = input.value.trim(); if (!name) return;
      const t = { id: 'c-' + uid(), name, country: '', lat: +ev.latlng.lat.toFixed(6), lon: +ev.latlng.lng.toFixed(6), custom: true };
      state.customTracks.push(t); state.trackId = t.id; save(); map.closePopup(); refreshTrackSelect(); onTrackChange();
    } }, h('b', { text: 'Eigene Strecke hier anlegen' }), input, h('button', { class: 'btn small primary', type: 'submit' }, 'Anlegen'));
    L.popup().setLatLng(ev.latlng).setContent(form).openOn(map);
    setTimeout(() => input.focus(), 50);
  });
  map.on('zoomend', () => { inst.zoom = map.getZoom(); saveLayout(); });

  const radarLayers = new Map();
  let frameIdx = 0, timer = null, radarOn = true;
  const layerFor = f => {
    if (!radarLayers.has(f.path)) {
      // Free RainViewer tiles go up to zoom 7 natively; Leaflet upscales beyond that.
      radarLayers.set(f.path, L.tileLayer(`${rv.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0, maxNativeZoom: 7, maxZoom: 19, zIndex: 300, className: 'radar-tiles',
      }).addTo(map));
    }
    return radarLayers.get(f.path);
  };
  function showFrame(i) {
    if (!rv.frames.length) return;
    frameIdx = (i + rv.frames.length) % rv.frames.length;
    const f = rv.frames[frameIdx];
    layerFor(f).setOpacity(radarOn ? .7 : 0);
    for (const [p, l] of radarLayers) if (p !== f.path) l.setOpacity(0);
    // preload next frame for smooth animation
    if (rv.frames[frameIdx + 1]) layerFor(rv.frames[frameIdx + 1]);
    slider.value = frameIdx;
    const d = new Date(f.time * 1000), ago = Math.round((Date.now() / 1000 - f.time) / 60);
    ftime.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())} ${f.nowcast ? 'Prognose' : ago <= 10 ? '(aktuell)' : `(−${ago} min)`}`;
  }
  async function refresh() {
    await loadRadarFrames();
    msg.hidden = !rv.error; msg.textContent = rv.error;
    if (!rv.frames.length) return;
    for (const [p, l] of radarLayers) if (!rv.frames.some(f => f.path === p)) { map.removeLayer(l); radarLayers.delete(p); }
    slider.max = rv.frames.length - 1;
    const lastPast = rv.frames.map(f => f.nowcast).lastIndexOf(false);
    if (!timer) showFrame(lastPast);
  }
  play.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; play.textContent = '▶'; play.classList.remove('on'); showFrame(rv.frames.map(f => f.nowcast).lastIndexOf(false)); return; }
    play.textContent = '❚❚'; play.classList.add('on');
    timer = setInterval(() => showFrame(frameIdx + 1), 700);
  });
  slider.addEventListener('input', () => { if (timer) play.click(); showFrame(+slider.value); });
  radarToggle.addEventListener('click', () => { radarOn = !radarOn; radarToggle.classList.toggle('on', radarOn); showFrame(frameIdx); });

  refresh();
  const iv = setInterval(refresh, 5 * 60e3);
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(body);
  return {
    track() { drawTrack(); map.setView([trk.lat, trk.lon], Math.max(map.getZoom(), 8)); },
    destroy() { clearInterval(iv); clearInterval(timer); ro.disconnect(); map.remove(); },
  };
}

/* ---------- Weather (Open-Meteo) ---------- */
const wx = { key: '', data: null, at: 0, error: '' };
async function loadWeather(t) {
  const key = `${t.lat},${t.lon}`;
  if (wx.key === key && Date.now() - wx.at < 10 * 60e3 && wx.data) return wx;
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: t.lat, longitude: t.lon, timezone: 'auto',
    current: 'temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m',
    minutely_15: 'precipitation', forecast_minutely_15: '16',
    hourly: 'precipitation_probability,precipitation,temperature_2m', forecast_hours: '13',
    daily: 'sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max', forecast_days: '4',
  });
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    wx.data = await r.json(); wx.key = key; wx.at = Date.now(); wx.error = '';
  } catch { wx.error = 'Wetterdaten nicht erreichbar (offline oder in dieser Vorschau blockiert).'; if (wx.key !== key) wx.data = null; }
  return wx;
}
const WIND_DIRS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
function rainOutlook(d) {
  // API times are track-local wall clock; convert via the returned UTC offset so any device clock works
  const at = iso => Date.parse(iso + 'Z') - (d.utc_offset_seconds || 0) * 1000;
  const m = d.minutely_15, now = Date.now();
  if (m?.time) {
    for (let i = 0; i < m.time.length; i++) {
      const t = at(m.time[i]);
      if (t + 15 * 60e3 < now) continue;
      if (m.precipitation[i] >= 0.1) {
        const mins = Math.max(0, Math.round((t - now) / 60e3));
        return { wet: true, mins, text: mins <= 0 ? `Regen jetzt (${m.precipitation[i].toFixed(1)} mm / 15 min)` : `Regen ab ca. ${m.time[i].slice(11, 16)} (in ${mins} min)` };
      }
    }
  }
  const hh = d.hourly;
  if (hh?.time) for (let i = 0; i < hh.time.length; i++) {
    if (at(hh.time[i]) + 3600e3 < now) continue;
    if (hh.precipitation_probability[i] >= 50 || hh.precipitation[i] >= 0.3) {
      return { wet: true, mins: Math.round((at(hh.time[i]) - now) / 60e3), text: `Regenrisiko ab ${hh.time[i].slice(11, 16)} (${hh.precipitation_probability[i]} %)` };
    }
  }
  return { wet: false, text: 'Trocken in den nächsten 12 Stunden' };
}

function mountWeather(body) {
  const box = h('div', { class: 'wx' }, h('div', { class: 'muted', text: 'Lade Wetter…' }));
  body.append(box);
  async function refresh() {
    const t = currentTrack();
    await loadWeather(t);
    const d = wx.data;
    if (!d) { box.replaceChildren(h('div', { class: 'wx-head', text: 'Keine Wetterdaten' }), h('div', { class: 'muted', text: wx.error })); return; }
    const c = d.current, out = rainOutlook(d);
    const m = d.minutely_15 || { time: [], precipitation: [] };
    const maxP = Math.max(1, ...m.precipitation);
    const hrs = d.hourly;
    box.replaceChildren(
      h('div', { class: `wx-head ${out.wet ? 'wet' : 'dry'}`, text: out.text }),
      h('div', { class: 'wx-now' },
        h('span', {}, 'Luft ', h('b', { text: `${Math.round(c.temperature_2m)} °C` })),
        h('span', {}, 'Wind ', h('b', { text: `${Math.round(c.wind_speed_10m)} km/h ${WIND_DIRS[Math.round(c.wind_direction_10m / 45) % 8]}` }),
          ' Böen ', h('b', { text: `${Math.round(c.wind_gusts_10m)}` })),
        h('span', {}, 'Wolken ', h('b', { text: `${c.cloud_cover} %` })),
        h('span', {}, 'Feuchte ', h('b', { text: `${c.relative_humidity_2m} %` }))),
      !d.daily?.temperature_2m_max ? '' : h('div', {},
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px', text: 'Nächste Tage' }),
        h('div', { class: 'wx-days' }, d.daily.time.map((day, i) => {
          const p = d.daily.precipitation_probability_max[i] ?? 0, mm = d.daily.precipitation_sum[i] ?? 0;
          return h('div', { class: `wd ${p >= 50 || mm >= 1 ? 'wet' : ''}`, title: `Wind bis ${Math.round(d.daily.wind_speed_10m_max[i])} km/h` },
            h('div', { class: 'wd-day', text: i ? new Date(day + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' }) : 'Heute' }),
            h('div', { class: 'wd-t', text: `${Math.round(d.daily.temperature_2m_max[i])}° / ${Math.round(d.daily.temperature_2m_min[i])}°` }),
            h('div', { class: 'wd-r', text: `${p} % Regen` }), h('div', { class: 'wd-r', text: `${mm.toFixed(1).replace('.', ',')} mm` }));
        }))),
      h('div', {},
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px', text: 'Niederschlag nächste 4 h (mm je 15 min)' }),
        h('div', { class: 'wx-bars' }, m.precipitation.map((p, i) =>
          h('div', { class: `bar ${p < 0.05 ? 'zero' : ''}`, style: `height:${Math.max(2, (p / maxP) * 100)}%`, title: `${m.time[i].slice(11, 16)}: ${p} mm` }))),
        h('div', { class: 'wx-axis' }, ...[0, 4, 8, 12, 15].map(i => h('span', { text: m.time[i]?.slice(11, 16) || '' })))),
      !hrs ? '' : h('div', {},
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px', text: 'Regenwahrscheinlichkeit je Stunde' }),
        h('div', { class: 'wx-hours' }, hrs.time.slice(0, 12).map((t, i) => {
          const p = hrs.precipitation_probability[i] ?? 0;
          return h('div', { class: 'h', style: `background:color-mix(in srgb, var(--rain) ${Math.round(p * .8)}%, transparent)` },
            h('div', { text: t.slice(11, 13) }), h('div', { class: 'p', text: `${p}` }));
        }))),
      h('div', { class: 'wx-foot', text: `${t.name} · Sonne ${d.daily?.sunrise?.[0]?.slice(11, 16) || '–'}–${d.daily?.sunset?.[0]?.slice(11, 16) || '–'} · Stand ${new Date(wx.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · Open-Meteo` }),
    );
    if (state.rainAlert && out.wet && out.mins != null && out.mins <= 60) {
      const key = `rain|${dateKey(new Date())}|${new Date().getHours()}`;
      if (!state.fired[key]) { state.fired[key] = true; save(); showAlert(key, 'Regen', `${out.text} an der Strecke ${t.name}`, 'rain'); }
    }
  }
  refresh();
  const iv = setInterval(refresh, 10 * 60e3);
  return { track: refresh, destroy() { clearInterval(iv); } };
}

/* ---------- Schedule widget ---------- */
let viewDay = dateKey(new Date());
const shiftDay = (key, n) => { const d = new Date(key + 'T12:00'); d.setDate(d.getDate() + n); return dateKey(d); };

function mountSchedule(body, inst) {
  inst.filter = inst.filter || 'all';
  const dayLbl = h('span', { class: 'day' });
  const list = h('ul', { class: 'sched-list' });
  const evBar = h('div', { class: 'sched-event', hidden: true });
  const chips = [['all', 'Alle'], ['mine', 'Meine Klasse'], ['mand', 'Pflichttermine']].map(([k, l]) =>
    h('button', { type: 'button', class: 'chip', 'data-f': k, onclick: () => { inst.filter = k; saveLayout(); render(); } }, l));
  body.append(h('div', { class: 'sched' },
    h('div', { class: 'sched-nav' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Vortag', onclick: () => { viewDay = shiftDay(viewDay, -1); renderAll('day'); } }, '‹'),
      dayLbl,
      h('button', { type: 'button', class: 'icon-btn', title: 'Folgetag', onclick: () => { viewDay = shiftDay(viewDay, 1); renderAll('day'); } }, '›'),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { viewDay = dateKey(new Date()); renderAll('day'); } }, 'Heute'),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => openEditor(viewDay) }, 'Bearbeiten'),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => openImport(viewDay) }, 'Importieren')),
    h('div', { class: 'sched-filters' }, chips), evBar, list));

  let lastSig = '';
  function render(force) {
    const today = dateKey(new Date()), n = nowMin();
    const rows = relevantEntries(viewDay).filter(e =>
      inst.filter === 'all' || (inst.filter === 'mine' ? isMine(e) || isMandForUs(e) || (e.kind === 'lunch' && !e.cls) : isMandForUs(e) || (e.remind && (!e.event || !e.cls || isMine(e)))));
    const sig = `${viewDay}|${inst.filter}|${Math.floor(n)}|${JSON.stringify(rows)}|${state.myClass}`;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    dayLbl.textContent = (viewDay === today ? 'Heute, ' : '') + DAY_SHORT.format(new Date(viewDay + 'T12:00'));
    const ev = eventFor(viewDay);
    evBar.hidden = !ev;
    if (ev) {
      const days = `${DAY_SHORT.format(new Date(ev.from + 'T12:00'))} – ${DAY_SHORT.format(new Date(ev.to + 'T12:00'))}`;
      evBar.replaceChildren(h('b', { text: ev.name }), h('span', { class: 'muted', text: days }), ev.info ? h('span', { class: 'ev-info', text: ev.info }) : '',
        state.events[ev.id] === (ev.rev || 1)
          ? h('span', { class: 'ev-links' }, ev.links.map(([l, u]) => h('a', { href: u, target: '_blank', rel: 'noopener', text: l })))
          : h('button', { type: 'button', class: 'btn small primary', onclick: () => { loadEvent(ev); viewDay = viewDay < ev.from ? ev.from : viewDay; renderAll('day'); } }, state.events[ev.id] ? 'Offiziellen Zeitplan laden' : 'Veranstaltung laden'));
    }
    chips.forEach(c => c.setAttribute('aria-pressed', c.dataset.f === inst.filter));
    list.replaceChildren();
    if (!rows.length) {
      list.append(h('li', { class: 'empty' }, relevantEntries(viewDay).length ? 'Nichts für diesen Filter.' : 'Noch kein Zeitplan für diesen Tag.',
        h('br'), h('button', { type: 'button', class: 'btn primary', onclick: () => openImport(viewDay) }, 'Foto oder Text importieren')));
      return;
    }
    let nextMarked = false, nowEl = null;
    for (const e of rows) {
      const s = toMin(e.start), en = toMin(e.end) ?? s + 5;
      let st = '';
      if (viewDay < today || (viewDay === today && en <= n)) st = 'past';
      else if (viewDay === today && s <= n && n < en) st = 'now';
      else if (!nextMarked && viewDay >= today) { st = 'upcoming'; nextMarked = true; }
      const li = h('li', { class: `sched-item k-${e.kind} ${st} ${isMine(e) ? 'mine' : ''}` },
        h('span', { class: 't', text: e.end ? `${e.start}–${e.end}` : e.start }),
        h('span', { class: 'ti' }, e.title,
          (e.cls && !e.title.includes(e.cls)) || e.pregrid ? h('small', { text: [e.title.includes(e.cls) ? '' : e.cls, e.pregrid && `Vorstart schließt ${e.pregrid}`].filter(Boolean).join(' · ') }) : null),
        h('span', { class: 'badge', text: st === 'now' ? 'läuft' : (wantsReminder(e) ? '🔔 ' : '') + (KINDS[e.kind]?.label || '') }));
      if (st === 'now') { li.append(h('span', { class: 'prog', style: `width:${((n - s) / Math.max(1, en - s)) * 100}%` })); nowEl = li; }
      if (st === 'upcoming' && !nowEl) nowEl = li;
      list.append(li);
    }
    if (nowEl && viewDay === today && !inst._scrolled) { inst._scrolled = true; requestAnimationFrame(() => { list.scrollTop = Math.max(0, nowEl.offsetTop - list.offsetTop - list.clientHeight / 3); }); }
  }
  render(true);
  return { tick: () => render(), day: () => { inst._scrolled = false; render(true); }, data: () => render(true) };
}

/* ---------- Race-day checklist ---------- */
function mountTasks(body) {
  const ul = h('ul', { class: 'tasks' });
  const input = h('input', { placeholder: 'Eigener Punkt, z. B. Benzin holen' });
  body.append(ul, h('form', { class: 'tasks-add', onsubmit: ev => {
    ev.preventDefault(); const v = input.value.trim(); if (!v) return;
    state.tasks.push({ id: 't-' + uid(), label: v, kind: '' }); input.value = ''; save(); render(true);
  } }, input, h('button', { class: 'btn small', type: 'submit' }, '+')));
  let sig = '';
  function render(force) {
    const day = dateKey(new Date()), n = nowMin(), entries = relevantEntries(day);
    const done = state.taskDone[day] || {};
    const s = `${Math.floor(n)}|${JSON.stringify(done)}|${state.tasks.length}|${JSON.stringify(entries)}`;
    if (!force && s === sig) return; sig = s;
    ul.replaceChildren(...state.tasks.map(t => {
      const rule = KIND_RULES.find(([k]) => k === t.kind)?.[1];
      // only appointments that concern our class (not e.g. another class's briefing or a session 'with transponder')
      const hit = x => (x.kind === t.kind || (rule && rule.test(x.title) && KINDS[x.kind]?.mand)) && (!x.event || !x.cls || isMine(x));
      const e = t.kind && (entries.find(x => hit(x) && toMin(x.end || x.start) >= n) || entries.find(hit));
      let when = '', due = false;
      if (e) {
        const left = toMin(e.start) - n;
        const span = e.end ? `${e.start}–${e.end}` : e.start;
        when = left > 0 ? span + (left < 120 ? ` · in ${Math.ceil(left)} min` : '') : toMin(e.end) > n ? `läuft bis ${e.end}` : span;
        due = !done[t.id] && left <= state.lead && toMin(e.end || e.start) > n - 1;
      }
      const cb = h('input', { type: 'checkbox', checked: !!done[t.id], 'aria-label': t.label });
      cb.addEventListener('change', () => { state.taskDone[day] = { ...done, [t.id]: cb.checked }; save(); render(true); });
      return h('li', { class: done[t.id] ? 'done' : '' }, cb,
        h('span', { class: 'lbl', text: t.label }),
        h('span', { class: `when ${due ? 'due' : ''}` }, when,
          !t.kind ? h('button', { type: 'button', class: 'icon-btn', title: 'Entfernen', onclick: () => { state.tasks = state.tasks.filter(x => x !== t); save(); render(true); } }, '×') : null));
    }));
  }
  render(true);
  return { tick: () => render(), data: () => render(true) };
}

/* ---------- Live timing ---------- */
// Apex Timing (South Garda / Lonato and many Italian tracks) streams over a WebSocket; we read that
// feed directly. Other providers (racemon for AKM/DKM) are shown as their own web page for now.
const LIVE_SOURCES = {
  'apex-southgarda': { label: 'South Garda, Lonato (Apex Timing)', kind: 'apex', slug: 'southgardakarting', port: 7440 },
  'racemon-akm':     { label: 'AKM (racemon)', kind: 'web', url: 'https://racemon.motorsport-events.se/#/instance/akm' },
  'eec-kerpen':      { label: 'Eifel-Erft-Cup Kerpen (Camp Company, Link erscheint am Renntag)', kind: 'web', url: 'https://www.camp-company.de/live-timing.php' },
  'youcrono-lonato': { label: 'Lonato (youcrono-Seite)', kind: 'web', url: 'https://youcrono.com/Pagina/5316/LiveLonato' },
  'apex-custom':     { label: 'Andere Strecke mit Apex Timing', kind: 'apex' },
  'web-custom':      { label: 'Andere Livetiming-Webseite', kind: 'web' },
};
const stripTags = v => { const d = document.createElement('div'); d.innerHTML = v; return d.textContent.trim(); };
const COL_TYPES = { rk: 'pos', no: 'nr', dr: 'driver', llp: 'last', blp: 'best', gap: 'gap', int: 'int', tlp: 'laps', pit: 'pits', sta: 'status', grp: 'group' };
const COL_LABELS = [['pos', /^(pos|rk|cla|clt|p\.?)$/i], ['nr', /^(kart|nr|no\.?|n°|#|num)/i], ['driver', /driver|pilot|fahrer|nom|team|name/i],
  ['last', /last|ultimo|dernier|letzte/i], ['best', /best|migliore|meilleur|beste/i], ['gap', /gap|ecart|écart|distacco|abstand/i],
  ['int', /^int|interv/i], ['laps', /laps|giri|tours|runden|^tlp/i], ['pits', /pit/i]];
const colRole = c => COL_TYPES[c.type] || (COL_LABELS.find(([, re]) => re.test(c.label)) || [])[0] || '';

function apexClient(cfg, on) {
  const model = { cols: [], rows: new Map(), title: '', title2: '', dyn: null, dynAt: 0, dynType: '', light: '', msg: '', log: [], at: 0 };
  let ws = null, stopped = false, attempt = 0, timer = null, port = cfg.port ? +cfg.port : null;
  async function resolvePort() {
    if (port) return port;
    try {
      const t = await (await fetch(`https://www.apex-timing.com/live-timing/${encodeURIComponent(cfg.slug)}/javascript/config.js`)).text();
      const m = /configPort\s*=\s*(\d+)/.exec(t); if (m) port = +m[1];
    } catch { /* blocked by the browser: port must be entered by hand */ }
    return port;
  }
  async function connect() {
    if (stopped) return;
    if (!(await resolvePort())) { on.status('Port unbekannt. In den Widget-Einstellungen eintragen (steht als configPort in …/javascript/config.js).', 'err'); return; }
    // Apex serves secure sockets on configPort+3 and plain ones on +2; try both.
    const urls = [`wss://live-data.apex-timing.com:${port + 3}/`, `ws://live-data.apex-timing.com:${port + 2}/`];
    const url = urls[attempt % urls.length];
    let opened = false;
    on.status(`Verbinde (${url.split('//')[0].replace(':', '')}, Port ${url.split(':')[2].replace('/', '')}) …`);
    try { ws = new WebSocket(url); } catch { attempt++; return retry(); }
    ws.onopen = () => { opened = true; attempt = 0; on.status('Verbunden, warte auf Daten …', 'ok'); };
    ws.onmessage = ev => handle(String(ev.data));
    ws.onclose = () => { if (stopped) return; if (!opened) attempt++; on.status(opened ? 'Verbindung getrennt, verbinde neu …' : 'Keine Verbindung, versuche erneut …', 'warn'); retry(); };
  }
  function retry() { clearTimeout(timer); timer = setTimeout(connect, attempt < 4 ? 2000 : 15000); }
  function parseGrid(html) {
    const doc = new DOMParser().parseFromString(`<table>${html}</table>`, 'text/html');
    const trs = [...doc.querySelectorAll('tr')];
    if (!trs.length) return;
    const head = trs.find(tr => tr.dataset.id === 'r0' || /head/i.test(tr.className)) || trs[0];
    const num = (td, i) => +((td.dataset.id || '').replace(/^r\d+/, '').replace(/^c/, '')) || i + 1;
    model.cols = [...head.children].map((td, i) => {
      const c = { n: num(td, i), type: (td.dataset.type || '').toLowerCase(), label: td.textContent.trim() };
      return { ...c, role: colRole(c) };
    });
    model.rows = new Map();
    trs.filter(tr => tr !== head && tr.dataset.id).forEach((tr, i) => {
      const cells = {};
      [...tr.children].forEach((td, j) => { cells[num(td, j)] = { cls: td.className, v: td.textContent.trim() }; });
      model.rows.set(tr.dataset.id, { id: tr.dataset.id, order: i, pos: null, pit: false, cells });
    });
  }
  function handle(frame) {
    for (const line of frame.split('\n')) {
      if (!line.trim()) continue;
      model.log.push(line.length > 240 ? line.slice(0, 240) + '…' : line);
      if (model.log.length > 60) model.log.shift();
      const [key, type = '', ...rest] = line.split('|');
      const val = rest.join('|');
      let m;
      if (key === 'init') { model.rows = new Map(); model.cols = []; }
      else if (key === 'grid') parseGrid(val);
      else if (key === 'title1' || key === 'title') model.title = stripTags(val);
      else if (key === 'title2') model.title2 = stripTags(val);
      else if (key === 'dyn1') {
        if (/count/.test(type) && /^\d+$/.test(val)) { model.dyn = +val; model.dynAt = Date.now(); model.dynType = 'countdown'; }
        else { model.dyn = stripTags(val); model.dynType = 'text'; }
      }
      else if (key === 'light') model.light = type;
      else if (key === 'msg' || key === 'com' || key === 'comments') model.msg = stripTags(val);
      else if ((m = /^(r\d+)c(\d+)$/.exec(key))) { const row = model.rows.get(m[1]); if (row) row.cells[+m[2]] = { cls: type, v: stripTags(val) }; }
      else if ((m = /^(r\d+)$/.exec(key))) {
        const row = model.rows.get(m[1]);
        if (row && type === '#') row.pos = +val;
        if (row && type === '*in') row.pit = true;
        if (row && type === '*out') row.pit = false;
      }
    }
    model.at = Date.now();
    on.update(model);
  }
  connect();
  return { model, stop() { stopped = true; clearTimeout(timer); try { ws?.close(); } catch { /* already closed */ } } };
}

const isOurKart = (nr, driver) => state.myKarts.split(/[,;]/).map(x => x.trim().toLowerCase()).filter(Boolean)
  .some(x => (/^\d+$/.test(x) ? String(nr).trim() === x : String(driver).toLowerCase().includes(x)));

function mountLive(body, inst) {
  inst.src = inst.src || 'apex-southgarda';
  inst.view = inst.view || 'data';
  let client = null, statusText = '', statusLvl = '', showLog = false, showCfg = false;
  const root = h('div', { class: 'live' });
  body.append(root);

  const cfg = () => ({ ...LIVE_SOURCES[inst.src], ...(inst.src.endsWith('custom') ? { slug: inst.slug, port: inst.port, url: inst.url } : {}) });
  function start() {
    client?.stop(); client = null;
    const c = cfg();
    if (c.kind === 'apex' && inst.view === 'data' && c.slug) {
      client = apexClient(c, { update: () => render(), status: (t, l = '') => { statusText = t; statusLvl = l; render(); } });
    } else if (c.kind === 'apex' && !c.slug) { statusText = 'Bitte Apex-Kennung der Strecke eintragen.'; statusLvl = 'err'; }
    render();
  }
  function fmtCountdown(m) {
    if (m.dynType !== 'countdown') return m.dyn || '';
    return fmtDur(Math.max(0, m.dyn - (Date.now() - m.dynAt)) / 60000);
  }
  function configPanel() {
    const c = cfg();
    const sel = h('select', {}, Object.entries(LIVE_SOURCES).map(([k, v]) => h('option', { value: k, selected: k === inst.src }, v.label)));
    const slug = h('input', { value: inst.slug || '', placeholder: 'z. B. southgardakarting' });
    const port = h('input', { value: inst.port || '', placeholder: 'automatisch', inputmode: 'numeric', style: 'max-width:110px' });
    const url = h('input', { value: inst.url || '', placeholder: 'https://…' });
    const karts = h('input', { value: state.myKarts, placeholder: 'z. B. 105, Stiffel' });
    const custom = inst.src.endsWith('custom');
    return h('form', { class: 'live-cfg', onsubmit: ev => {
      ev.preventDefault();
      inst.src = sel.value; inst.slug = slug.value.trim(); inst.port = port.value.trim(); inst.url = url.value.trim();
      state.myKarts = karts.value.trim(); showCfg = false; save(); start();
    } },
      h('label', { class: 'field' }, h('span', { text: 'Quelle' }), sel),
      custom && c.kind === 'apex' ? h('div', { class: 'row-btns' },
        h('label', { class: 'field grow' }, h('span', { text: 'Apex-Kennung (aus apex-timing.com/live-timing/…/)' }), slug),
        h('label', { class: 'field' }, h('span', { text: 'Port' }), port)) : null,
      custom && c.kind === 'web' ? h('label', { class: 'field' }, h('span', { text: 'Adresse der Livetiming-Seite' }), url) : null,
      h('label', { class: 'field' }, h('span', { text: 'Unsere Startnummern oder Namen (werden hervorgehoben)' }), karts),
      h('div', { class: 'row-btns' }, h('button', { class: 'btn primary small', type: 'submit' }, 'Übernehmen'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { showCfg = false; render(); } }, 'Abbrechen')));
  }
  function table(m) {
    const cols = m.cols;
    const roleCol = r => cols.find(c => c.role === r);
    const val = (row, r) => { const c = roleCol(r); return c ? row.cells[c.n]?.v ?? '' : ''; };
    const rows = [...m.rows.values()].map(r => ({ ...r, p: r.pos ?? (parseInt(val(r, 'pos'), 10) || r.order + 1) })).sort((a, b) => a.p - b.p);
    const show = ['pos', 'nr', 'driver', 'last', 'best', 'gap', 'laps', 'pits'].map(roleCol).filter(Boolean);
    const shown = show.length >= 3 ? show : cols.filter(c => c.label);
    const ours = rows.filter(r => isOurKart(val(r, 'nr'), val(r, 'driver')));
    const cellCls = cls => /\btb\b|best.*all|^tb/.test(cls) ? 'lt-ob' : /\bti\b|^ti/.test(cls) ? 'lt-pb' : '';
    return h('div', { class: 'live-data' },
      ours.length ? h('div', { class: 'live-ours' }, ours.map(r => h('div', { class: 'live-card' },
        h('span', { class: 'lc-pos', text: `P${r.p}` }),
        h('span', { class: 'lc-name', text: `#${val(r, 'nr')} ${val(r, 'driver')}` }),
        h('span', { class: 'lc-vals' },
          val(r, 'last') && h('span', {}, 'Letzte ', h('b', { class: cellCls(r.cells[roleCol('last').n]?.cls || ''), text: val(r, 'last') })),
          val(r, 'best') && h('span', {}, 'Beste ', h('b', { text: val(r, 'best') })),
          val(r, 'gap') && h('span', {}, 'Abstand ', h('b', { text: val(r, 'gap') })),
          r.pit ? h('span', { class: 'lc-pit', text: 'BOX' }) : null)))) : null,
      rows.length ? h('div', { class: 'table-wrap live-table' }, h('table', {},
        h('thead', {}, h('tr', {}, shown.map(c => h('th', { text: c.label || c.role })))),
        h('tbody', {}, rows.map(r => h('tr', { class: isOurKart(val(r, 'nr'), val(r, 'driver')) ? 'ours' : '' },
          shown.map(c => h('td', { class: cellCls(r.cells[c.n]?.cls || ''), text: c.role === 'pos' ? r.p : r.cells[c.n]?.v ?? '' }))))))) :
        h('div', { class: `empty live-status ${statusLvl}`, text: m.at ? 'Verbunden. Gerade läuft keine Session mit Daten.' : statusText || 'Warte auf Daten …' }));
  }
  function render() {
    const c = cfg();
    const m = client?.model;
    const flag = { lg: 'green', lr: 'red', ly: 'yellow', lf: 'finish', lc: 'finish' }[m?.light] || '';
    root.replaceChildren(...[
      h('div', { class: 'live-bar' },
        flag ? h('span', { class: `flag f-${flag}`, title: `Flagge: ${flag}` }) : null,
        h('span', { class: 'live-title', text: m?.title ? `${m.title}${m.title2 ? ' · ' + m.title2 : ''}` : c.label }),
        m?.dyn != null ? h('span', { class: 'live-dyn', 'data-dyn': '1', text: fmtCountdown(m) }) : null,
        c.kind === 'apex' ? h('div', { class: 'seg small' },
          h('button', { type: 'button', 'aria-pressed': inst.view === 'data', onclick: () => { inst.view = 'data'; save(); start(); } }, 'Daten'),
          h('button', { type: 'button', 'aria-pressed': inst.view === 'web', onclick: () => { inst.view = 'web'; save(); start(); } }, 'Webseite')) : null,
        h('button', { type: 'button', class: 'icon-btn', title: 'Livetiming einstellen', onclick: () => { showCfg = !showCfg; render(); } }, '⚙')),
      showCfg ? configPanel() : null,
      m?.msg ? h('div', { class: 'live-msg', text: m.msg }) : null,
      ...(c.kind === 'web' || inst.view === 'web' ? webView(c) : [m ? table(m) : h('div', { class: 'empty', text: statusText || 'Livetiming einstellen' })]),
      c.kind === 'apex' && inst.view === 'data' ? h('div', { class: 'live-foot' },
        h('a', { href: c.slug ? `https://www.apex-timing.com/live-timing/${c.slug}/index.html` : '#', target: '_blank', rel: 'noopener' }, 'Original öffnen ↗'),
        h('button', { type: 'button', class: 'linkish', onclick: () => { showLog = !showLog; render(); } }, showLog ? 'Rohdaten ausblenden' : 'Rohdaten'),
        m?.at ? h('span', { class: 'muted', text: `Stand ${new Date(m.at).toLocaleTimeString('de-DE')}` }) : null,
        m?.rows.size && statusLvl === 'warn' ? h('span', { class: 'live-status warn', text: statusText }) : null) : null,
      showLog && m ? h('pre', { class: 'live-log', text: m.log.slice(-30).join('\n') || '(noch nichts empfangen)' }) : null,
    ].filter(Boolean));
  }
  function webView(c) {
    const url = c.kind === 'apex' ? `https://www.apex-timing.com/live-timing/${c.slug}/index.html` : c.url;
    if (!url) return [h('div', { class: 'empty', text: 'Bitte die Adresse der Livetiming-Seite eintragen (⚙).' })];
    return [h('iframe', { class: 'live-frame', src: url, referrerpolicy: 'no-referrer', title: 'Livetiming' }),
      h('div', { class: 'live-foot' }, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'In eigenem Fenster öffnen ↗'),
        h('span', { class: 'muted', text: 'Bleibt die Fläche leer, erlaubt die Seite keine Einbettung.' }))];
  }
  start();
  return {
    tick() { const el = $('[data-dyn]', root); if (el && client?.model.dynType === 'countdown') el.textContent = fmtCountdown(client.model); },
    data: render,
    destroy() { client?.stop(); },
  };
}

/* ---------- Grid / layout ---------- */
const mounted = new Map(); // inst.id -> api
let editing = false;
const layout = () => state.layouts[state.mode];
function saveLayout() { save(); }

/* Layout model: every widget has x (column 0–11), y (row), w and h in grid cells. Moves and resizes
   push overlapping widgets down and then let everything float up (like a magnet board), so what the
   placeholder shows while dragging is exactly where things end up. */
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function firstFit(placed, w, h) {
  for (let y = 0; ; y++) for (let x = 0; x <= 12 - w; x++) {
    const c = { x, y, w, h };
    if (!placed.some(p => overlaps(c, p))) return c;
  }
}
// Give layouts saved before positions existed a position, in their old order.
function ensurePositions(list) {
  const placed = [];
  for (const it of list) {
    it.w = Math.min(12, Math.max(1, it.w || 4)); it.h = Math.max(1, it.h || 2);
    if (!Number.isInteger(it.x) || !Number.isInteger(it.y)) Object.assign(it, firstFit(placed, it.w, it.h));
    placed.push(it);
  }
  return list;
}
function compact(items) {
  const out = [];
  for (const it of items.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = it.y;
    while (y > 0 && !out.some(o => overlaps({ ...it, y: y - 1 }, o))) y--;
    out.push({ ...it, y });
  }
  return out;
}
// Place `moved` at its new box, push colliding widgets down, then compact. Returns a new list of boxes.
function resolveLayout(list, moved) {
  const placed = [moved];
  for (const it of list.filter(i => i.id !== moved.id).sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = it.y;
    while (placed.some(p => overlaps({ ...it, y }, p))) y++;
    placed.push({ ...it, y });
  }
  return compact(placed);
}
const boxOf = it => ({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h });
function placeCard(card, b) {
  card.style.gridColumn = `${b.x + 1} / span ${b.w}`;
  card.style.gridRow = `${b.y + 1} / span ${b.h}`;
  card.style.order = b.y * 12 + b.x; // stacking order on phones
  card.style.setProperty('--mh', b.h);
}
function commitBoxes(boxes) {
  for (const b of boxes) {
    const it = layout().find(i => i.id === b.id);
    if (it) Object.assign(it, { x: b.x, y: b.y, w: b.w, h: b.h });
  }
  save();
  applyPositions();
}
function applyPositions(boxes = layout().map(boxOf)) {
  for (const b of boxes) { const card = $(`.widget[data-id="${b.id}"]`); if (card) placeCard(card, b); }
  if (editing) drawCells(boxes);
}
// Faint cells in edit mode so you can see where widgets snap.
function drawCells(boxes) {
  const grid = $('#grid');
  $$('.cell', grid).forEach(c => c.remove());
  const rows = Math.max(8, ...boxes.map(b => b.y + b.h)) + 3;
  const frag = document.createDocumentFragment();
  for (let y = 0; y < rows; y++) for (let x = 0; x < 12; x++)
    frag.append(h('div', { class: 'cell', style: `grid-column:${x + 1};grid-row:${y + 1}` }));
  grid.prepend(frag);
}
function gridMetrics() {
  const grid = $('#grid'), r = grid.getBoundingClientRect(), cs = getComputedStyle(grid);
  const gap = parseFloat(cs.columnGap) || 12, pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight), pt = parseFloat(cs.paddingTop);
  const colW = (r.width - pl - pr - gap * 11) / 12;
  const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 78;
  return { left: r.left + pl, top: r.top + pt, colW, rowH, gap, stepX: colW + gap, stepY: rowH + gap };
}

function renderGrid() {
  for (const api of mounted.values()) api.destroy?.();
  mounted.clear();
  const grid = $('#grid');
  grid.replaceChildren();
  grid.classList.toggle('editing', editing);
  ensurePositions(layout());
  for (const inst of layout()) {
    const def = WIDGETS[inst.type];
    if (!def) continue;
    const body = h('div', { class: 'w-body' });
    const wSel = h('select', { title: 'Breite' }, [2, 3, 4, 5, 6, 8, 12].map(v => h('option', { value: v, selected: v === inst.w }, `${v}/12`)));
    const hSel = h('select', { title: 'Höhe' }, [1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map(v => h('option', { value: v, selected: v === inst.h }, `${v} hoch`)));
    const card = h('section', { class: 'widget', 'data-id': inst.id },
      h('header', { class: 'w-head' },
        h('span', { class: 'w-grip w-edit', 'aria-hidden': 'true' }, '⠿'),
        h('span', { class: 'w-title', text: def.title }),
        h('div', { class: 'w-edit' }, wSel, hSel,
          h('button', { type: 'button', class: 'icon-btn', title: 'Entfernen', onclick: () => { state.layouts[state.mode] = layout().filter(x => x !== inst); save(); renderGrid(); } }, '×'))),
      body,
      h('div', { class: 'w-resize', title: 'Größe ziehen', 'aria-hidden': 'true' }));
    const setSize = (w, hh) => {
      const b = { ...boxOf(inst), w, h: hh, x: Math.min(inst.x, 12 - w) };
      commitBoxes(resolveLayout(layout().map(boxOf), b));
    };
    wSel.addEventListener('change', () => setSize(+wSel.value, inst.h));
    hSel.addEventListener('change', () => setSize(inst.w, +hSel.value));
    wireDrag(card, inst);
    placeCard(card, inst);
    grid.append(card);
    try { mounted.set(inst.id, def.mount(body, inst) || {}); }
    catch (err) { body.append(h('div', { class: 'empty', text: `Widget konnte nicht starten: ${err.message}` })); }
  }
  if (editing) drawCells(layout().map(boxOf));
  if (!layout().length) grid.append(h('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Keine Widgets. ', h('button', { class: 'btn primary', type: 'button', onclick: openAdd }, 'Widget hinzufügen')));
  tick();
}

// Pointer-based move (grab the title bar) and resize (grab the corner) with a live snap preview.
function wireDrag(card, inst) {
  const start = (ev, mode) => {
    if (!editing || ev.button > 0 || ev.target.closest('select, button, input')) return;
    if (matchMedia('(max-width: 760px)').matches) return;
    ev.preventDefault();
    const m = gridMetrics(), r = card.getBoundingClientRect();
    const grabX = ev.clientX - r.left, grabY = ev.clientY - r.top;
    const base = layout().map(boxOf);
    const ph = h('div', { class: 'placeholder' });
    $('#grid').append(ph);
    card.classList.add(mode === 'move' ? 'dragging' : 'resizing');
    if (mode === 'move') Object.assign(card.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: 50 });
    let preview = base;
    const onMove = e => {
      let b;
      if (mode === 'move') {
        card.style.left = `${e.clientX - grabX}px`; card.style.top = `${e.clientY - grabY}px`;
        const x = Math.round((e.clientX - grabX - m.left) / m.stepX), y = Math.round((e.clientY - grabY - m.top) / m.stepY);
        b = { ...boxOf(inst), x: Math.max(0, Math.min(12 - inst.w, x)), y: Math.max(0, y) };
      } else {
        const w = Math.round((e.clientX - r.left + m.gap) / m.stepX), hh = Math.round((e.clientY - r.top + m.gap) / m.stepY);
        b = { ...boxOf(inst), w: Math.max(2, Math.min(12 - inst.x, w)), h: Math.max(1, hh) };
      }
      preview = resolveLayout(base, b);
      const mine = preview.find(p => p.id === inst.id);
      ph.style.gridColumn = `${mine.x + 1} / span ${mine.w}`; ph.style.gridRow = `${mine.y + 1} / span ${mine.h}`;
      ph.textContent = mode === 'resize' ? `${mine.w}/12 × ${mine.h}` : '';
      applyPositions(preview.filter(p => mode === 'resize' || p.id !== inst.id));
      // keep the page scrolling when dragging near the bottom or top edge
      if (e.clientY > innerHeight - 40) scrollBy(0, 16); else if (e.clientY < 80) scrollBy(0, -16);
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); removeEventListener('pointercancel', onUp);
      ph.remove(); card.classList.remove('dragging', 'resizing');
      Object.assign(card.style, { position: '', left: '', top: '', width: '', height: '', zIndex: '' });
      commitBoxes(preview);
      $$('select', card).forEach((s, i) => { s.value = i === 0 ? inst.w : inst.h; });
    };
    addEventListener('pointermove', onMove); addEventListener('pointerup', onUp); addEventListener('pointercancel', onUp);
    onMove(ev);
  };
  $('.w-head', card).addEventListener('pointerdown', ev => start(ev, 'move'));
  $('.w-resize', card).addEventListener('pointerdown', ev => start(ev, 'resize'));
}

function renderAll(what) { for (const api of mounted.values()) api[what]?.(); }
function tick() { renderAll('tick'); }
function onTrackChange() { wx.at = 0; renderAll('track'); }

/* ---------- Dialogs: add widget ---------- */
function openAdd() {
  $('#add-list').replaceChildren(...Object.entries(WIDGETS).map(([k, d]) =>
    h('button', { type: 'button', onclick: () => {
      const size = (DEFAULT_LAYOUTS[state.mode].find(x => x.type === k) || DEFAULT_LAYOUTS.race.find(x => x.type === k) || { w: 4, h: 3 });
      ensurePositions(layout());
      layout().push({ id: uid(), type: k, ...firstFit(layout(), size.w, size.h) }); save(); $('#dlg-add').close(); renderGrid();
    } }, h('b', { text: d.title }), h('span', { text: d.desc }))));
  $('#dlg-add').showModal();
}

/* ---------- Dialogs: schedule editor ---------- */
const kindSelect = val => h('select', { 'data-f': 'kind' }, Object.entries(KINDS).map(([k, v]) => h('option', { value: k, selected: k === val }, v.label)));
function rowEl(e, day) {
  return h('tr', { 'data-id': e.id || uid() },
    h('td', {}, h('input', { type: 'date', 'data-f': 'date', value: e.date || day || '' })),
    h('td', {}, h('input', { type: 'time', 'data-f': 'start', value: e.start || '', required: true })),
    h('td', {}, h('input', { type: 'time', 'data-f': 'end', value: e.end || '' })),
    h('td', {}, h('input', { type: 'time', 'data-f': 'pregrid', value: e.pregrid || '', title: 'Vorstart schließt' })),
    h('td', {}, kindSelect(e.kind || 'other')),
    h('td', {}, h('input', { 'data-f': 'title', value: e.title || '' })),
    h('td', {}, h('input', { 'data-f': 'cls', value: e.cls || '', style: 'min-width:90px' })),
    h('td', {}, h('input', { type: 'checkbox', 'data-f': 'remind', checked: !!e.remind })),
    h('td', {}, h('button', { type: 'button', class: 'icon-btn', title: 'Zeile löschen', onclick: ev => ev.target.closest('tr').remove() }, '×')));
}
function readRows(tbody) {
  return $$('tr', tbody).map(tr => {
    const g = f => $(`[data-f="${f}"]`, tr);
    return { id: tr.dataset.id, date: g('date').value, start: g('start').value, end: g('end').value, pregrid: g('pregrid').value, kind: g('kind').value, title: g('title').value.trim(), cls: g('cls').value.trim(), remind: g('remind').checked };
  }).filter(e => e.start && e.title).sort((a, b) => toMin(a.start) - toMin(b.start));
}
// Sort rows into their days (rows without a date go to fallbackDay). Returns the days touched.
function storeRows(rows, fallbackDay, replace) {
  const byDay = {};
  for (const r of rows) { const d = r.date || fallbackDay; (byDay[d] ||= []).push({ ...r, date: undefined }); }
  for (const [d, list] of Object.entries(byDay)) {
    const keep = replace ? [] : (state.schedule[d] || []);
    state.schedule[d] = [...keep, ...list].sort((a, b) => toMin(a.start) - toMin(b.start));
  }
  return Object.keys(byDay).sort();
}

function openEditor(day) {
  const dlg = $('#dlg-edit');
  $('#edit-date').textContent = DAY_SHORT.format(new Date(day + 'T12:00'));
  $('#edit-rows').replaceChildren(...relevantEntries(day).map(e => rowEl(e, day)));
  if (!relevantEntries(day).length) $('#edit-rows').append(rowEl({}, day));
  $('#btn-row-add').onclick = () => { $('#edit-rows').append(rowEl({}, day)); $('#edit-rows tr:last-child input[type=time]').focus(); };
  $('#btn-day-clear').onclick = ev => armConfirm(ev.currentTarget, 'Wirklich leeren?', () => $('#edit-rows').replaceChildren());
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return;
    delete state.schedule[day];
    storeRows(readRows($('#edit-rows')), day, false);
    save(); renderAll('data');
  };
  dlg.returnValue = '';
  dlg.showModal();
}

/* ---------- Dialogs: import (photo / text) ---------- */
let sampleFn = null;
if (window.claude?.use) window.claude.use('sample').then(s => { sampleFn = s; $('#btn-parse-ai').hidden = !s; }).catch(() => {});

const AI_PROMPT = `Du liest den Tageszeitplan einer Kartbahn oder eines Kartrennens (Deutsch, Englisch oder Italienisch).
Gib ausschließlich JSON zurück: {"entries":[{"date":"YYYY-MM-DD falls der Plan mehrere Tage oder ein Datum zeigt, sonst null","start":"HH:MM","end":"HH:MM oder leer","pregrid":"Vorstart-Schluss HH:MM oder leer","title":"Text wie im Plan","class":"Klasse wie OK Junior, X30 Senior, KZ2, Rotax Max, Mini, Leihkart oder leer","kind":"session|briefing|tyres|transponder|papers|scrut|lunch|rental|other"}]}
Regeln: Eine Zeile pro Zeitslot. Fahrerbesprechung=briefing, Reifenausgabe/-registrierung=tyres, Transponder=transponder, Papier-/Dokumentenabnahme/Nennung=papers, Technische Abnahme/Wiegen=scrut, Mittagspause/Pause=lunch, Leihkart-/Mietkartbetrieb=rental, Trainings/Qualifying/Heats/Rennen=session. Erfinde nichts, lies nur was im Plan steht.`;

let importDay = null;
function setImportRows(rows) {
  $('#import-rows').replaceChildren(...rows.map(e => rowEl(e, importDay)));
  const days = [...new Set(rows.map(r => r.date).filter(Boolean))];
  $('#import-status').textContent = rows.length
    ? `${rows.length} Termine erkannt${days.length > 1 ? ` an ${days.length} Tagen` : ''}. Bitte prüfen und bei Bedarf korrigieren.`
    : 'Keine Uhrzeiten erkannt. Text prüfen oder Zeilen von Hand ergänzen.';
  // Plans sometimes carry a wrong or last year's date: offer to move all rows, keeping the gaps between days
  const first = days.slice().sort()[0], bar = $('#import-redate');
  bar.hidden = !first || first >= dateKey(new Date());
  if (!bar.hidden) {
    // suggest the next date on the same weekday as the plan's first day (a Saturday plan lands on Saturday)
    let to = dateKey(new Date());
    while (new Date(to + 'T12:00').getDay() !== new Date(first + 'T12:00').getDay()) to = shiftDay(to, 1);
    $('#redate-day').value = to;
    $('#btn-redate').onclick = () => {
      const to = $('#redate-day').value; if (!to) return;
      const diff = Math.round((new Date(to + 'T12:00') - new Date(first + 'T12:00')) / 864e5);
      $$('#import-rows input[data-f=date]').forEach(i => { if (i.value) i.value = shiftDay(i.value, diff); });
      bar.hidden = true;
    };
  }
}
function fromAi(json) {
  const entries = (json?.entries || []).map(e => ({
    start: (e.start || '').slice(0, 5).padStart(5, '0'), end: (e.end || '').slice(0, 5) ? (e.end || '').slice(0, 5).padStart(5, '0') : '',
    title: e.title || '', cls: e.class || '', kind: KINDS[e.kind] ? e.kind : 'other', remind: false,
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : undefined, pregrid: /^\d{1,2}:\d{2}/.test(e.pregrid || '') ? e.pregrid.slice(0, 5).padStart(5, '0') : '',
  })).filter(e => toMin(e.start) != null);
  return finishRows(entries);
}

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  tesseractLoading = tesseractLoading || new Promise((res, rej) => {
    const s = h('script', { src: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js' });
    s.onload = () => res(window.Tesseract); s.onerror = () => { tesseractLoading = null; rej(new Error('Texterkennung konnte nicht geladen werden (Internet nötig).')); };
    document.head.append(s);
  });
  return tesseractLoading;
}
let pdfLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  const add = src => new Promise((res, rej) => { const s = h('script', { src }); s.onload = res; s.onerror = () => rej(new Error('PDF-Leser konnte nicht geladen werden.')); document.head.append(s); });
  // The worker script goes in first: pdf.js then runs it in the page, since file:// pages cannot start workers.
  pdfLoading = pdfLoading || add('vendor/pdfjs/pdf.worker.min.js').then(() => add('vendor/pdfjs/pdf.min.js')).then(() => window.pdfjsLib)
    .catch(err => { pdfLoading = null; throw err; });
  return pdfLoading;
}
// Rebuild the printed lines of a PDF; wide horizontal gaps become runs of spaces so table columns survive.
async function pdfToText(file) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items.filter(i => i.str.trim())
      .map(i => ({ x: i.transform[4], y: i.transform[5], w: i.width, s: i.str }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      const row = rows.find(r => Math.abs(r.y - it.y) < 3);
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    for (const r of rows.sort((a, b) => b.y - a.y)) {
      r.items.sort((a, b) => a.x - b.x);
      let txt = '', end = null;
      for (const it of r.items) {
        const gap = end == null ? 0 : it.x - end;
        txt += end == null ? '' : gap > 8 ? '    ' : gap > 1.5 ? ' ' : '';
        txt += it.s; end = it.x + it.w;
      }
      lines.push(txt);
    }
  }
  return lines.join('\n');
}
async function handlePdf(file) {
  const status = $('#import-status');
  $('#import-preview').hidden = true;
  status.textContent = 'Lese PDF…';
  try {
    const text = await pdfToText(file);
    $('#import-text').value = text;
    if (!text.trim()) { status.textContent = 'Das PDF enthält keinen Text (eingescannt?). Bitte als Foto/Screenshot importieren.'; return; }
    setImportRows(parseScheduleText(text));
  } catch (err) { status.textContent = err.message; }
}
async function handlePhoto(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return handlePdf(file);
  const status = $('#import-status');
  const img = $('#import-preview');
  img.src = URL.createObjectURL(file); img.hidden = false;
  if (sampleFn) {
    status.textContent = 'Claude liest den Zeitplan…';
    try {
      const json = await sampleFn.json(AI_PROMPT, { images: [file], modelTier: 'default' });
      setImportRows(fromAi(json));
      return;
    } catch (err) { status.textContent = `Claude nicht verfügbar (${err.code || err.message}), nutze Texterkennung…`; }
  }
  try {
    status.textContent = 'Lade Texterkennung…';
    const T = await loadTesseract();
    const r = await T.recognize(file, 'deu+eng+ita', { logger: m => { if (m.status === 'recognizing text') status.textContent = `Texterkennung ${Math.round(m.progress * 100)} %`; } });
    $('#import-text').value = r.data.text;
    setImportRows(parseScheduleText(r.data.text));
  } catch (err) { status.textContent = err.message; }
}
function openImport(day) {
  importDay = day;
  const dlg = $('#dlg-import');
  $('#import-date').textContent = DAY_SHORT.format(new Date(day + 'T12:00'));
  $('#import-rows').replaceChildren(); $('#import-status').textContent = ''; $('#import-preview').hidden = true;
  $('#import-photo').value = '';
  $('#import-photo').onchange = ev => ev.target.files[0] && handlePhoto(ev.target.files[0]);
  $('#btn-parse').onclick = () => setImportRows(parseScheduleText($('#import-text').value));
  $('#btn-parse-ai').onclick = async () => {
    $('#import-status').textContent = 'Claude wertet den Text aus…';
    try { setImportRows(fromAi(await sampleFn.json(`${AI_PROMPT}\n\nZeitplan:\n${$('#import-text').value}`, { modelTier: 'default' }))); }
    catch (err) { $('#import-status').textContent = `Claude nicht verfügbar (${err.code || err.message}).`; }
  };
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return;
    const days = storeRows(readRows($('#import-rows')), day, $('#import-replace').checked);
    if (days.length && !days.includes(viewDay)) viewDay = days.includes(dateKey(new Date())) ? dateKey(new Date()) : days[0];
    save(); renderAll('day'); renderAll('data');
  };
  dlg.returnValue = '';
  dlg.showModal();
}

/* ---------- Settings ---------- */
function openSettings() {
  const f = $('#settings-form');
  f.myClass.value = state.myClass; f.lead.value = state.lead; f.myKarts.value = state.myKarts;
  f.remindSessions.checked = state.remindSessions; f.rainAlert.checked = state.rainAlert;
  $('#notify-state').textContent = !('Notification' in window) ? 'nicht unterstützt' : Notification.permission === 'granted' ? 'erlaubt' : Notification.permission === 'denied' ? 'abgelehnt' : '';
  $('#track-results').replaceChildren(...state.customTracks.map(customTrackRow));
  const dlg = $('#dlg-settings');
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return;
    state.myClass = f.myClass.value.trim(); state.lead = Math.max(0, +f.lead.value || 0); state.myKarts = f.myKarts.value.trim();
    state.remindSessions = f.remindSessions.checked; state.rainAlert = f.rainAlert.checked;
    save(); renderAll('data'); tick();
  };
  dlg.returnValue = '';
  dlg.showModal();
}
function customTrackRow(t) {
  return h('li', {}, h('span', { text: `${t.name} (${t.lat.toFixed(3)}, ${t.lon.toFixed(3)})` }),
    h('button', { type: 'button', class: 'btn small ghost danger', onclick: ev => {
      state.customTracks = state.customTracks.filter(x => x.id !== t.id);
      if (state.trackId === t.id) state.trackId = TRACKS[0].id;
      save(); ev.target.closest('li').remove(); refreshTrackSelect(); onTrackChange();
    } }, 'Löschen'));
}
async function searchTrack() {
  const q = $('#track-search').value.trim(); if (!q) return;
  const ul = $('#track-results');
  ul.replaceChildren(h('li', { text: 'Suche…' }));
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'json', limit: '6', 'accept-language': 'de' }));
    const res = await r.json();
    ul.replaceChildren(...(res.length ? res : [{ display_name: 'Nichts gefunden' }]).map(x => h('li', {},
      h('span', { text: x.display_name }),
      x.lat ? h('button', { type: 'button', class: 'btn small', onclick: () => {
        const t = { id: 'c-' + uid(), name: x.display_name.split(',')[0], country: '', lat: +(+x.lat).toFixed(6), lon: +(+x.lon).toFixed(6), custom: true };
        state.customTracks.push(t); state.trackId = t.id; save(); refreshTrackSelect(); onTrackChange();
        ul.replaceChildren(...state.customTracks.map(customTrackRow));
      } }, 'Übernehmen') : null)));
  } catch { ul.replaceChildren(h('li', { text: 'Suche nicht erreichbar (offline oder blockiert). Alternativ im Radar rechtsklicken.' })); }
}

function exportData() {
  const blob = new Blob([JSON.stringify({ ...state, fired: {} }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `mad-boxenmauer-${dateKey(new Date())}.json` });
  document.body.append(a); a.click(); a.remove();
}
async function importData(file) {
  try {
    const s = JSON.parse(await file.text());
    if (!s.layouts) throw new Error();
    Object.assign(state, s, { fired: {}, sound: state.sound }); save();
    refreshTrackSelect(); setMode(state.mode);
  } catch { $('#notify-state').textContent = 'Sicherungsdatei konnte nicht gelesen werden.'; }
}

/* ---------- Top bar ---------- */
function refreshTrackSelect() {
  const sel = $('#track-select');
  const group = (label, list) => h('optgroup', { label }, list.map(t => h('option', { value: t.id, selected: t.id === state.trackId }, t.name)));
  const by = c => TRACKS.filter(t => t.country === c).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  sel.replaceChildren(group('Deutschland', by('DE')), group('Italien', by('IT')), group('Tschechien', by('CZ')),
    state.customTracks.length ? group('Eigene', state.customTracks) : '');
}
function setMode(mode) {
  state.mode = mode; save();
  $$('.seg [data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
  renderGrid();
}
function setEditing(on) {
  editing = on;
  $('#edit-bar').hidden = !on;
  $('#btn-edit').hidden = on;
  renderGrid();
}

// Browser fullscreen like a video player: button or F key, Esc leaves. While fullscreen, the
// top bar hides after a few idle seconds and comes back on mouse move or touch.
function wireFullscreen() {
  const root = document.documentElement, btn = $('#btn-fs');
  const enter = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (!enter || !(document.fullscreenEnabled || document.webkitFullscreenEnabled)) return;
  btn.hidden = false;
  const toggle = () => { try { const r = current() ? exit.call(document) : enter.call(root); r && r.catch && r.catch(() => {}); } catch {} };
  let idle;
  const wake = () => {
    root.classList.remove('fs-idle'); clearTimeout(idle);
    if (!current()) return;
    const topbar = $('.topbar');
    root.style.setProperty('--topbar-h', topbar.offsetHeight + 4 + 'px');
    idle = setTimeout(() => {
      if (editing || topbar.matches(':hover, :focus-within') || document.querySelector('dialog[open]')) return wake();
      root.classList.add('fs-idle');
    }, 3000);
  };
  const changed = () => {
    const on = !!current();
    root.classList.toggle('fs', on);
    btn.setAttribute('aria-pressed', on);
    btn.title = on ? 'Vollbild beenden (F)' : 'Vollbild (F)';
    btn.setAttribute('aria-label', on ? 'Vollbild beenden' : 'Vollbild');
    wake();
  };
  btn.addEventListener('click', () => { btn.blur(); toggle(); });
  document.addEventListener('fullscreenchange', changed);
  document.addEventListener('webkitfullscreenchange', changed);
  ['pointermove', 'pointerdown', 'keydown'].forEach(t => document.addEventListener(t, wake, { passive: true }));
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'f' && ev.key !== 'F' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest('input, textarea, select, [contenteditable], dialog')) return;
    ev.preventDefault(); toggle();
  });
}

function init() {
  // First start on a new device during a prepared race weekend (or the week before): set it up right away.
  const upcoming = FRESH && eventFor(dateKey(new Date()));
  if (upcoming) { state.seeded = true; loadEvent(upcoming); if (viewDay < upcoming.from) viewDay = upcoming.from; }
  seedExample();
  wireFullscreen();
  refreshTrackSelect();
  $('#track-select').addEventListener('change', ev => { state.trackId = ev.target.value; save(); onTrackChange(); });
  $$('.seg [data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#btn-edit').addEventListener('click', () => setEditing(true));
  $('#btn-edit-done').addEventListener('click', () => setEditing(false));
  $('#btn-add').addEventListener('click', openAdd);
  $('#btn-reset').addEventListener('click', ev => armConfirm(ev.currentTarget, 'Wirklich zurücksetzen?', () => { state.layouts[state.mode] = withIds(DEFAULT_LAYOUTS[state.mode]); save(); renderGrid(); }));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-sound').addEventListener('click', () => {
    state.sound = !state.sound;
    $('#btn-sound').textContent = state.sound ? 'Ton an' : 'Ton aus';
    $('#btn-sound').classList.toggle('on', state.sound);
    if (state.sound) beep(1);
  });
  $('#btn-notify').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    try { $('#notify-state').textContent = (await Notification.requestPermission()) === 'granted' ? 'erlaubt' : 'nicht erlaubt'; }
    catch { $('#notify-state').textContent = 'hier nicht möglich'; }
  });
  $('#btn-track-search').addEventListener('click', searchTrack);
  $('#track-search').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); searchTrack(); } });
  $('#btn-export').addEventListener('click', exportData);
  $('#import-json').addEventListener('change', ev => ev.target.files[0] && importData(ev.target.files[0]));
  setMode(state.mode);

  let lastDay = dateKey(new Date());
  setInterval(() => {
    const d = dateKey(new Date());
    if (d !== lastDay) { if (viewDay === lastDay) viewDay = d; lastDay = d; renderAll('day'); }
    tick(); checkReminders();
  }, 1000);
}

// expose parser for tests
window.MAD = { parseScheduleText, state };
init();
})();
