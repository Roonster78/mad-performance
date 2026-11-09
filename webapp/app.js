/* MAD Performance Karting · Telemetrie-Prototyp
 * Liest ALFANO-7-Sessions (.alf2 = ZIP, eine 10-Hz-CSV pro Runde) direkt im Browser.
 * Keine Abhängigkeiten: ZIP wird mit DecompressionStream('deflate-raw') entpackt,
 * Daten liegen in IndexedDB dieses Browsers.
 */
(() => {
'use strict';

/* ---------- ZIP ---------- */

function readZip(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige .alf2/ZIP-Datei');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder('latin1');
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const off = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const raw = new Uint8Array(buf, off, e.compSize);
      let bytes = raw;
      if (e.method === 8) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else if (e.method !== 0) throw new Error('ZIP-Methode ' + e.method + ' nicht unterstützt');
      return dec.decode(bytes);
    },
  };
}

/* ---------- ALFANO parsing ---------- */

const TRACKS = {
  'MUELSEN ARENA-E': 'Mülsen Arena E',
  'SOUTH GARDA': 'South Garda · Lonato',
  'KARTODROMO CREMONA CIRCUIT - 2': 'Cremona',
  'LIEDOLSHEIM': 'Liedolsheim',
  'FRANCIACORTA KARTING': 'Franciacorta',
  'PISTA AZZURRA': 'Pista Azzurra · Jesolo',
  'WACKERSDORF': 'Wackersdorf',
  'AMPFING': 'Ampfing',
  'YPSILONKA CHEB': 'Cheb',
  'BOPFINGEN': 'Bopfingen',
  'ALA KARTING CIRCUIT': 'Ala',
  'CIRCUITO SAN MARTINO': 'San Martino',
  'CASTREZZATO ARENA': 'Castrezzato Arena',
  'KERPEN': 'Erftlandring Kerpen',
  'ERFTLANDRING': 'Erftlandring Kerpen',
  'ERFTLANDRING KERPEN': 'Erftlandring Kerpen',
};
function trackName(raw) {
  const k = raw.replace(/^\*P\*\s*/, '').replace(/\s+\d{2}\/\d{2}\/\d{2}\s*$/, '').trim();
  if (TRACKS[k]) return TRACKS[k];
  if (/KERPEN|ERFTLAND/i.test(k)) return 'Erftlandring Kerpen';
  return k.toLowerCase().replace(/(^|[\s-])\S/g, s => s.toUpperCase());
}
const DEFAULT_DRIVERS = new Set(['ALFANO_7', 'ALFANO 7']);
function looksDefaultDriver(raw) { return DEFAULT_DRIVERS.has(raw) || /^Driver_\d+$/i.test(raw); }
function prettyDriver(raw) { return raw.replace(/_/g, ' ').trim(); }

function csvRows(text) {
  return text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(','));
}

async function parseSummary(fileName, buf) {
  const zip = readZip(buf);
  const snName = zip.names.find(n => /^SN\d+_.*\.csv$/i.test(n));
  if (!snName) throw new Error('Sessiondatei fehlt in ' + fileName);
  const rows = csvRows(await zip.text(snName));
  const h = rows[0];
  const [dd, mm, yyyy] = h[0].split('-');
  const cols = rows[1].map(c => c.trim());
  const ci = n => cols.indexOf(n);
  const laps = rows.slice(2).map(r => {
    const g = n => { const i = ci(n); return i < 0 ? 0 : parseInt(r[i], 10) || 0; };
    const sectors = [1, 2, 3, 4, 5, 6].map(k => g('time partiel ' + k)).filter(v => v > 0);
    return {
      n: g('lap'), time: g('time lap'), sectors,
      maxRpm: g('Max RPM'), minSpeed: g('Min Speed GPS') / 10, maxSpeed: g('Max Speed GPS') / 10,
      maxT1: g('Max T1') / 10, maxT2: g('Max T2') / 10,
    };
  }).filter(l => l.n > 0 && l.time > 0);
  const best = laps.reduce((b, l) => (!b || l.time < b.time ? l : b), null);
  return {
    id: `${h[3]}_${yyyy}${mm}${dd}_${h[1].replace(':', '')}`,
    fileName,
    date: `${yyyy}-${mm}-${dd}`, time: h[1],
    sn: h[3], trackRaw: h[4], track: trackName(h[4]), driverRaw: h[5],
    category: h[19] && h[19] !== 'NOT USED' ? h[19] : '',
    sessionType: h[20] || '',
    laps, best: best ? best.time : 0, bestLap: best ? best.n : 0,
  };
}

async function parseLaps(summary, buf) {
  const zip = readZip(buf);
  const out = new Map();
  for (const lap of summary.laps) {
    const name = zip.names.find(n => n.startsWith(`LAP_${lap.n}_`));
    if (!name) continue;
    const rows = csvRows(await zip.text(name));
    const cols = rows[0].map(c => c.trim());
    const data = rows.slice(1);
    const n = data.length;
    if (n < 5) continue;
    const col = key => {
      const i = cols.indexOf(key);
      if (i < 0) return null;
      const a = new Float64Array(n);
      for (let j = 0; j < n; j++) a[j] = parseInt(data[j][i], 10) || 0;
      return a;
    };
    const speedRaw = col('Speed GPS');
    const dt = lap.time / 1000 / n;
    const t = new Float64Array(n), dist = new Float64Array(n), speed = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      speed[j] = speedRaw[j] / 10;
      t[j] = j * dt;
      if (j > 0) dist[j] = dist[j - 1] + ((speed[j] + speed[j - 1]) / 2 / 3.6) * dt;
    }
    const lat = col('Lat.'), lon = col('Lon.');
    // Ohne GPS-Fix liefert der Logger 0 – mit dem letzten gültigen Punkt auffüllen
    let firstOk = 0;
    while (firstOk < n - 1 && (!lat[firstOk] || !lon[firstOk])) firstOk++;
    for (let j = 0; j < n; j++) {
      if (!lat[j] || !lon[j]) {
        const src = j < firstOk ? firstOk : j - 1;
        lat[j] = lat[src]; lon[j] = lon[src];
      }
    }
    for (let j = 0; j < n; j++) { lat[j] /= 1e6; lon[j] /= 1e6; }
    const scale = (a, f) => { if (a) for (let j = 0; j < n; j++) a[j] /= f; return a; };
    // G-Sensor: Offset 1000, Einheit 1/100 g. X = quer, Y = längs (+ = Bremsen); per GPS-Abgleich bestätigt
    const gx = col('Gf. X'), gy = col('Gf. Y');
    let gLat = null, gLong = null;
    if (gx && gy) {
      gLat = new Float64Array(n); gLong = new Float64Array(n);
      for (let j = 0; j < n; j++) { gLat[j] = (gx[j] - 1000) / 100; gLong[j] = -(gy[j] - 1000) / 100; }
    }
    const acc = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const i0 = Math.max(0, j - 2), i1 = Math.min(n - 1, j + 2);
      acc[j] = (speed[i1] - speed[i0]) / 3.6 / ((i1 - i0) * dt || 1);
    }
    out.set(lap.n, {
      n: lap.n, time: lap.time, t, dist, speed, lat, lon,
      rpm: col('RPM'), sector: col('Partiel'),
      T1: scale(col('T1'), 10), T2: scale(col('T2'), 10), Altitude: scale(col('Altitude'), 10),
      gLat, gLong, acc, length: dist[n - 1],
    });
  }
  return out;
}

/* ---------- Storage ---------- */

const store = (() => {
  let dbp = null;
  const mem = { files: new Map(), kv: new Map() };
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(res => {
      try {
        const req = indexedDB.open('mad-telemetrie', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('files', { keyPath: 'id' });
          req.result.createObjectStore('kv');
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      } catch { res(null); }
    });
    return dbp;
  }
  function tx(db, name, mode, fn) {
    return new Promise((res, rej) => {
      const t = db.transaction(name, mode);
      const r = fn(t.objectStore(name));
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    async putFile(rec) { mem.files.set(rec.id, rec); const db = await open(); if (db) try { await tx(db, 'files', 'readwrite', s => s.put(rec)); } catch {} },
    async getFile(id) {
      if (mem.files.has(id)) return mem.files.get(id);
      const db = await open(); if (!db) return null;
      try { const r = await tx(db, 'files', 'readonly', s => s.get(id)); if (r) mem.files.set(id, r); return r; } catch { return null; }
    },
    async allFiles() {
      const db = await open(); if (!db) return [...mem.files.values()];
      try { return await tx(db, 'files', 'readonly', s => s.getAll()); } catch { return [...mem.files.values()]; }
    },
    async get(key, dflt) {
      if (mem.kv.has(key)) return mem.kv.get(key);
      const db = await open(); if (!db) return dflt;
      try { const v = await tx(db, 'kv', 'readonly', s => s.get(key)); return v === undefined ? dflt : v; } catch { return dflt; }
    },
    async set(key, val) { mem.kv.set(key, val); const db = await open(); if (db) try { await tx(db, 'kv', 'readwrite', s => s.put(val, key)); } catch {} },
  };
})();

/* ---------- State ---------- */

const MAX_SEL = 6;
const S = {
  sessions: [],          // summaries
  driverMap: {},         // ALFANO-Name -> Fahrer
  overrides: {},         // session id -> Fahrer
  current: null,         // angezeigte Session (Kopf, Rundentabelle, Setup)
  sel: [],               // ausgewählte Runden [{ id, n, slot }], erste = Referenz
  xMode: 'dist',         // X-Achse: 'dist' (m) oder 'time' (s)
  range: null,           // Zoom [x0, x1] in Achseneinheiten
  cx: null,              // Cursor in Achseneinheiten
  channels: ['delta', 'speed', 'rpm', 'T2'],
  lapsCache: new Map(),
  math: [],              // Rechenkanäle { name, unit, expr }
  setup: {},             // session id -> Setup-Notizen
  favs: {},              // session id -> true
  videoSync: {},         // session id -> { lap, vt }
  marker: null,          // { k, i, label } aus Max/Min
  rpmBand: null,
};
let L = [];              // geladene Runden der Auswahl; L[0] = Referenz, alle auf deren Länge skaliert

function driverOf(s) {
  return S.overrides[s.id] || S.driverMap[s.driverRaw] || prettyDriver(s.driverRaw);
}
function needsFix(s) { return !S.overrides[s.id] && !S.driverMap[s.driverRaw] && looksDefaultDriver(s.driverRaw); }
const byId = id => S.sessions.find(s => s.id === id);
const selEntry = (id, n) => S.sel.find(e => e.id === id && e.n === n);
function freeSlot() { for (let k = 0; k < MAX_SEL; k++) if (!S.sel.some(e => e.slot === k)) return k; return 0; }

async function lapsOf(id) {
  if (S.lapsCache.has(id)) return S.lapsCache.get(id);
  const rec = await store.getFile(id);
  const laps = await parseLaps(byId(id), rec.buf);
  S.lapsCache.set(id, laps);
  if (S.lapsCache.size > 12) {
    const keep = new Set(S.sel.map(e => e.id).concat(S.current));
    const drop = [...S.lapsCache.keys()].find(k => !keep.has(k));
    if (drop) S.lapsCache.delete(drop);
  }
  return laps;
}

/* ---------- Formatting ---------- */

const $ = id => document.getElementById(id);
function fmtLap(ms) {
  if (!ms) return '–';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(3);
  return m ? `${m}:${r.padStart(6, '0')}` : r;
}
const fmtSec = ms => ms ? (ms / 1000).toFixed(2) : '–';
const de = (v, d) => v.toFixed(d).replace('.', ',');
const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + de(Math.abs(v), d);
function isoDay(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function fmtDate(iso, withYear) {
  const d = new Date(iso + 'T12:00:00');
  const s = `${WD[d.getDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
  return withYear ? s + iso.slice(0, 4) : s;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3500);
}
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colorVar = slot => `var(--l${slot})`;
const colorOf = slot => css('--l' + slot);
function lapName(l) {
  const multi = new Set(L.map(x => x.sid)).size > 1;
  return `R${l.n}${multi ? ` · ${fmtDate(l.sess.date)} ${l.sess.time}` : ''}`;
}

/* ---------- Import ---------- */

async function importFiles(files, opts = {}) {
  let added = 0, dup = 0, failed = [];
  let last = null, fastest = null;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const sum = await parseSummary(f.name, buf);
      if (byId(sum.id)) { dup++; continue; }
      await store.putFile({ id: sum.id, name: f.name, buf });
      S.sessions.push(sum); added++; last = sum.id;
      if (sum.best && (!fastest || sum.best < fastest.best)) fastest = sum;
    } catch (e) { failed.push(f.name); console.error(e); }
  }
  sortSessions();
  renderFilters(); renderLibrary(); renderBanner();
  const parts = [];
  if (added) parts.push(`${added} Session${added > 1 ? 's' : ''} importiert`);
  if (dup) parts.push(`${dup} schon vorhanden`);
  if (failed.length) parts.push(`${failed.length} nicht lesbar (${failed.slice(0, 2).join(', ')})`);
  toast(parts.join(' · ') || 'Keine Dateien');
  if (opts.openFastest && fastest) await openSession(fastest.id);
  else if (last && (!S.current || added === 1)) await openSession(last);
  else if (!S.current && S.sessions.length) await openSession(S.sessions[0].id);
}
function sortSessions() {
  S.sessions.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

async function loadSamples() {
  try {
    const list = await (await fetch('samples/samples.json')).json();
    const files = list.map(({ name, data }) => {
      const bin = atob(data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], name);
    });
    await importFiles(files, { openFastest: true });
    return true;
  } catch (e) {
    toast('Beispieldaten nicht gefunden. Lege eigene .alf2-Dateien ab.');
    return false;
  }
}

/* ---------- Library (Session-Baum wie in ADA) ---------- */

function renderFilters() {
  const tracks = [...new Set(S.sessions.map(s => s.track))].sort();
  const drivers = [...new Set(S.sessions.map(driverOf))].sort();
  const fill = (el, vals, all) => {
    const cur = el.value;
    el.innerHTML = `<option value="">${all}</option>` + vals.map(v => `<option>${esc(v)}</option>`).join('');
    if (vals.includes(cur)) el.value = cur;
  };
  fill($('f-track'), tracks, 'Alle');
  fill($('f-driver'), drivers, 'Alle');
  fill($('f-cat'), [...new Set(S.sessions.map(s => s.category).filter(Boolean))].sort(), 'Alle');
  $('driver-list').innerHTML = drivers.map(d => `<option value="${esc(d)}">`).join('');
}

let treeOpen = true;
function lapTree(s) {
  const rank = new Map([...s.laps].sort((a, b) => a.time - b.time).map((l, i) => [l.n, i + 1]));
  return '<ul class="lap-tree">' + s.laps.map(l => {
    const e = selEntry(s.id, l.n);
    const slow = l.time > s.best * 1.07;
    return `<li><label title="Runde ${l.n} ins Overlay">
      <input type="checkbox" data-sid="${s.id}" data-n="${l.n}"${e ? ` checked style="accent-color:${colorVar(e.slot)}"` : ''}>
      <span>R${l.n}</span>
      <span class="t${l.time === s.best ? ' lapbest' : ''}${slow ? ' slow' : ''}">${fmtLap(l.time)}</span>
      <span class="rk">#${rank.get(l.n)}</span></label></li>`;
  }).join('') + '</ul>';
}

function renderLibrary() {
  const ft = $('f-track').value, fd = $('f-driver').value, fc = $('f-cat').value, ff = $('f-fav').checked;
  const days = $('f-date').value, since = days === '' ? '' : isoDay(-+days);
  const list = S.sessions.filter(s => (!ft || s.track === ft) && (!fd || driverOf(s) === fd) && (!fc || s.category === fc) && (!ff || S.favs[s.id]) && (!since || s.date >= since));
  if ($('f-sort').value === 'best') list.sort((a, b) => (a.best || Infinity) - (b.best || Infinity));
  const groups = new Map();
  for (const s of list) {
    if (!groups.has(s.track)) groups.set(s.track, []);
    groups.get(s.track).push(s);
  }
  let html = '';
  for (const [track, items] of groups) {
    const trackBest = Math.min(...items.map(s => s.best || Infinity));
    html += `<div class="lib-group">${esc(track)}</div>`;
    for (const s of items) {
      const fix = needsFix(s), open = s.id === S.current && treeOpen;
      const here = S.sel.filter(e => e.id === s.id);
      html += `<div class="lib-sess${open ? ' open' : ''}"><button type="button" class="lib-item" data-id="${s.id}" aria-expanded="${open}">
        <span class="when">${S.favs[s.id] ? '<span class="star">&#9733;</span>' : ''}${fmtDate(s.date)} · ${s.time}</span>
        <span class="best${s.best === trackBest ? ' trackbest' : ''}">${fmtLap(s.best)}</span>
        <span class="sub">${here.length ? `<span class="dots">${here.map(e => `<i style="--c:${colorVar(e.slot)}"></i>`).join('')}</span>` : ''}${fix ? `<span class="fix">${esc(s.driverRaw)}?</span>` : esc(driverOf(s))} · ${s.laps.length} Runden${s.sessionType ? ' · ' + esc(s.sessionType.toLowerCase()) : ''}</span>
      </button>${open ? lapTree(s) : ''}</div>`;
    }
  }
  const el = $('lib-list'), top = el.scrollTop;
  el.innerHTML = html || `<p class="muted" style="padding:12px">${S.sessions.length ? 'Keine Session passt zum Filter.' : 'Noch keine Sessions.'}</p>`;
  el.scrollTop = top;
  $('lib-count').textContent = `${S.sessions.length}`;
}

function renderBanner() {
  const raws = [...new Set(S.sessions.filter(needsFix).map(s => s.driverRaw))];
  const b = $('banner');
  if (!raws.length) { b.hidden = true; return; }
  const n = S.sessions.filter(needsFix).length;
  b.innerHTML = `<span>${n} Session${n > 1 ? 's' : ''} mit Standard-Fahrernamen (${raws.map(esc).join(', ')}).</span>
    <button type="button" class="link" id="banner-fix">Fahrer zuordnen</button>`;
  b.hidden = false;
  $('banner-fix').onclick = openDriverDialog;
}

/* ---------- Auswahl ---------- */

async function openSession(id) {
  const s = byId(id); if (!s) return;
  S.current = id; treeOpen = true;
  const ref = S.sel[0] && byId(S.sel[0].id);
  if (s.bestLap && (!ref || ref.track !== s.track)) {
    // Neue Strecke: Bestrunde als Referenz, dazu die schnellste Runde einer anderen Session (sonst zweitschnellste hier)
    S.sel = [{ id, n: s.bestLap, slot: 0 }];
    const others = S.sessions.filter(o => o.track === s.track && o.id !== id && o.best);
    if (others.length) {
      const f = others.reduce((a, b) => (b.best < a.best ? b : a));
      S.sel.push({ id: f.id, n: f.bestLap, slot: 1 });
    } else {
      const second = [...s.laps].sort((a, b) => a.time - b.time)[1];
      if (second) S.sel.push({ id, n: second.n, slot: 1 });
    }
    view = null;
  } else if (s.bestLap && !S.sel.some(e => e.id === id)) {
    if (S.sel.length >= MAX_SEL) S.sel.pop();
    S.sel.unshift({ id, n: s.bestLap, slot: freeSlot() });
  }
  S.range = null; S.cx = null; S.marker = null; S.rpmBand = null;
  $('empty').hidden = true; $('session').hidden = false;
  renderHead(s); renderLapTable(s);
  await refreshTraces();
}

async function toggleLap(id, n) {
  const i = S.sel.findIndex(e => e.id === id && e.n === n);
  if (i >= 0) {
    if (S.sel.length === 1) { toast('Eine Runde bleibt immer ausgewählt'); renderLibrary(); return; }
    S.sel.splice(i, 1);
  } else {
    const ref = S.sel[0] && byId(S.sel[0].id);
    if (ref && ref.track !== byId(id).track) { S.sel = []; view = null; toast('Andere Strecke: Auswahl neu begonnen'); }
    if (S.sel.length >= MAX_SEL) { toast('Höchstens 6 Runden gleichzeitig'); renderLibrary(); return; }
    S.sel.push({ id, n, slot: freeSlot() });
  }
  S.range = null; S.marker = null;
  await refreshTraces();
}
async function setRef(k) {
  if (!k) return;
  const [e] = S.sel.splice(k, 1); S.sel.unshift(e);
  S.range = null; S.cx = null;
  await refreshTraces();
  toast(`Referenz: Runde ${e.n}`);
}

/* ---------- Kopf und Rundentabelle ---------- */

function bestSectors(s) {
  const nSec = Math.max(0, ...s.laps.map(l => l.sectors.length));
  const out = [];
  // Only representative laps count: out-laps, in-laps and laps behind a yellow (> 107 % of the best) often
  // carry sector splits the logger cut at the wrong place (e.g. a 12.6 s S3 on the out-lap at Lonato).
  const valid = s.laps.filter(l => l.time && (!s.best || l.time <= s.best * 1.07) && l.sectors.every(v => v > 0));
  const pool = valid.length ? valid : s.laps;
  for (let k = 0; k < nSec; k++) out.push(Math.min(...pool.map(l => l.sectors[k] || Infinity)));
  return out;
}
function theoLap(s) { const b = bestSectors(s); return b.length && b.every(isFinite) ? b.reduce((a, c) => a + c, 0) : 0; }

function renderHead(s) {
  $('s-eyebrow').textContent = `${fmtDate(s.date, true)} · ${s.time} Uhr · ALFANO SN ${s.sn}`;
  $('s-track').textContent = s.track;
  const inp = $('s-driver');
  inp.value = driverOf(s);
  inp.parentElement.classList.toggle('fix', needsFix(s));
  inp.title = `Im ALFANO gespeichert als „${s.driverRaw}“`;
  const su = S.setup[s.id] || {};
  $('s-tags').innerHTML = [s.category, s.sessionType, su.gear && 'Übers. ' + su.gear, su.tyre].filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const fav = !!S.favs[s.id];
  $('s-fav').setAttribute('aria-pressed', String(fav));
  $('s-fav').innerHTML = fav ? '&#9733; Favorit' : '&#9734; Favorit';
  const vmax = Math.max(0, ...s.laps.map(l => l.maxSpeed));
  $('s-kpis').innerHTML = `
    <div class="kpi best"><b>${fmtLap(s.best)}</b><span>Bestzeit · R${s.bestLap}</span></div>
    <div class="kpi"><b>${fmtLap(theoLap(s))}</b><span>Theoretisch</span></div>
    <div class="kpi"><b>${s.laps.length}</b><span>Runden</span></div>
    <div class="kpi"><b>${de(vmax, 1)}</b><span>Vmax km/h</span></div>`;
}

function renderLapTable(s) {
  if (!s) return;
  const bestSec = bestSectors(s), nSec = bestSec.length;
  const hasT1 = s.laps.some(l => l.maxT1 > 0), hasT2 = s.laps.some(l => l.maxT2 > 0);
  let h = '<thead><tr><th></th><th>Rd.</th><th>Zeit</th><th>Δ Best</th>';
  for (let k = 0; k < nSec; k++) h += `<th>S${k + 1}</th>`;
  h += '<th>Vmax</th><th>Vmin</th><th>RPM max</th>' + (hasT1 ? '<th>Wasser</th>' : '') + (hasT2 ? '<th>EGT</th>' : '') + '</tr></thead><tbody>';
  for (const l of s.laps) {
    const e = selEntry(s.id, l.n);
    const slow = l.time > s.best * 1.07;
    h += `<tr data-lap="${l.n}" class="${slow ? 'slow' : ''}${e ? ' sel' : ''}"${e ? ` style="--c:${colorVar(e.slot)}"` : ''}>
      <td><span class="sw"></span></td><td>${l.n}</td><td class="${l.time === s.best ? 'lapbest' : ''}">${fmtLap(l.time)}</td>
      <td>${l.time === s.best ? '' : '+' + ((l.time - s.best) / 1000).toFixed(3)}</td>`;
    for (let k = 0; k < nSec; k++) h += `<td class="${l.sectors[k] === bestSec[k] ? 'pb' : ''}">${fmtSec(l.sectors[k])}</td>`;
    h += `<td>${l.maxSpeed.toFixed(1)}</td><td>${l.minSpeed.toFixed(1)}</td><td>${l.maxRpm}</td>`
      + (hasT1 ? `<td>${l.maxT1 ? l.maxT1.toFixed(0) + '°' : '–'}</td>` : '')
      + (hasT2 ? `<td>${l.maxT2 ? l.maxT2.toFixed(0) + '°' : '–'}</td>` : '')
      + '</tr>';
  }
  $('lap-table').innerHTML = h + '</tbody>';
}

/* ---------- Runden laden und ausrichten ---------- */

async function refreshTraces() {
  const out = [];
  for (const e of S.sel) {
    try { const raw = (await lapsOf(e.id)).get(e.n); if (raw) out.push({ e, raw }); } catch (err) { console.error(err); }
  }
  S.sel = out.map(o => o.e);
  L = [];
  if (out.length) {
    const ref = out[0].raw;
    L = out.map(({ e, raw }, k) => {
      const lap = k === 0 ? { ...raw, delta: new Float64Array(raw.t.length) } : alignTo(raw, ref);
      return Object.assign(lap, { sid: e.id, slot: e.slot, k, sess: byId(e.id) });
    });
  }
  resetPlay(); S.marker = null;
  renderLibrary(); renderLapTable(byId(S.current)); renderLegend(); renderSectors();
  if (activeTab === 'video') renderVideos();
  renderRamp();
  updateCursor(); renderTab();
}

// Runde b auf die Länge der Referenz a skalieren, Zeitabstand je Stützstelle von a
function alignTo(b, a) {
  const k = a.length / b.length;
  const dist = b.dist.map(d => d * k);
  const n = a.dist.length;
  const delta = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = a.dist[i];
    while (j < dist.length - 2 && dist[j + 1] < d) j++;
    const span = dist[j + 1] - dist[j] || 1;
    const f = Math.min(1, Math.max(0, (d - dist[j]) / span));
    const tb = b.t[j] + f * (b.t[j + 1] - b.t[j]);
    delta[i] = tb - a.t[i];
  }
  return { ...b, dist, delta };
}

function idxAt(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
const xs = lap => (S.xMode === 'time' ? lap.t : lap.dist);
const xEnd = () => Math.max(...L.map(l => { const a = xs(l); return a[a.length - 1]; }));
const maxT = () => Math.max(...L.map(l => l.time / 1000));

// Index je Runde am Cursor: bei Wiedergabe nach Zeit (Geister), sonst nach X-Achse
function curIdx() {
  if (!L.length) return null;
  if (play.t != null) return L.map(l => Math.min(l.t.length - 1, idxAt(l.t, play.t)));
  if (S.cx == null) return null;
  return L.map(l => Math.min(l.t.length - 1, idxAt(xs(l), S.cx)));
}
function cursorX(idx) {
  if (!idx) return null;
  if (play.t != null) return S.xMode === 'time' ? play.t : L[0].dist[idx[0]];
  return S.cx;
}
// Abstand zur Referenz am Cursor: Zeit an gleicher Stelle, Meter zur gleichen Zeit
function gaps(idx) {
  const ref = L[0], ir = idx[0];
  return L.map((l, k) => {
    if (!k) return { dt: 0, dd: 0 };
    const j = Math.min(l.t.length - 1, idxAt(l.t, ref.t[ir]));
    return { dt: l.delta[ir], dd: ref.dist[ir] - l.dist[j] };
  });
}

/* ---------- Legende ---------- */

function renderLegend() {
  $('legend').innerHTML = L.map((l, k) => `<span class="lg" data-k="${k}" style="--c:${colorVar(l.slot)}" title="${k ? 'Klick: als Referenz setzen' : 'Referenzrunde'}">
    ${k ? '' : '<span class="ref">Ref</span>'}<b>R${l.n} · ${fmtLap(l.time)}</b>
    <span class="muted">${esc(driverOf(l.sess))} · ${fmtDate(l.sess.date)} ${l.sess.time}</span>
    ${L.length > 1 ? `<button type="button" data-rm="${k}" aria-label="Runde ${l.n} entfernen">✕</button>` : ''}</span>`).join('')
    + (L.length < MAX_SEL ? '<span class="muted small">Weitere Runden links per Häkchen dazunehmen.</span>' : '');
}

/* ---------- Canvas helpers ---------- */

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function speedColor(f) {
  // rot (langsam) -> gelb -> grün (schnell)
  const stops = [[224, 49, 49], [245, 159, 0], [47, 158, 68]];
  const x = Math.min(1, Math.max(0, f)) * 2, i = Math.min(1, Math.floor(x)), t = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function line(ctx, xsArr, ys, X, Y, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  let pen = false;
  for (let i = 0; i < xsArr.length; i++) {
    if (!Number.isFinite(ys[i])) { pen = false; continue; }
    const x = X(xsArr[i]), y = Y(ys[i]); pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
  }
  ctx.stroke();
}
function niceTicks(lo, hi, count) {
  const span = hi - lo || 1, step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
function fmtTick(t, span) { return span < 0.5 ? t.toFixed(2) : span < 5 ? t.toFixed(1) : String(Math.round(t)); }
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

/* ---------- Map (Web Mercator, Satellit) ---------- */

const TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const MAX_Z = 19;
const tiles = new Map();
const sat = { mode: 'sat', ok: 0, failed: 0 };
let view = null;        // { cx, cy, s }: Mittelpunkt in Mercator-Einheiten (0..1), s = Pixel je Einheit
let mapProj = null, redrawQueued = false;

function merc(lat, lon) {
  const x = (lon + 180) / 360;
  const r = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  return [x, y];
}
function mercOf(lap) {
  if (!lap.mx) {
    lap.mx = new Float64Array(lap.lat.length); lap.my = new Float64Array(lap.lat.length);
    for (let i = 0; i < lap.lat.length; i++) { const [x, y] = merc(lap.lat[i], lap.lon[i]); lap.mx[i] = x; lap.my[i] = y; }
  }
  return lap;
}
function queueMap() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; drawMap(); });
}
function getTile(z, x, y) {
  const key = z + '/' + x + '/' + y;
  let t = tiles.get(key);
  if (!t) {
    t = { img: new Image(), ready: false, bad: false };
    t.img.onload = () => { t.ready = true; sat.ok++; queueMap(); };
    t.img.onerror = () => { t.bad = true; sat.failed++; queueMap(); };
    t.img.src = TILE_URL(z, x, y);
    tiles.set(key, t);
    if (tiles.size > 600) tiles.delete(tiles.keys().next().value);
  }
  return t;
}
function satUnavailable() { return sat.ok === 0 && sat.failed >= 4; }

function fitView(lap, i0 = 0, i1 = lap.t.length - 1) {
  const cv = $('map');
  mercOf(lap);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = i0; i <= i1; i++) {
    x0 = Math.min(x0, lap.mx[i]); x1 = Math.max(x1, lap.mx[i]); y0 = Math.min(y0, lap.my[i]); y1 = Math.max(y1, lap.my[i]);
  }
  if (!isFinite(x0)) return;
  const w = cv.clientWidth || 400, h = cv.clientHeight || 400;
  const s = Math.min((w - 50) / Math.max(x1 - x0, 1e-7), (h - 50) / Math.max(y1 - y0, 1e-7));
  view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s: Math.min(s, 256 * 2 ** 21) };
}
function fitRange() {
  const ref = L[0]; if (!ref) return;
  if (!S.range) { fitView(ref); return; }
  const a = xs(ref);
  fitView(ref, Math.min(a.length - 1, idxAt(a, S.range[0])), Math.min(a.length - 1, idxAt(a, S.range[1])));
}
function zoomAt(f, px, py) {
  const cv = $('map');
  const w = cv.clientWidth, h = cv.clientHeight;
  px = px ?? w / 2; py = py ?? h / 2;
  const mx = view.cx + (px - w / 2) / view.s, my = view.cy + (py - h / 2) / view.s;
  view.s = Math.max(256 * 2 ** 12, Math.min(256 * 2 ** 21, view.s * f));
  view.cx = mx - (px - w / 2) / view.s; view.cy = my - (py - h / 2) / view.s;
  queueMap();
}

function drawTiles(ctx, w, h) {
  const z = Math.max(1, Math.min(MAX_Z, Math.ceil(Math.log2(view.s / 256))));
  const n = 2 ** z, ts = view.s / n;
  const ux0 = view.cx - w / 2 / view.s, uy0 = view.cy - h / 2 / view.s;
  const tx0 = Math.floor(ux0 * n), ty0 = Math.floor(uy0 * n);
  const tx1 = Math.floor((ux0 + w / view.s) * n), ty1 = Math.floor((uy0 + h / view.s) * n);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const sx = (tx / n - ux0) * view.s, sy = (ty / n - uy0) * view.s;
    const t = getTile(z, tx, ty);
    if (t.ready) { ctx.drawImage(t.img, sx, sy, ts + 0.5, ts + 0.5); continue; }
    // Solange die Kachel lädt: gröbere Kachel aus dem Cache hochskalieren
    for (let up = 1; up <= 4 && z - up >= 1; up++) {
      const k = 2 ** up, p = tiles.get((z - up) + '/' + (tx >> up) + '/' + (ty >> up));
      if (p && p.ready) {
        const sub = 256 / k;
        ctx.drawImage(p.img, (tx % k) * sub, (ty % k) * sub, sub, sub, sx, sy, ts + 0.5, ts + 0.5);
        break;
      }
    }
  }
}

function drawMap() {
  const cv = $('map');
  const { ctx, w, h } = fitCanvas(cv);
  if (!L.length) return;
  const ref = L[0];
  L.forEach(mercOf);
  if (!view) fitView(ref);
  const P = (mx, my) => [(mx - view.cx) * view.s + w / 2, (my - view.cy) * view.s + h / 2];
  const useSat = sat.mode === 'sat' && !satUnavailable();
  if (useSat) drawTiles(ctx, w, h);
  else { ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h); }
  $('attrib').hidden = !useSat;
  const note = $('map-note');
  if (sat.mode === 'sat' && satUnavailable()) {
    note.textContent = 'Satellitenbild in dieser Vorschau gesperrt. In der lokal geöffneten App wird es angezeigt.';
    note.hidden = false;
  } else note.hidden = true;

  const proj = L.map(l => Array.from(l.mx, (x, i) => P(x, l.my[i])));
  const pa = proj[0];
  mapProj = { pa };
  const metersPerPx = 40075016 * Math.cos(ref.lat[0] * Math.PI / 180) / view.s;
  const trackW = Math.max(4, Math.min(40, 9 / metersPerPx));   // Kartbahn ≈ 9 m breit

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const path = (pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); };
  if (!useSat) { ctx.strokeStyle = css('--surface'); ctx.lineWidth = trackW + 6; path(pa); ctx.stroke(); }
  // dunkle Kontur, damit die Linie auf jedem Untergrund lesbar bleibt
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 7; path(pa); ctx.stroke();
  const colorAt = mapColorFn(ref);
  const rx = xs(ref);
  ctx.lineWidth = 4.5;
  for (let i = 1; i < pa.length; i++) {
    const inRange = !S.range || (rx[i] >= S.range[0] && rx[i] <= S.range[1]);
    const [col, alpha] = colorAt(i);
    ctx.globalAlpha = (inRange ? 1 : 0.3) * alpha;
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(...pa[i - 1]); ctx.lineTo(...pa[i]); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Weitere Runden als Linien in ihrer Farbe
  for (let k = 1; k < L.length; k++) {
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 3.4; path(proj[k]); ctx.stroke();
    ctx.strokeStyle = colorOf(L[k].slot); ctx.lineWidth = 1.6; path(proj[k]); ctx.stroke();
  }
  // Start/Ziel und Sektorgrenzen
  ctx.font = `600 12px ${css('--font-body')}`; ctx.textBaseline = 'middle';
  const mark = (i, label) => {
    const [x, y] = pa[i];
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeText(label, x + 8, y - 8); ctx.fillText(label, x + 8, y - 8);
  };
  mark(0, 'Start/Ziel');
  if (ref.sector) for (let i = 1; i < ref.sector.length; i++) if (ref.sector[i] !== ref.sector[i - 1]) mark(i, 'S' + ref.sector[i]);

  const idx = curIdx();
  if (idx) for (let k = L.length - 1; k >= 0; k--) dot(ctx, proj[k][idx[k]], colorOf(L[k].slot), k ? 6 : 8);
  const mk = S.marker;
  if (mk && proj[mk.k]) {
    const [x, y] = proj[mk.k][mk.i];
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fillStyle = colorOf(L[mk.k].slot);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 26); ctx.stroke();
    ctx.font = `600 12px ${css('--font-body')}`;
    const tw = ctx.measureText(mk.label).width + 12;
    ctx.fillRect(x, y - 44, tw, 20); ctx.strokeRect(x, y - 44, tw, 20);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(mk.label, x + 6, y - 34);
  }
  $('map-dist').textContent = idx ? `${de(ref.dist[idx[0]], 0)} m` : `${de(ref.length, 0)} m Runde`;
}
function dot(ctx, [x, y], color, r) {
  ctx.fillStyle = color; ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
}

/* ---------- Wiedergabe ---------- */

const play = { t: null, running: false, last: 0 };
function setPlayT(t) {
  if (!L.length) return;
  play.t = Math.max(0, Math.min(maxT(), t));
  $('scrub').value = String(Math.round(play.t / maxT() * 1000));
  syncVideos(play.t, !play.running);
  updateCursor();
}
function tick(now) {
  if (!play.running) return;
  const dt = (now - play.last) / 1000; play.last = now;
  const t = play.t + dt * +$('play-speed').value;
  if (t >= maxT()) { setPlayT(maxT()); stopPlay(); return; }
  setPlayT(t);
  requestAnimationFrame(tick);
}
function startPlay() {
  if (!L.length) return;
  if (play.t == null) play.t = S.cx != null ? L[0].t[Math.min(L[0].t.length - 1, idxAt(xs(L[0]), S.cx))] : 0;
  if (play.t >= maxT() - 0.05) play.t = 0;
  play.running = true; play.last = performance.now();
  $('play').innerHTML = '&#10074;&#10074; Pause';
  $('play').setAttribute('aria-pressed', 'true');
  playVideos();
  requestAnimationFrame(tick);
}
function stopPlay() {
  play.running = false; $('play').innerHTML = '&#9654; Wiedergabe';
  $('play').setAttribute('aria-pressed', 'false');
  for (const v of vid.els.values()) if (!v.paused) v.pause();
}
function resetPlay() { stopPlay(); play.t = null; $('scrub').value = '0'; }
function stepBy(d) {
  if (!L.length) return;
  stopPlay();
  const idx = curIdx();
  setPlayT((play.t ?? (idx ? L[0].t[idx[0]] : 0)) + d);
}

/* ---------- Kanäle und Rechenkanäle ---------- */

const CH = {
  speed: { label: 'Speed', unit: 'km/h', dec: 1 },
  rpm: { label: 'Drehzahl', unit: '1/min', dec: 0 },
  T1: { label: 'Wasser', unit: '°C', dec: 1 },
  T2: { label: 'EGT', unit: '°C', dec: 0 },
  Altitude: { label: 'Höhe', unit: 'm', dec: 1 },
  gLat: { label: 'G quer', unit: 'g', dec: 2 },
  gLong: { label: 'G längs', unit: 'g', dec: 2 },
  acc: { label: 'Beschl. GPS', unit: 'm/s²', dec: 2 },
};
const MATH_VARS = ['speed', 'rpm', 'T1', 'T2', 'alt', 'gLat', 'gLong', 'acc', 'dist', 't'];

function compileMath(expr) {
  if (!expr.trim()) throw new Error('Formel fehlt');
  if (/[^\w\s.+\-*/()%,<>=?:!&|]/.test(expr)) throw new Error('Ungültiges Zeichen in der Formel');
  for (const id of expr.match(/[A-Za-z_]\w*/g) || []) {
    if (!MATH_VARS.includes(id) && !Object.getOwnPropertyNames(Math).includes(id)) throw new Error(`Unbekannter Name: ${id}`);
  }
  const mathNames = Object.getOwnPropertyNames(Math);
  // Math-Funktionen ohne Präfix erlauben (abs, sqrt, …)
  return new Function(...MATH_VARS, ...mathNames, `return (${expr});`).bind(null);
}
function evalMath(lap, def) {
  const n = lap.t.length, out = new Float64Array(n);
  let f;
  try { f = compileMath(def.expr); } catch { out.fill(NaN); return out; }
  const mathVals = Object.getOwnPropertyNames(Math).map(k => Math[k]);
  const g = (a, i) => (a ? a[i] : NaN);
  for (let i = 0; i < n; i++) {
    let v;
    try { v = f(lap.speed[i], g(lap.rpm, i), g(lap.T1, i), g(lap.T2, i), g(lap.Altitude, i), g(lap.gLat, i), g(lap.gLong, i), lap.acc[i], lap.dist[i], lap.t[i], ...mathVals); } catch { v = NaN; }
    out[i] = Number.isFinite(v) ? v : NaN;
  }
  return out;
}
function chanInfo(key) {
  if (key === 'delta') return { label: 'Δ Zeit zur Referenz', unit: 's', dec: 3 };
  if (key && key.startsWith('m:')) {
    const m = S.math.find(x => 'm:' + x.name === key);
    return m ? { label: m.name, unit: m.unit || '', dec: 2 } : null;
  }
  return CH[key] || null;
}
function chan(lap, key) {
  if (!lap) return null;
  if (key === 'delta') return lap.delta;
  if (!key.startsWith('m:')) return lap[key] || null;
  const def = S.math.find(x => 'm:' + x.name === key);
  if (!def) return null;
  if (!lap._m) lap._m = {};
  if (!lap._m[key]) lap._m[key] = evalMath(lap, def);
  return lap._m[key];
}
function clearMathCache() {
  for (const laps of S.lapsCache.values()) for (const l of laps.values()) l._m = {};
  for (const l of L) l._m = {};
}
const allChannelKeys = () => ['delta', ...Object.keys(CH), ...S.math.map(m => 'm:' + m.name)];
function renderChannelControls() {
  const keys = allChannelKeys();
  S.channels = S.channels.filter(k => keys.includes(k));
  $('pop-channels').innerHTML = '<div class="muted small" style="margin-bottom:4px">Kurven untereinander, beliebig viele</div>'
    + keys.map(k => { const c = chanInfo(k); return `<label class="check"><input type="checkbox" data-ch="${esc(k)}"${S.channels.includes(k) ? ' checked' : ''}> ${esc(c.label)}${c.unit ? ` <span class="muted">(${esc(c.unit)})</span>` : ''}</label>`; }).join('')
    + '<hr><button type="button" class="link" id="math-toggle">Rechenkanal anlegen …</button>';
  $('math-list').innerHTML = S.math.map((m, i) => `<span class="tag">${esc(m.name)} = <code>${esc(m.expr)}</code><button type="button" data-del="${i}" aria-label="${esc(m.name)} löschen">✕</button></span>`).join('');
  const opts = Object.keys(CH).concat(S.math.map(m => 'm:' + m.name)).map(k => { const c = chanInfo(k); return `<option value="${esc(k)}">${esc(c.label)}${c.unit ? ' (' + esc(c.unit) + ')' : ''}</option>`; }).join('');
  for (const id of ['ses-ch1', 'ses-ch2']) { const el = $(id), cur = el.value; el.innerHTML = opts; if (cur) el.value = cur; }
}
async function saveMath() {
  const name = $('math-name').value.trim(), unit = $('math-unit').value.trim(), expr = $('math-expr').value.trim();
  $('math-err').textContent = '';
  try {
    if (!name) throw new Error('Name fehlt');
    if (CH[name]) throw new Error('Name ist schon ein Kanal');
    compileMath(expr);
  } catch (e) { $('math-err').textContent = e.message; return; }
  S.math = S.math.filter(m => m.name !== name).concat({ name, unit, expr });
  await store.set('math', S.math);
  clearMathCache();
  if (!S.channels.includes('m:' + name)) S.channels.push('m:' + name);
  saveChannels(); renderChannelControls();
  $('math-name').value = $('math-unit').value = $('math-expr').value = '';
  $('math').hidden = true;
  updateCursor(); renderTab(); toast(`Rechenkanal „${name}“ angelegt`);
}
function saveChannels() { store.set('channels', S.channels); }

/* ---------- Kurven ---------- */

let chartLayout = null, dragStart = null, dragNow = null;

function panesFor() {
  const panes = [];
  for (const key of S.channels) {
    if (key === 'delta') { if (L.length > 1) panes.push({ key, label: 'Δ Zeit zur Referenz (s)', w: 0.8, dec: 3 }); continue; }
    const ci = chanInfo(key);
    if (!ci || !L.some(l => chan(l, key))) continue;
    panes.push({ key, label: ci.label + (ci.unit ? ` (${ci.unit})` : ''), w: key === 'speed' ? 1.3 : 1, dec: ci.dec, unit: ci.unit });
  }
  return panes;
}

// Kurvenminima (Scheitelgeschwindigkeit) wie die Kreise in ADA
function cornerMins(lap) {
  if (lap._corners) return lap._corners;
  const v = lap.speed, n = v.length, out = [];
  for (let i = 3; i < n - 3; i++) {
    let isMin = true;
    for (let j = Math.max(0, i - 15); j <= Math.min(n - 1, i + 15); j++) if (v[j] < v[i] || (v[j] === v[i] && j < i)) { isMin = false; break; }
    if (!isMin) continue;
    let ml = 0, mr = 0;
    for (let j = Math.max(0, i - 50); j <= i; j++) ml = Math.max(ml, v[j]);
    for (let j = i; j <= Math.min(n - 1, i + 50); j++) mr = Math.max(mr, v[j]);
    if (Math.min(ml, mr) - v[i] >= 6) out.push(i);
  }
  lap._corners = out;
  return out;
}

function drawChart() {
  const cv = $('chart');
  const panes = panesFor();
  const ph = window.innerWidth < 760 ? 100 : 125;
  const want = Math.max(240, 46 + panes.length * ph) + 'px';
  if (cv.style.height !== want) cv.style.height = want;
  const { ctx, w, h } = fitCanvas(cv);
  if (!L.length) return;
  const ref = L[0];
  const left = 50, right = 12, top = 18, bottom = 24, gap = 10;
  const totalW = panes.reduce((a, p) => a + p.w, 0) || 1;
  const avail = h - top - bottom - gap * Math.max(0, panes.length - 1);
  let y = top;
  for (const p of panes) { p.y = y; p.h = avail * p.w / totalW; y += p.h + gap; }
  const [x0, x1] = S.range || [0, xEnd()];
  const X = v => left + (v - x0) / (x1 - x0) * (w - left - right);
  chartLayout = { left, right, x0, x1, w, ranges: {} };

  const fg = css('--fg'), fg2 = css('--fg-2'), grid = css('--grid'), surf = css('--surface');
  const fData = css('--font-data'), fBody = css('--font-body');
  const cols = L.map(l => colorOf(l.slot));
  const rx = xs(ref);
  const secs = [];
  if (ref.sector) for (let i = 1; i < ref.sector.length; i++) if (ref.sector[i] !== ref.sector[i - 1]) secs.push([rx[i], ref.sector[i]]);
  const idx = curIdx(), cX = cursorX(idx);

  for (const p of panes) {
    const series = L.map((l, k) => p.key === 'delta' ? (k ? l.delta : null) : chan(l, p.key));
    const xArr = k => (p.key === 'delta' ? rx : xs(L[k]));
    let lo = Infinity, hi = -Infinity;
    series.forEach((arr, k) => {
      if (!arr) return;
      const xa = xArr(k);
      for (let i = 0; i < arr.length; i++) if (xa[i] >= x0 && xa[i] <= x1 && Number.isFinite(arr[i])) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); }
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    chartLayout.ranges[p.key] = [lo, hi];
    if (p.key === 'delta') { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.05); lo = -m * 1.05; hi = m * 1.05; }
    else { const padv = (hi - lo) * 0.1 || 1; lo -= padv; hi += padv; }
    const Y = v => p.y + p.h - (v - lo) / (hi - lo) * p.h;

    ctx.save();
    ctx.beginPath(); ctx.rect(left, p.y, w - left - right, p.h); ctx.clip();
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (const t of niceTicks(lo, hi, 3)) { ctx.beginPath(); ctx.moveTo(left, Y(t)); ctx.lineTo(w - right, Y(t)); ctx.stroke(); }
    ctx.setLineDash([3, 4]); ctx.strokeStyle = fg2; ctx.globalAlpha = 0.5;
    for (const [d] of secs) { ctx.beginPath(); ctx.moveTo(X(d), p.y); ctx.lineTo(X(d), p.y + p.h); ctx.stroke(); }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    if (p.key === 'delta') { ctx.strokeStyle = cols[0]; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(left, Y(0)); ctx.lineTo(w - right, Y(0)); ctx.stroke(); }
    for (let k = L.length - 1; k >= 0; k--) if (series[k]) line(ctx, xArr(k), series[k], X, Y, cols[k], k ? 1.4 : 1.8);
    // Kreise an Kurvenminima und Höchstgeschwindigkeit
    if (p.key === 'speed') {
      ctx.font = `500 11px ${fData}`; ctx.textAlign = 'center';
      for (let k = L.length - 1; k >= 0; k--) {
        const l = L[k], xa = xs(l), sp = l.speed;
        let imax = -1;
        for (let i = 0; i < sp.length; i++) if (xa[i] >= x0 && xa[i] <= x1 && (imax < 0 || sp[i] > sp[imax])) imax = i;
        const pts = cornerMins(l).filter(i => xa[i] >= x0 && xa[i] <= x1).map(i => [i, 'min']);
        if (imax >= 0) pts.push([imax, 'max']);
        for (const [i, kind] of pts) {
          const px = X(xa[i]), py = Y(sp[i]);
          ctx.strokeStyle = cols[k]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, k ? 3.5 : 4.5, 0, 7); ctx.stroke();
          if (!k && !(py < p.y + 26 && px < left + 140)) {
            ctx.textBaseline = kind === 'min' ? 'top' : 'bottom';
            const ty = kind === 'min' ? py + 6 : py - 6;
            ctx.lineWidth = 3; ctx.strokeStyle = surf; ctx.strokeText(sp[i].toFixed(0), px, ty);
            ctx.fillStyle = fg; ctx.fillText(sp[i].toFixed(0), px, ty);
          }
        }
      }
    }
    ctx.restore();

    ctx.fillStyle = fg2; ctx.font = `11px ${fData}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of niceTicks(lo, hi, 3)) { const yy = Y(t); if (yy > p.y + 6 && yy < p.y + p.h - 4) ctx.fillText(p.key === 'delta' ? (t > 0 ? '+' : '') + t.toFixed(2) : fmtTick(t, hi - lo), left - 6, yy); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = `600 12px ${fBody}`; ctx.fillStyle = fg;
    ctx.fillText(p.label, left + 6, p.y + 3);

    // Werte am Cursor direkt neben der Linie
    if (idx && cX != null && cX >= x0 && cX <= x1 && p.h >= 34) {
      const labels = [];
      L.forEach((l, k) => {
        const arr = series[k]; if (!arr) return;
        const v = p.key === 'delta' ? arr[idx[0]] : arr[idx[k]];
        if (!Number.isFinite(v)) return;
        labels.push([p.key === 'delta' ? signed(v, 3) : de(v, p.dec), cols[k]]);
      });
      ctx.font = `500 11px ${fData}`;
      const bw = Math.max(0, ...labels.map(([t]) => ctx.measureText(t).width)) + 10;
      const maxRows = Math.max(1, Math.floor((p.h - 20) / 15));
      const bx = X(cX) + 6 + bw > w - right ? X(cX) - 6 - bw : X(cX) + 6;
      labels.slice(0, maxRows).forEach(([t, c], r) => {
        const by = p.y + 18 + r * 15;
        ctx.globalAlpha = 0.88; ctx.fillStyle = surf; roundRect(ctx, bx, by, bw, 14, 3); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = c; ctx.fillRect(bx, by, 3, 14);
        ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(t, bx + 6, by + 7.5);
      });
    }
  }

  ctx.fillStyle = fg2; ctx.font = `11px ${fData}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const unit = S.xMode === 'time' ? ' s' : ' m';
  for (const t of niceTicks(x0, x1, w < 500 ? 4 : 8)) ctx.fillText(fmtTick(t, x1 - x0) + unit, X(t), h - bottom + 6);
  ctx.font = `600 11px ${fBody}`;
  for (const [d, n] of secs) if (d > x0 && d < x1) ctx.fillText('S' + n, X(d), 3);

  if (cX != null && cX >= x0 && cX <= x1) {
    ctx.strokeStyle = fg; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(cX), top); ctx.lineTo(X(cX), h - bottom); ctx.stroke();
  }
  if (dragStart != null && dragNow != null) {
    ctx.fillStyle = css('--accent'); ctx.globalAlpha = 0.12;
    ctx.fillRect(Math.min(dragStart, dragNow), top, Math.abs(dragNow - dragStart), h - top - bottom);
    ctx.globalAlpha = 1;
  }
}

function chartX(ev) {
  const r = $('chart').getBoundingClientRect();
  const C = chartLayout; if (!C) return null;
  const x = ev.clientX - r.left;
  return { x, v: C.x0 + (x - C.left) / (C.w - C.left - C.right) * (C.x1 - C.x0) };
}

/* ---------- Werte-Tabelle am Cursor ---------- */

function renderCursorTable() {
  const t = $('cursor-table');
  if (!L.length) { t.innerHTML = ''; return; }
  const idx = curIdx();
  const keys = S.channels.filter(k => k !== 'delta' && L.some(l => chan(l, k)));
  const g = idx ? gaps(idx) : null;
  let h = '<thead><tr><th>Runde</th><th>Zeit</th><th>Distanz</th>' + (L.length > 1 ? '<th>Δ Zeit</th><th>Δ Distanz</th>' : '');
  for (const k of keys) { const c = chanInfo(k); h += `<th>${esc(c.label)}${c.unit ? ' ' + esc(c.unit) : ''}</th>`; }
  h += '</tr></thead><tbody>';
  L.forEach((l, k) => {
    const i = idx ? idx[k] : null;
    h += `<tr><td class="lbl sw-cell" style="--c:${colorVar(l.slot)}">${esc(lapName(l))}${k ? '' : ' <span class="muted">(Ref)</span>'}</td>`;
    h += `<td>${i == null ? '–' : de(l.t[i], 2) + ' s'}</td><td>${i == null ? '–' : de(l.dist[i], 0) + ' m'}</td>`;
    if (L.length > 1) {
      if (!g || !k) h += '<td>–</td><td>–</td>';
      else h += `<td class="${g[k].dt > 0 ? 'dpos' : 'dneg'}">${signed(g[k].dt, 3)} s</td><td class="${g[k].dd > 0 ? 'dpos' : 'dneg'}">${signed(-g[k].dd, 1)} m</td>`;
    }
    for (const key of keys) {
      const arr = chan(l, key), c = chanInfo(key);
      if (!arr || i == null || !Number.isFinite(arr[i])) { h += '<td>–</td>'; continue; }
      const r = chartLayout && chartLayout.ranges[key];
      const f = r ? Math.max(0, Math.min(1, (arr[i] - r[0]) / (r[1] - r[0] || 1))) : 0;
      h += `<td>${de(arr[i], c.dec)}<span class="bar" style="--c:${colorVar(l.slot)}"><i style="width:${(f * 100).toFixed(0)}%"></i></span></td>`;
    }
    h += '</tr>';
  });
  t.innerHTML = h + '</tbody>';
}

/* ---------- G-Kraft am Cursor ---------- */

function drawGMini() {
  const cv = $('gmini'); const { ctx, w, h } = fitCanvas(cv);
  if (!L.length) return;
  const ref = L[0];
  if (!ref.gLat) { ctx.fillStyle = css('--fg-2'); ctx.font = `12px ${css('--font-body')}`; ctx.fillText('Keine G-Daten in dieser Session', 10, 20); return; }
  if (ref._gmax == null) { let m = 1; for (let i = 0; i < ref.gLat.length; i++) m = Math.max(m, Math.abs(ref.gLat[i]), Math.abs(ref.gLong[i])); ref._gmax = Math.ceil(m * 2) / 2; }
  const m = ref._gmax, R = Math.min(w, h) / 2 - 16, cx = w / 2, cy = h / 2, sc = R / m;
  const fg2 = css('--fg-2');
  ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
  for (let g = 0.5; g <= m + 1e-9; g += 0.5) { ctx.beginPath(); ctx.arc(cx, cy, g * sc, 0, 7); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.fillStyle = fg2; ctx.font = `11px ${css('--font-data')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(m.toFixed(1) + ' g', cx + R * 0.71 + 2, cy - R * 0.71);
  ctx.textAlign = 'center'; ctx.fillText('Gas', cx, cy - R - 2); ctx.textBaseline = 'top'; ctx.fillText('Bremse', cx, cy + R + 2);
  const idx = curIdx();
  if (!idx) { ctx.textBaseline = 'middle'; ctx.fillText('Cursor auf die Kurven', cx, cy + R / 2); return; }
  // Spur der letzten 1,5 s der Referenz
  ctx.strokeStyle = colorOf(ref.slot); ctx.globalAlpha = 0.5; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = Math.max(0, idx[0] - 15); i <= idx[0]; i++) { const x = cx + ref.gLat[i] * sc, y = cy - ref.gLong[i] * sc; i === Math.max(0, idx[0] - 15) ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke(); ctx.globalAlpha = 1;
  for (let k = L.length - 1; k >= 0; k--) {
    const l = L[k]; if (!l.gLat) continue;
    const i = idx[k], x = cx + l.gLat[i] * sc, y = cy - l.gLong[i] * sc;
    if (!k) { ctx.strokeStyle = colorOf(l.slot); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke(); }
    dot(ctx, [x, y], colorOf(l.slot), k ? 4.5 : 6);
  }
  const gl = ref.gLat[idx[0]], gg = ref.gLong[idx[0]];
  ctx.fillStyle = css('--fg'); ctx.font = `500 12px ${css('--font-data')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`quer ${signed(gl, 2)}`, 6, 6); ctx.fillText(`längs ${signed(gg, 2)}`, 6, 22);
  ctx.textAlign = 'right'; ctx.fillText(`${de(Math.hypot(gl, gg), 2)} g`, w - 6, 6);
}

/* ---------- Sektoren mit theoretischer Runde ---------- */

function renderSectors() {
  const t = $('sec-table');
  if (!L.length) { t.innerHTML = ''; $('sec-theo').textContent = ''; return; }
  const rows = L.map(l => ({ l, sum: l.sess.laps.find(x => x.n === l.n) }));
  const nSec = Math.max(0, ...rows.map(r => r.sum ? r.sum.sectors.length : 0));
  const best = [];
  for (let k = 0; k < nSec; k++) best.push(Math.min(...rows.map(r => (r.sum && r.sum.sectors[k]) || Infinity)));
  const ref = rows[0].sum;
  let h = '<thead><tr><th>Runde</th>';
  for (let k = 0; k < nSec; k++) h += `<th>S${k + 1}</th>`;
  h += '<th>Zeit</th></tr></thead><tbody>';
  for (const { l, sum } of rows) {
    h += `<tr><td class="lbl sw-cell" style="--c:${colorVar(l.slot)}">R${l.n}</td>`;
    for (let k = 0; k < nSec; k++) {
      const v = sum && sum.sectors[k];
      const d = l.k && v && ref && ref.sectors[k] ? v - ref.sectors[k] : null;
      h += `<td class="${v && v === best[k] && L.length > 1 ? 'pb' : ''}">${fmtSec(v)}${d != null ? `<small class="${d > 0 ? 'dpos' : 'dneg'}">${signed(d / 1000, 2)}</small>` : ''}</td>`;
    }
    const dl = l.k ? l.time - L[0].time : null;
    h += `<td>${fmtLap(l.time)}${dl != null ? `<small class="${dl > 0 ? 'dpos' : 'dneg'}">${signed(dl / 1000, 3)}</small>` : ''}</td></tr>`;
  }
  const s = L[0].sess, bs = bestSectors(s), theo = theoLap(s);
  if (theo) {
    h += `<tr class="theo"><td class="lbl">Theoretisch</td>${bs.map(v => `<td>${fmtSec(v)}</td>`).join('')}<td>${fmtLap(theo)}</td></tr>`;
    $('sec-theo').textContent = `Potenzial ${signed(-(s.best - theo) / 1000, 3)} s`;
  } else $('sec-theo').textContent = '';
  t.innerHTML = h + '</tbody>';
}

/* ---------- Farbskalen für die Karte ---------- */

function rampColor(stops, f) {
  const x = Math.min(1, Math.max(0, f)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), t = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
const RPM_RAMP = [[59, 91, 219], [132, 94, 247], [214, 51, 108], [253, 126, 20], [255, 212, 59]];
const GLAT_RAMP = [[116, 192, 252], [255, 212, 59], [240, 62, 62]];
const PEDAL = { gas: '#2f9e44', brake: '#e03131', coast: '#ced4da' };

function pedalState(lap, i) {
  const g = lap.gLong ? lap.gLong[i] : lap.acc[i] / 9.81;
  return g > 0.04 ? 'gas' : g < -0.12 ? 'brake' : 'coast';
}
function mapColorFn(lap) {
  const mode = $('map-color').value;
  if (mode === 'rpm' && lap.rpm) {
    const bw = +$('rpm-bw').value;
    let lo = Infinity, hi = -Infinity;
    for (const r of lap.rpm) if (r > 0) { lo = Math.min(lo, r); hi = Math.max(hi, r); }
    if (!Number.isFinite(lo)) return () => [css('--fg-2'), 1];
    lo = Math.floor(lo / bw) * bw; hi = Math.floor(hi / bw) * bw;
    return i => {
      const band = Math.floor(lap.rpm[i] / bw) * bw;
      const c = rampColor(RPM_RAMP, (band - lo) / (hi - lo || 1));
      return S.rpmBand != null && band !== S.rpmBand ? [c, 0.15] : [c, 1];
    };
  }
  if (mode === 'pedal') return i => [PEDAL[pedalState(lap, i)], 1];
  if (mode === 'glat' && lap.gLat) {
    let m = 0.5; for (const g of lap.gLat) m = Math.max(m, Math.abs(g));
    return i => [rampColor(GLAT_RAMP, Math.abs(lap.gLat[i]) / m), 1];
  }
  let vmin = Infinity, vmax = -Infinity;
  for (const v of lap.speed) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
  return i => [speedColor((lap.speed[i] - vmin) / (vmax - vmin || 1)), 1];
}
function renderRamp() {
  const mode = $('map-color').value;
  const grad = st => `linear-gradient(90deg, ${st.map(c => `rgb(${c})`).join(',')})`;
  let h;
  if (mode === 'rpm') h = `<span>niedrig</span><i style="background:${grad(RPM_RAMP)}"></i><span>hoch</span>${S.rpmBand != null ? `<span>· Band ${S.rpmBand.toLocaleString('de-DE')} hervorgehoben</span>` : ''}`;
  else if (mode === 'pedal') h = `<span><b class="sw" style="background:${PEDAL.gas}"></b>Gas</span><span><b class="sw" style="background:${PEDAL.brake}"></b>Bremse</span><span><b class="sw" style="background:${PEDAL.coast}"></b>Rollen</span>`;
  else if (mode === 'glat') h = `<span>0 g</span><i style="background:${grad(GLAT_RAMP)}"></i><span>max. quer</span>`;
  else h = '<span>langsam</span><i></i><span>schnell</span>';
  $('ramp').innerHTML = h + (L.length > 1 ? '<span>· Farbe = Referenz, weitere Runden als Linie</span>' : '');
}

/* ---------- Cursor-Update ---------- */

function updateCursor() {
  drawChart(); drawMap(); drawGMini(); renderCursorTable();
  if (activeTab === 'gg') drawGG();
}

/* ---------- Tabs ---------- */

let activeTab = 'laps';
function showTab(name) {
  activeTab = name;
  for (const b of $('tabs').querySelectorAll('button')) { b.classList.toggle('on', b.dataset.tab === name); b.setAttribute('aria-selected', String(b.dataset.tab === name)); }
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== 'tab-' + name;
  const autoColor = { rpm: 'rpm', power: 'pedal', gg: 'glat' }[name];
  if (autoColor) { $('map-color').value = autoColor; renderRamp(); queueMap(); }
  if (name !== 'video') for (const v of vid.els.values()) if (!v.paused) v.pause();
  try { localStorage.setItem('tab', name); } catch {}
  renderTab();
}
function renderTab() {
  if (!L.length) return;
  if (activeTab === 'laps') drawEvolution();
  else if (activeTab === 'event') renderEvent();
  else if (activeTab === 'maxmin') renderMaxMin();
  else if (activeTab === 'rpm') drawRpmHist();
  else if (activeTab === 'power') drawPower();
  else if (activeTab === 'gg') drawGG();
  else if (activeTab === 'session') drawSession();
  else if (activeTab === 'setup') renderSetup();
  else if (activeTab === 'video') renderVideos();
}

/* ---------- Rundenzeiten-Verlauf ---------- */

function drawEvolution() {
  const cv = $('evo'); const { ctx, w, h } = fitCanvas(cv);
  const s = byId(S.current); if (!s || !s.laps.length) return;
  const laps = s.laps, limit = s.best * 1.07;
  const shown = laps.map(l => Math.min(l.time, limit * 1.02));
  const lo = s.best * 0.995, hi = Math.max(...shown);
  const left = 58, right = 8, top = 8, bottom = 16;
  const X = i => left + (laps.length > 1 ? i / (laps.length - 1) : 0.5) * (w - left - right);
  const Y = v => top + (1 - (v - lo) / (hi - lo || 1)) * (h - top - bottom);
  ctx.font = `11px ${css('--font-data')}`; ctx.fillStyle = css('--fg-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = css('--grid');
  for (const v of [s.best, (s.best + hi) / 2, hi]) { ctx.beginPath(); ctx.moveTo(left, Y(v)); ctx.lineTo(w - right, Y(v)); ctx.stroke(); ctx.fillText(fmtLap(Math.round(v / 10) * 10), left - 4, Y(v)); }
  ctx.strokeStyle = css('--fg-2'); ctx.lineWidth = 1.2; ctx.beginPath();
  shown.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.stroke();
  laps.forEach((l, i) => {
    const e = selEntry(s.id, l.n);
    ctx.fillStyle = e ? colorOf(e.slot) : l.time === s.best ? css('--best') : l.time > limit ? css('--line') : css('--fg');
    ctx.beginPath(); ctx.arc(X(i), Y(shown[i]), e ? 5.5 : 3, 0, 7); ctx.fill();
    if (e) { ctx.strokeStyle = css('--fg'); ctx.lineWidth = 1; ctx.stroke(); }
  });
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = css('--fg-2');
  laps.forEach((l, i) => { if (laps.length < 25 || i % 2 === 0) ctx.fillText(l.n, X(i), h - bottom + 3); });
}

/* ---------- Wochenende: alle Sessions des Events ---------- */

function eventSessions() {
  const s = byId(S.current); if (!s) return [];
  const day = iso => Date.parse(iso + 'T12:00:00') / 864e5;
  return S.sessions.filter(o => o.track === s.track && Math.abs(day(o.date) - day(s.date)) <= 3 && o.best)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
function renderEvent() {
  const list = eventSessions(), s = byId(S.current);
  if (!list.length) { $('event-table').innerHTML = ''; return; }
  const top = Math.min(...list.map(o => o.best));
  $('event-title').textContent = `${s.track} · ${fmtDate(list[0].date)}–${fmtDate(list[list.length - 1].date)} · ${list.length} Sessions · Bestzeit ${fmtLap(top)}`;
  let h = '<thead><tr><th>Tag</th><th>Start</th><th>Typ</th><th>Fahrer</th><th>Rd.</th><th>Bestzeit</th><th>Δ Event</th><th>Theoretisch</th><th>Vmax</th><th>Wasser max</th><th>EGT max</th></tr></thead><tbody>';
  for (const o of list) {
    const mx = k => Math.max(0, ...o.laps.map(l => l[k]));
    h += `<tr data-id="${o.id}"${o.id === S.current ? ' class="sel" style="--c:var(--accent)"' : ''}>
      <td>${fmtDate(o.date)}</td><td>${o.time}</td><td>${esc((o.sessionType || '').toLowerCase())}</td><td>${esc(driverOf(o))}</td><td>${o.laps.length}</td>
      <td class="${o.best === top ? 'lapbest' : ''}">${fmtLap(o.best)}</td><td>${o.best === top ? '' : '+' + ((o.best - top) / 1000).toFixed(3)}</td>
      <td>${fmtLap(theoLap(o))}</td><td>${de(mx('maxSpeed'), 1)}</td><td>${mx('maxT1') ? mx('maxT1').toFixed(0) + '°' : '–'}</td><td>${mx('maxT2') ? mx('maxT2').toFixed(0) + '°' : '–'}</td></tr>`;
  }
  $('event-table').innerHTML = h + '</tbody>';
  // Bestzeit je Session als Verlauf
  const cv = $('event-chart'); const { ctx, w, h: hh } = fitCanvas(cv);
  const left = 58, right = 8, topP = 10, bottom = 22;
  const vals = list.map(o => o.best), lo = Math.min(...vals) * 0.996, hi = Math.max(...vals) * 1.004;
  const X = i => left + (list.length > 1 ? i / (list.length - 1) : 0.5) * (w - left - right);
  const Y = v => topP + (1 - (v - lo) / (hi - lo || 1)) * (hh - topP - bottom);
  ctx.font = `11px ${css('--font-data')}`; ctx.fillStyle = css('--fg-2'); ctx.strokeStyle = css('--grid'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of [lo, (lo + hi) / 2, hi]) { ctx.beginPath(); ctx.moveTo(left, Y(v)); ctx.lineTo(w - right, Y(v)); ctx.stroke(); ctx.fillText(fmtLap(Math.round(v / 100) * 100), left - 4, Y(v)); }
  ctx.strokeStyle = css('--fg-2'); ctx.lineWidth = 1.2; ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  list.forEach((o, i) => {
    ctx.fillStyle = o.best === top ? css('--best') : o.id === S.current ? css('--accent') : css('--fg');
    ctx.beginPath(); ctx.arc(X(i), Y(o.best), o.id === S.current ? 5.5 : 4, 0, 7); ctx.fill();
    ctx.fillStyle = css('--fg-2'); ctx.textAlign = list.length > 1 && i === 0 ? 'left' : i === list.length - 1 && i ? 'right' : 'center';
    ctx.fillText(`${fmtDate(o.date).slice(0, 2)} ${o.time}`, X(i), hh - bottom + 5);
  });
}
async function compareEventBests() {
  const list = eventSessions().sort((a, b) => a.best - b.best).slice(0, MAX_SEL);
  if (!list.length) return;
  S.sel = list.map((o, k) => ({ id: o.id, n: o.bestLap, slot: k }));
  S.range = null; S.cx = null; view = null;
  await refreshTraces();
  toast(`Bestrunden von ${list.length} Sessions im Overlay, schnellste als Referenz`);
}

/* ---------- Max/Min ---------- */

function renderMaxMin() {
  const keys = ['speed', 'rpm', 'T1', 'T2', 'gLat', 'gLong', 'Altitude', ...S.math.map(m => 'm:' + m.name)];
  const ext = (lap, key) => {
    const a = chan(lap, key); if (!a) return null;
    let imax = -1, imin = -1;
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) continue;
      if (key === 'rpm' && a[i] <= 0) continue;
      if (imax < 0 || a[i] > a[imax]) imax = i;
      if (imin < 0 || a[i] < a[imin]) imin = i;
    }
    return imax < 0 ? null : { imax, imin, a };
  };
  let h = '<thead><tr><th>Kanal</th>' + L.map(l => `<th style="color:${colorVar(l.slot)}">R${l.n} max</th><th style="color:${colorVar(l.slot)}">min</th>`).join('') + '</tr></thead><tbody>';
  for (const key of keys) {
    const c = chanInfo(key); if (!c) continue;
    const es = L.map(l => ext(l, key)); if (!es.some(Boolean)) continue;
    const cell = (e, which, k, kind) => e ? `<td class="pick" data-k="${k}" data-i="${e[which]}" data-label="${esc(`R${L[k].n} ${kind} ${c.label} ${de(e.a[e[which]], c.dec)} ${c.unit}`)}">${de(e.a[e[which]], c.dec)}</td>` : '<td>–</td>';
    h += `<tr><td class="lbl">${esc(c.label)} <span class="muted">${esc(c.unit)}</span></td>${es.map((e, k) => cell(e, 'imax', k, 'Max') + cell(e, 'imin', k, 'Min')).join('')}</tr>`;
  }
  $('mm-table').innerHTML = h + '</tbody>';
}
function pickMarker(k, i, label) {
  const lap = L[k]; if (!lap) return;
  stopPlay(); play.t = null;
  S.marker = { k, i, label };
  S.cx = xs(lap)[i];
  if (S.range && (S.cx < S.range[0] || S.cx > S.range[1])) { S.range = null; fitRange(); }
  updateCursor();
}

/* ---------- Drehzahlbänder ---------- */

let rpmBars = [];
function rpmHistogram(laps, bw) {
  const bands = new Map(); let total = 0;
  for (const lap of laps) {
    if (!lap.rpm) continue;
    const dt = lap.t[1] - lap.t[0];
    for (let i = 0; i < lap.rpm.length; i++) {
      if (lap.rpm[i] <= 0) continue;
      const b = Math.floor(lap.rpm[i] / bw) * bw;
      const e = bands.get(b) || { up: 0, down: 0 };
      if (lap.acc[i] >= 0) e.up += dt; else e.down += dt;
      bands.set(b, e); total += dt;
    }
  }
  return { bands, total };
}
function drawRpmHist() {
  const cv = $('rpm-hist'); const { ctx, w, h } = fitCanvas(cv);
  const ref = L[0];
  if (!ref || !ref.rpm) { ctx.fillStyle = css('--fg-2'); ctx.fillText('Keine Drehzahldaten', 10, 20); return; }
  const bw = +$('rpm-bw').value;
  let groups;
  if ($('rpm-scope').value === 'fast') {
    const s = byId(ref.sid), laps = S.lapsCache.get(ref.sid);
    const fast = laps ? [...laps.values()].filter(l => l.time <= s.best * 1.07) : [ref];
    groups = [{ hist: rpmHistogram(fast, bw), color: null, label: `${fast.length} schnelle Runden der Referenz-Session` }];
  } else groups = L.map((l, k) => ({ hist: rpmHistogram([l], bw), color: k ? colorOf(l.slot) : null }));
  const share = (g, k) => { const e = g.hist.bands.get(k); return e && g.hist.total ? (e.up + e.down) / g.hist.total : 0; };
  const keys = [...new Set(groups.flatMap(g => [...g.hist.bands.keys()]))].sort((a, b) => b - a).filter(k => groups.some(g => share(g, k) > 0.003));
  const left = 96, right = 110, top = 6, rowH = Math.max(14, Math.min(34, (h - top - 26) / Math.max(1, keys.length)));
  let maxShare = 0.05;
  for (const k of keys) for (const g of groups) maxShare = Math.max(maxShare, share(g, k));
  const W = v => v / maxShare * (w - left - right);
  ctx.font = `11px ${css('--font-data')}`; ctx.textBaseline = 'middle';
  rpmBars = [];
  const sub = (rowH - 4) / groups.length;
  keys.forEach((k, r) => {
    const y = top + r * rowH;
    const sel = S.rpmBand === k;
    if (sel) { ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, y, w, rowH); }
    ctx.fillStyle = sel ? css('--fg') : css('--fg-2'); ctx.textAlign = 'right';
    ctx.fillText(`${(k / 1000).toFixed(bw < 1000 ? 2 : 0)}–${((k + bw) / 1000).toFixed(bw < 1000 ? 2 : 0)}k`, left - 8, y + rowH / 2);
    groups.forEach((g, gi) => {
      const e = g.hist.bands.get(k) || { up: 0, down: 0 }, by = y + 2 + gi * sub, bh = Math.max(2, sub - 1);
      if (g.color) { ctx.fillStyle = g.color; ctx.fillRect(left, by, W((e.up + e.down) / (g.hist.total || 1)), bh); return; }
      const up = W(e.up / (g.hist.total || 1)), down = W(e.down / (g.hist.total || 1));
      ctx.fillStyle = PEDAL.gas; ctx.fillRect(left, by, up, bh);
      ctx.fillStyle = PEDAL.brake; ctx.fillRect(left + up, by, down, bh);
      if (gi === 0 && e.up + e.down > 0) { ctx.fillStyle = css('--fg'); ctx.textAlign = 'left'; ctx.fillText(`${de(share(g, k) * 100, 1)} % · ${de(e.up + e.down, 1)} s`, w - right + 6, y + rowH / 2); }
    });
    rpmBars.push({ y0: y, y1: y + rowH, band: k });
  });
  ctx.fillStyle = css('--fg-2'); ctx.textAlign = 'left';
  ctx.fillText(groups[0].label || 'Referenz grün/rot, weitere Runden in ihrer Farbe', left, h - 8);
}

/* ---------- Motorleistung ---------- */

function powerCurve(lap, bw = 500) {
  const bins = new Map();
  if (!lap.rpm) return [];
  const n = lap.rpm.length, dt = lap.t[1] - lap.t[0];
  for (let i = 2; i < n - 2; i++) {
    if (lap.acc[i] < 0.5 || lap.rpm[i] <= 0) continue;          // nur Vollgas-Beschleunigung
    const drpm = (lap.rpm[i + 2] - lap.rpm[i - 2]) / (4 * dt);
    const b = Math.floor(lap.rpm[i] / bw) * bw + bw / 2;
    const e = bins.get(b) || { acc: 0, drpm: 0, n: 0 };
    e.acc += lap.acc[i] * 3.6; e.drpm += drpm; e.n++;
    bins.set(b, e);
  }
  return [...bins.entries()].filter(([, e]) => e.n >= 3).sort((a, b) => a[0] - b[0]).map(([rpm, e]) => ({ rpm, acc: e.acc / e.n, drpm: e.drpm / e.n, n: e.n }));
}
function gearRatio(lap) {
  if (!lap.rpm) return null;
  const v = [];
  for (let i = 0; i < lap.rpm.length; i++) if (lap.rpm[i] > 9000 && lap.speed[i] > 40) v.push(lap.speed[i] / lap.rpm[i] * 1000);
  if (v.length < 10) return null;
  v.sort((a, b) => a - b); return v[v.length >> 1];
}
function statRow(label, vals) {
  return `<div class="stat"><span>${label}</span><b>${vals.map((v, k) => `<i style="--c:${colorVar(L[k].slot)}">${v}</i>`).join('')}</b></div>`;
}
function drawPower() {
  const cv = $('power-chart'); const { ctx, w, h } = fitCanvas(cv);
  const curves = L.map(l => powerCurve(l));
  const all = curves.flat();
  if (!all.length) { ctx.fillStyle = css('--fg-2'); ctx.fillText('Zu wenig Beschleunigungsdaten', 10, 20); $('power-stats').innerHTML = ''; return; }
  const x0 = Math.min(...all.map(p => p.rpm)) - 250, x1 = Math.max(...all.map(p => p.rpm)) + 250;
  const y1 = Math.max(...all.map(p => p.acc)) * 1.1, y0 = 0;
  const left = 46, right = 12, top = 22, bottom = 26;
  const X = r => left + (r - x0) / (x1 - x0) * (w - left - right), Y = v => top + (1 - (v - y0) / (y1 - y0)) * (h - top - bottom);
  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--fg-2'); ctx.font = `11px ${css('--font-data')}`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const t of niceTicks(y0, y1, 4)) { ctx.beginPath(); ctx.moveTo(left, Y(t)); ctx.lineTo(w - right, Y(t)); ctx.stroke(); ctx.fillText(t.toFixed(1), left - 6, Y(t)); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of niceTicks(x0, x1, 6)) ctx.fillText((t / 1000).toFixed(t % 1000 ? 1 : 0) + 'k', X(t), h - bottom + 6);
  ctx.textAlign = 'left'; ctx.fillStyle = css('--fg'); ctx.font = `600 12px ${css('--font-body')}`;
  ctx.fillText('Beschleunigung (km/h pro s) über Drehzahl', left, 4);
  for (let k = L.length - 1; k >= 0; k--) {
    const pts = curves[k]; if (!pts.length) continue;
    const color = colorOf(L[k].slot);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = k ? 1.6 : 2.2; ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.rpm), Y(p.acc)) : ctx.moveTo(X(p.rpm), Y(p.acc)))); ctx.stroke();
    for (const p of pts) { ctx.beginPath(); ctx.arc(X(p.rpm), Y(p.acc), 3, 0, 7); ctx.fill(); }
  }
  const peak = c => c.length ? c.reduce((m, p) => (p.acc > m.acc ? p : m), c[0]).rpm.toLocaleString('de-DE') : '–';
  const rpmMax = lap => lap.rpm ? Math.max(...lap.rpm).toLocaleString('de-DE') : '–';
  $('power-stats').innerHTML =
    statRow('Übersetzung km/h je 1000 U/min', L.map(l => { const g = gearRatio(l); return g ? de(g, 2) : '–'; })) +
    statRow('Stärkster Zug bei U/min', curves.map(peak)) +
    statRow('Max. Drehzahl', L.map(rpmMax));
}

/* ---------- G-G-Diagramm ---------- */

function drawGG() {
  const cv = $('gg'); const { ctx, w, h } = fitCanvas(cv);
  const laps = L.filter(l => l.gLat);
  if (!laps.length) { ctx.fillStyle = css('--fg-2'); ctx.fillText('Keine G-Daten in dieser Session', 10, 20); $('gg-stats').innerHTML = ''; return; }
  let m = 1;
  for (const l of laps) for (let i = 0; i < l.gLat.length; i++) m = Math.max(m, Math.abs(l.gLat[i]), Math.abs(l.gLong[i]));
  m = Math.ceil(m * 2) / 2;
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 24, sc = R / m;
  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--fg-2'); ctx.font = `11px ${css('--font-data')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  for (let g = 0.5; g <= m + 1e-9; g += 0.5) { ctx.beginPath(); ctx.arc(cx, cy, g * sc, 0, 7); ctx.stroke(); ctx.fillText(g.toFixed(1) + ' g', cx + g * sc * 0.71 + 2, cy - g * sc * 0.71 - 2); }
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.fillStyle = css('--fg-2'); ctx.textAlign = 'center';
  ctx.fillText('Beschleunigen', cx, 16); ctx.textBaseline = 'top'; ctx.fillText('Bremsen', cx, h - 16);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('links', 4, cy - 8); ctx.textAlign = 'right'; ctx.fillText('rechts', w - 4, cy - 8);
  for (let k = L.length - 1; k >= 0; k--) {
    const l = L[k]; if (!l.gLat) continue;
    ctx.fillStyle = colorOf(l.slot); ctx.globalAlpha = 0.45;
    for (let i = 0; i < l.gLat.length; i++) { ctx.beginPath(); ctx.arc(cx + l.gLat[i] * sc, cy - l.gLong[i] * sc, 1.8, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  const idx = curIdx();
  if (idx && L[0].gLat) { ctx.strokeStyle = css('--fg'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx + L[0].gLat[idx[0]] * sc, cy - L[0].gLong[idx[0]] * sc, 6, 0, 7); ctx.stroke(); ctx.lineWidth = 1; }
  const st = l => {
    if (!l.gLat) return null;
    let a = 0, b = 0, br = 0, ac = 0;
    for (let i = 0; i < l.gLat.length; i++) { a = Math.min(a, l.gLat[i]); b = Math.max(b, l.gLat[i]); br = Math.min(br, l.gLong[i]); ac = Math.max(ac, l.gLong[i]); }
    return { L: -a, R: b, br: -br, ac };
  };
  const stats = L.map(st);
  const row = (label, key) => statRow(label, stats.map(s => s ? de(s[key], 2) : '–'));
  $('gg-stats').innerHTML = row('Max quer links (g)', 'L') + row('Max quer rechts (g)', 'R') + row('Max Bremsen (g)', 'br') + row('Max Beschleunigen (g)', 'ac');
}

/* ---------- Session-Verlauf ---------- */

let sesBands = [];
async function drawSession() {
  const s = byId(S.current); if (!s) return;
  const laps = await lapsOf(S.current);
  const cv = $('ses-chart'); const { ctx, w, h } = fitCanvas(cv);
  const items = s.laps.map(l => ({ l, d: laps.get(l.n), t0: lapStart(s, l.n) })).filter(x => x.d);
  if (!items.length) return;
  const T = items[items.length - 1].t0 + items[items.length - 1].l.time / 1000;
  const left = 50, right = 10, top = 18, band = 30, gap = 14;
  const ph = (h - top - band - gap * 2 - 4) / 2;
  const X = t => left + t / T * (w - left - right);
  const fg = css('--fg'), fg2 = css('--fg-2'), grid = css('--grid');
  const panes = [[$('ses-ch1').value, top], [$('ses-ch2').value, top + ph + gap]];
  for (const [key, py] of panes) {
    const c = chanInfo(key); if (!c) continue;
    let lo = Infinity, hi = -Infinity;
    for (const { d } of items) { const a = chan(d, key); if (a) for (const v of a) if (Number.isFinite(v) && !(key === 'rpm' && v <= 0)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = `600 12px ${css('--font-body')}`; ctx.fillStyle = fg;
    ctx.fillText(`${c.label}${c.unit ? ' (' + c.unit + ')' : ''}`, left + 6, py - 16);
    if (!isFinite(lo)) { ctx.fillStyle = fg2; ctx.fillText('keine Daten in dieser Session', left + 6, py + 4); continue; }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const Y = v => py + ph - (v - lo) / (hi - lo) * ph;
    ctx.strokeStyle = grid; ctx.fillStyle = fg2; ctx.font = `11px ${css('--font-data')}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of niceTicks(lo, hi, 3)) { ctx.beginPath(); ctx.moveTo(left, Y(t)); ctx.lineTo(w - right, Y(t)); ctx.stroke(); ctx.fillText(fmtTick(t, hi - lo), left - 6, Y(t)); }
    for (const { l, d, t0 } of items) {
      const a = chan(d, key); if (!a) continue;
      const e = selEntry(s.id, l.n);
      line(ctx, d.t, a, t => X(t0 + t), Y, e ? colorOf(e.slot) : fg2, e ? 1.8 : 1);
    }
  }
  // Rundenfelder unten
  sesBands = [];
  const by = h - band;
  ctx.font = `500 11px ${css('--font-data')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  items.forEach(({ l, t0 }, i) => {
    const xa = X(t0), xb = X(t0 + l.time / 1000), e = selEntry(s.id, l.n);
    ctx.fillStyle = e ? colorOf(e.slot) : i % 2 ? css('--surface-2') : css('--line');
    ctx.fillRect(xa, by, xb - xa - 1, band - 2);
    ctx.fillStyle = e ? '#000' : l.time === s.best ? css('--best') : fg;
    const txt = xb - xa > 70 ? `R${l.n} ${fmtLap(l.time)}` : xb - xa > 22 ? String(l.n) : '';
    if (txt) ctx.fillText(txt, (xa + xb) / 2, by + band / 2 - 1);
    sesBands.push({ x0: xa, x1: xb, n: l.n });
  });
}
function lapStart(s, n) { let t = 0; for (const l of s.laps) { if (l.n >= n) break; t += l.time / 1000; } return t; }

/* ---------- Videos: eins je Runde, synchron wie in ADA ---------- */

const vid = { urls: {}, els: new Map() };
function videoOffset(sid, n) {
  const vs = S.videoSync[sid], s = byId(sid);
  if (!vs || !s) return null;
  return vs.vt + lapStart(s, n) - lapStart(s, vs.lap);
}
function renderVideos() {
  const box = $('videos'); box.textContent = '';
  const keys = new Set();
  for (const l of L) {
    const key = l.sid + ':' + l.n, url = vid.urls[l.sid], off = videoOffset(l.sid, l.n), vs = S.videoSync[l.sid];
    keys.add(key);
    const tile = document.createElement('div');
    tile.className = 'vtile'; tile.style.setProperty('--c', colorVar(l.slot));
    tile.innerHTML = `<div class="vh"><b>${esc(lapName(l))} · ${fmtLap(l.time)}</b><span class="muted">${esc(driverOf(l.sess))}</span></div>`;
    if (url) {
      let v = vid.els.get(key);
      if (!v || v.dataset.url !== url) {
        v = document.createElement('video');
        Object.assign(v, { src: url, controls: true, playsInline: true, preload: 'auto' });
        v.dataset.url = url; v.dataset.sid = l.sid; v.dataset.n = l.n;
        v.addEventListener('play', onVideoPlay); v.addEventListener('pause', onVideoPause);
        vid.els.set(key, v);
        if (off != null) v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.max(0, off + (play.t ?? 0)); } catch {} }, { once: true });
      }
      v.muted = l.k > 0;
      tile.appendChild(v);
      const foot = document.createElement('div'); foot.className = 'vh';
      foot.innerHTML = `<span class="vstate${off != null ? ' ok' : ''}">${off != null ? `Synchron (Start R${vs.lap} bei ${de(vs.vt, 2)} s)` : 'Zur Ziellinie am Start dieser Runde spulen'}</span>
        <span><button type="button" class="btn small${off == null ? ' primary' : ''}" data-sync="${key}">Synchronisieren</button>
        <label class="btn small ghost">Andere Datei<input type="file" accept="video/*" data-sid="${l.sid}" hidden></label></span>`;
      tile.appendChild(foot);
    } else {
      tile.insertAdjacentHTML('beforeend', `<label class="vpick"><span>Video dieser Session wählen (GoPro, Handy)<br><br><span class="btn small primary">Datei wählen</span></span><input type="file" accept="video/*" data-sid="${l.sid}" hidden></label>`);
    }
    box.appendChild(tile);
  }
  for (const [k, v] of vid.els) if (!keys.has(k)) { v.pause(); vid.els.delete(k); }
}
function syncVideos(t, force) {
  if (activeTab !== 'video') return;
  for (const v of vid.els.values()) {
    const off = videoOffset(v.dataset.sid, +v.dataset.n);
    if (off == null || !v.readyState) continue;
    const target = off + t;
    if (force || Math.abs(v.currentTime - target) > 0.3) { try { v.currentTime = Math.max(0, target); } catch {} }
  }
}
function playVideos() {
  if (activeTab !== 'video') return;
  syncVideos(play.t, true);
  for (const v of vid.els.values()) {
    if (videoOffset(v.dataset.sid, +v.dataset.n) == null) continue;
    v.playbackRate = +$('play-speed').value; v.play().catch(() => {});
  }
}
// Startet jemand ein Video direkt, läuft alles ab dessen Position mit
function onVideoPlay(e) {
  if (play.running) return;
  const v = e.target, off = videoOffset(v.dataset.sid, +v.dataset.n);
  if (off == null) return;
  play.t = Math.max(0, Math.min(maxT(), v.currentTime - off));
  startPlay();
}
function onVideoPause() { if (play.running) stopPlay(); }

/* ---------- Setup-Notizen ---------- */

const SETUP_FIELDS = ['engine', 'gear', 'tyre', 'pf', 'pr', 'carb', 'chassis', 'weather', 'notes'];
function renderSetup() {
  const d = S.setup[S.current] || {};
  for (const f of SETUP_FIELDS) $('su-' + f).value = d[f] || '';
  const s = byId(S.current);
  $('setup-hint').textContent = `Für die Session ${s.track}, ${fmtDate(s.date)} ${s.time}. Wird automatisch gespeichert.`;
}
let setupTimer = null;
function onSetupInput() {
  const d = {};
  for (const f of SETUP_FIELDS) { const v = $('su-' + f).value.trim(); if (v) d[f] = v; }
  if (Object.keys(d).length) S.setup[S.current] = d; else delete S.setup[S.current];
  clearTimeout(setupTimer);
  setupTimer = setTimeout(async () => { await store.set('setup', S.setup); $('setup-hint').textContent = 'Gespeichert.'; renderHead(byId(S.current)); }, 500);
}

/* ---------- Fahrer-Dialog ---------- */

function openDriverDialog() {
  const counts = {};
  for (const s of S.sessions) counts[s.driverRaw] = (counts[s.driverRaw] || 0) + 1;
  const raws = Object.keys(counts).sort((a, b) => looksDefaultDriver(b) - looksDefaultDriver(a) || a.localeCompare(b));
  const known = [...new Set(S.sessions.filter(s => !looksDefaultDriver(s.driverRaw)).map(s => prettyDriver(s.driverRaw)).concat(Object.values(S.driverMap)))];
  $('dlg-rows').innerHTML = raws.map((r, i) => `
    <span class="raw">${esc(r)}</span><span class="n">${counts[r]}×</span>
    <input id="dm-${i}" type="text" list="driver-list" data-raw="${esc(r)}" value="${esc(S.driverMap[r] || '')}" placeholder="${esc(looksDefaultDriver(r) ? (known[0] || 'Fahrername') : prettyDriver(r))}">`).join('');
  $('dlg').hidden = false;
  const first = $('dlg-rows').querySelector('input'); if (first) first.focus();
}
async function saveDriverDialog() {
  const map = {};
  for (const inp of $('dlg-rows').querySelectorAll('input')) { const v = inp.value.trim(); if (v) map[inp.dataset.raw] = v; }
  S.driverMap = map; await store.set('driverMap', map);
  $('dlg').hidden = true;
  rerenderAll(); toast('Fahrerzuordnung gespeichert');
}
function rerenderAll() {
  renderFilters(); renderLibrary(); renderBanner(); renderLegend(); renderCursorTable();
  const s = byId(S.current); if (s) renderHead(s);
}

/* ---------- X-Achse ---------- */

function setXMode(m) {
  if (m === S.xMode) return;
  const ref = L[0];
  if (ref && S.cx != null) {
    const i = Math.min(ref.t.length - 1, idxAt(xs(ref), S.cx));
    S.xMode = m; S.cx = xs(ref)[i];
  } else S.xMode = m;
  S.range = null; if (ref) fitView(ref);
  $('x-dist').setAttribute('aria-pressed', String(m === 'dist'));
  $('x-time').setAttribute('aria-pressed', String(m === 'time'));
  try { localStorage.setItem('xMode', m); } catch {}
  updateCursor();
}

/* ---------- Vollbild wie in der Boxenmauer ---------- */

function wireFullscreen() {
  const root = document.documentElement, btn = $('btn-fs');
  const enter = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (!enter || !(document.fullscreenEnabled || document.webkitFullscreenEnabled)) return;
  btn.hidden = false;
  const toggle = () => { try { const r = current() ? exit.call(document) : enter.call(root); r && r.catch && r.catch(() => {}); } catch {} };
  let idle;
  const topbar = document.querySelector('.topbar');
  const wake = () => {
    root.classList.remove('fs-idle'); clearTimeout(idle);
    if (!current()) return;
    root.style.setProperty('--topbar-h', topbar.offsetHeight + 4 + 'px');
    idle = setTimeout(() => {
      if (topbar.matches(':hover, :focus-within') || !$('dlg').hidden) return wake();
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
    if (ev.target.closest('input, textarea, select, [contenteditable]')) return;
    ev.preventDefault(); toggle();
  });
}

/* ---------- Events ---------- */

function bind() {
  $('file-input').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });  // ohne accept-Filter, sonst graut iPad/iOS .alf2 aus
  $('btn-sample').addEventListener('click', loadSamples);
  $('btn-drivers').addEventListener('click', openDriverDialog);
  $('dlg-cancel').addEventListener('click', () => { $('dlg').hidden = true; });
  $('dlg-save').addEventListener('click', saveDriverDialog);
  $('dlg').addEventListener('keydown', e => { if (e.key === 'Escape') $('dlg').hidden = true; });
  for (const id of ['f-track', 'f-driver', 'f-cat', 'f-sort', 'f-fav', 'f-date']) $(id).addEventListener('change', renderLibrary);
  $('lib-list').addEventListener('click', e => {
    const b = e.target.closest('.lib-item');
    if (!b) return;
    if (b.dataset.id === S.current) { treeOpen = !treeOpen; renderLibrary(); } else openSession(b.dataset.id);
  });
  $('lib-list').addEventListener('change', e => { const c = e.target.closest('input[data-sid]'); if (c) toggleLap(c.dataset.sid, +c.dataset.n); });

  $('s-driver').addEventListener('change', async e => {
    const s = byId(S.current); const v = e.target.value.trim();
    if (v && v !== (S.driverMap[s.driverRaw] || prettyDriver(s.driverRaw))) S.overrides[s.id] = v; else delete S.overrides[s.id];
    await store.set('overrides', S.overrides);
    rerenderAll(); toast(`Fahrer für diese Session: ${driverOf(s)}`);
  });
  $('s-fav').addEventListener('click', async () => {
    const id = S.current; if (S.favs[id]) delete S.favs[id]; else S.favs[id] = true;
    await store.set('favs', S.favs); renderHead(byId(id)); renderLibrary();
  });
  $('lap-table').addEventListener('click', e => { const tr = e.target.closest('tr[data-lap]'); if (tr) toggleLap(S.current, +tr.dataset.lap); });
  $('legend').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { const x = S.sel[+rm.dataset.rm]; if (x) toggleLap(x.id, x.n); return; }
    const lg = e.target.closest('.lg'); if (lg) setRef(+lg.dataset.k);
  });

  // Kanäle
  $('btn-channels').addEventListener('click', e => {
    e.stopPropagation();
    const pop = $('pop-channels'); pop.hidden = !pop.hidden;
    $('btn-channels').setAttribute('aria-expanded', String(!pop.hidden));
  });
  $('pop-channels').addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.id === 'math-toggle') { $('math').hidden = false; $('pop-channels').hidden = true; $('btn-channels').setAttribute('aria-expanded', 'false'); $('math-name').focus(); }
  });
  $('pop-channels').addEventListener('change', e => {
    const c = e.target.closest('[data-ch]'); if (!c) return;
    const on = new Set(S.channels); c.checked ? on.add(c.dataset.ch) : on.delete(c.dataset.ch);
    S.channels = allChannelKeys().filter(k => on.has(k));
    saveChannels(); updateCursor();
  });
  document.addEventListener('click', () => { if (!$('pop-channels').hidden) { $('pop-channels').hidden = true; $('btn-channels').setAttribute('aria-expanded', 'false'); } });
  $('math-save').addEventListener('click', saveMath);
  $('math-expr').addEventListener('keydown', e => { if (e.key === 'Enter') saveMath(); });
  $('math-list').addEventListener('click', async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    S.math.splice(+b.dataset.del, 1); await store.set('math', S.math);
    clearMathCache(); renderChannelControls(); updateCursor(); renderTab();
  });
  $('x-dist').addEventListener('click', () => setXMode('dist'));
  $('x-time').addEventListener('click', () => setXMode('time'));
  $('zoom-reset').addEventListener('click', () => { S.range = null; fitRange(); updateCursor(); });

  $('tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('map-color').addEventListener('change', () => { if ($('map-color').value !== 'rpm') S.rpmBand = null; renderRamp(); queueMap(); });
  $('rpm-bw').addEventListener('change', () => { S.rpmBand = null; renderRamp(); drawRpmHist(); queueMap(); });
  $('rpm-scope').addEventListener('change', drawRpmHist);
  $('rpm-hist').addEventListener('click', e => {
    const y = e.clientY - $('rpm-hist').getBoundingClientRect().top;
    const bar = rpmBars.find(b => y >= b.y0 && y < b.y1);
    S.rpmBand = bar && S.rpmBand !== bar.band ? bar.band : null;
    $('map-color').value = 'rpm'; renderRamp(); drawRpmHist(); queueMap();
  });
  $('event-table').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr && tr.dataset.id !== S.current) openSession(tr.dataset.id).then(renderTab); });
  $('event-cmp').addEventListener('click', compareEventBests);
  $('mm-table').addEventListener('click', e => { const c = e.target.closest('td.pick'); if (c) pickMarker(+c.dataset.k, +c.dataset.i, c.dataset.label); });
  for (const id of ['ses-ch1', 'ses-ch2']) $(id).addEventListener('change', () => { try { localStorage.setItem(id, $(id).value); } catch {} drawSession(); });
  $('ses-chart').addEventListener('click', e => {
    const x = e.clientX - $('ses-chart').getBoundingClientRect().left;
    const b = sesBands.find(b => x >= b.x0 && x < b.x1); if (b) toggleLap(S.current, b.n);
  });

  $('step-back').addEventListener('click', () => stepBy(-0.1));
  $('step-fwd').addEventListener('click', () => stepBy(0.1));
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, video') || !L.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); stepBy(e.key === 'ArrowLeft' ? -0.1 : 0.1); }
    else if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); play.running ? stopPlay() : startPlay(); }
  });
  $('play').addEventListener('click', () => (play.running ? stopPlay() : startPlay()));
  $('scrub').addEventListener('input', e => { if (L.length) { stopPlay(); setPlayT(+e.target.value / 1000 * maxT()); } });

  $('videos').addEventListener('change', e => {
    const inp = e.target.closest('input[type=file][data-sid]'); if (!inp || !inp.files[0]) return;
    const sid = inp.dataset.sid;
    if (vid.urls[sid]) URL.revokeObjectURL(vid.urls[sid]);
    vid.urls[sid] = URL.createObjectURL(inp.files[0]);
    renderVideos();
  });
  $('videos').addEventListener('click', async e => {
    const b = e.target.closest('[data-sync]'); if (!b) return;
    const v = vid.els.get(b.dataset.sync); if (!v) return;
    const [sid, n] = b.dataset.sync.split(':');
    S.videoSync[sid] = { lap: +n, vt: v.currentTime };
    await store.set('videoSync', S.videoSync);
    stopPlay(); play.t = 0; renderVideos(); syncVideos(0, true); updateCursor();
    toast(`Video synchronisiert: Start Runde ${n}`);
  });

  $('setup-form').addEventListener('input', onSetupInput);
  $('setup-form').addEventListener('submit', e => e.preventDefault());

  const chart = $('chart');
  // Mouse: hover moves the cursor, dragging a range zooms. Touch (iPad): tap or swipe sideways moves the
  // cursor (the page still scrolls vertically); zoom with the + / − buttons or two fingers.
  const chartPts = new Map();
  let pinch0 = null;
  const zoomChart = (f, center) => {
    const full = xEnd(), [a, b] = S.range || [0, full];
    const c = center ?? S.cx ?? (a + b) / 2, w = Math.max(full * 0.02, Math.min(full, (b - a) / f));
    if (w >= full * 0.999) { S.range = null; fitRange(); updateCursor(); return; }
    let lo = c - (c - a) / (b - a) * w; lo = Math.max(0, Math.min(full - w, lo));
    S.range = [lo, lo + w]; fitRange(); updateCursor();
  };
  chart.addEventListener('pointermove', e => {
    if (chartPts.has(e.pointerId)) chartPts.set(e.pointerId, e.clientX);
    if (pinch0 && chartPts.size === 2) {
      const [x1, x2] = [...chartPts.values()], d = Math.abs(x1 - x2);
      if (d > 20 && Math.abs(d / pinch0.d - 1) > 0.04) { zoomChart(d / pinch0.d, pinch0.v); pinch0 = { ...pinch0, d }; }
      return;
    }
    if (play.running) return;
    const p = chartX(e); if (!p) return;
    play.t = null;
    S.cx = Math.max(chartLayout.x0, Math.min(chartLayout.x1, p.v));
    if (dragStart != null) dragNow = p.x;
    updateCursor();
  });
  chart.addEventListener('pointerdown', e => {
    const p = chartX(e); if (!p) return;
    if (e.pointerType !== 'mouse') {
      chartPts.set(e.pointerId, e.clientX);
      if (chartPts.size === 2) {
        const [x1, x2] = [...chartPts.values()], C = chartLayout;
        const mid = (x1 + x2) / 2 - chart.getBoundingClientRect().left;
        pinch0 = { d: Math.max(20, Math.abs(x1 - x2)), v: C.x0 + (mid - C.left) / (C.w - C.left - C.right) * (C.x1 - C.x0) };
      } else if (!play.running) { play.t = null; S.cx = Math.max(chartLayout.x0, Math.min(chartLayout.x1, p.v)); updateCursor(); }
      return;
    }
    dragStart = p.x; dragNow = p.x; chart.setPointerCapture(e.pointerId);
  });
  const chartUp = e => {
    if (chartPts.delete(e.pointerId) || e.pointerType !== 'mouse') { if (chartPts.size < 2) pinch0 = null; return; }
    const p = chartX(e);
    if (p && dragStart != null && Math.abs(p.x - dragStart) > 12) {
      const C = chartLayout, toV = x => C.x0 + (x - C.left) / (C.w - C.left - C.right) * (C.x1 - C.x0);
      const a = toV(Math.min(dragStart, p.x)), b = toV(Math.max(dragStart, p.x));
      S.range = [Math.max(0, a), Math.min(xEnd(), b)];
      fitRange();
    }
    dragStart = dragNow = null; updateCursor();
  };
  chart.addEventListener('pointerup', chartUp);
  chart.addEventListener('pointercancel', e => { chartPts.delete(e.pointerId); pinch0 = null; dragStart = dragNow = null; });
  chart.addEventListener('dblclick', () => { S.range = null; fitRange(); updateCursor(); });
  $('zoom-in-x').addEventListener('click', () => zoomChart(2));
  $('zoom-out-x').addEventListener('click', () => zoomChart(0.5));

  const map = $('map');
  let pan = null;
  const mapPts = new Map();
  let mapPinch = null;
  const cursorAt = (x, y) => {
    let bi = 0, bd = Infinity;
    mapProj.pa.forEach(([px, py], i) => { const d = (px - x) ** 2 + (py - y) ** 2; if (d < bd) { bd = d; bi = i; } });
    return { bi, bd };
  };
  map.addEventListener('pointerdown', e => {
    mapPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mapPts.size === 2 && view) {
      const [a, b] = [...mapPts.values()];
      mapPinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; pan = null; return;
    }
    pan = { x: e.clientX, y: e.clientY, cx: view && view.cx, cy: view && view.cy, moved: false, touch: e.pointerType !== 'mouse' };
    map.setPointerCapture(e.pointerId);
  });
  map.addEventListener('pointermove', e => {
    if (mapPts.has(e.pointerId)) mapPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mapPinch && mapPts.size === 2 && view) {
      const [a, b] = [...mapPts.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, r = map.getBoundingClientRect();
      zoomAt(d / mapPinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); mapPinch.d = d; return;
    }
    if (!mapProj || !L.length || !view) return;
    if (pan) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (pan.moved || Math.abs(dx) + Math.abs(dy) > 4) {
        pan.moved = true; map.classList.add('panning');
        view.cx = pan.cx - dx / view.s; view.cy = pan.cy - dy / view.s; queueMap();
        return;
      }
    }
    if (play.running || e.pointerType !== 'mouse') return;
    const r = map.getBoundingClientRect();
    const { bi, bd } = cursorAt(e.clientX - r.left, e.clientY - r.top);
    play.t = null;
    S.cx = bd < 900 ? xs(L[0])[bi] : null;
    updateCursor();
  });
  const endPan = e => {
    mapPts.delete(e.pointerId); if (mapPts.size < 2) mapPinch = null;
    // a tap on the track (touch) puts the cursor there
    if (pan && pan.touch && !pan.moved && mapProj && L.length && !play.running) {
      const r = map.getBoundingClientRect(), { bi, bd } = cursorAt(e.clientX - r.left, e.clientY - r.top);
      if (bd < 1600) { play.t = null; S.cx = xs(L[0])[bi]; updateCursor(); }
    }
    pan = null; map.classList.remove('panning');
  };
  map.addEventListener('pointerup', endPan);
  map.addEventListener('pointercancel', endPan);
  map.addEventListener('wheel', e => {
    if (!view) return;
    e.preventDefault();
    const r = map.getBoundingClientRect();
    zoomAt(Math.pow(1.0018, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  map.addEventListener('dblclick', e => { const r = map.getBoundingClientRect(); zoomAt(2, e.clientX - r.left, e.clientY - r.top); });
  $('z-in').addEventListener('click', () => view && zoomAt(1.6));
  $('z-out').addEventListener('click', () => view && zoomAt(1 / 1.6));
  $('z-fit').addEventListener('click', () => { fitRange(); queueMap(); });
  const setMode = m => {
    sat.mode = m;
    $('mv-sat').setAttribute('aria-pressed', String(m === 'sat')); $('mv-plan').setAttribute('aria-pressed', String(m === 'plan'));
    try { localStorage.setItem('mapMode', m); } catch {}
    queueMap();
  };
  $('mv-sat').addEventListener('click', () => setMode('sat'));
  $('mv-plan').addEventListener('click', () => setMode('plan'));
  try { if (localStorage.getItem('mapMode') === 'plan') setMode('plan'); } catch {}

  // Drag & Drop
  let depth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; $('drop').hidden = true;
    const files = [...(e.dataTransfer?.files || [])].filter(f => /\.(alf2|zip)$/i.test(f.name));
    if (files.length) importFiles(files); else toast('Bitte .alf2-Dateien ablegen');
  });

  let rq = false;
  const redraw = () => { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; updateCursor(); if (activeTab !== 'video' && activeTab !== 'setup') renderTab(); }); };
  if (window.ResizeObserver) new ResizeObserver(redraw).observe($('detail'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ---------- Start ---------- */

async function start() {
  if (!('DecompressionStream' in window)) {
    $('empty').innerHTML = '<h2>Browser zu alt</h2><p>Bitte aktuelles Chrome, Edge, Firefox oder Safari (ab 16.4) verwenden.</p>';
    return;
  }
  bind();
  wireFullscreen();
  S.driverMap = await store.get('driverMap', {});
  S.overrides = await store.get('overrides', {});
  S.math = await store.get('math', []);
  S.setup = await store.get('setup', {});
  S.favs = await store.get('favs', {});
  S.videoSync = await store.get('videoSync', {});
  S.channels = await store.get('channels', S.channels);
  renderChannelControls();
  try {
    const x = localStorage.getItem('xMode'); if (x === 'time') { S.xMode = 'time'; $('x-dist').setAttribute('aria-pressed', 'false'); $('x-time').setAttribute('aria-pressed', 'true'); }
    for (const [id, d] of [['ses-ch1', 'T1'], ['ses-ch2', 'T2']]) $(id).value = localStorage.getItem(id) || d;
    const t = localStorage.getItem('tab'); if (t && $('tab-' + t)) showTab(t);
  } catch { $('ses-ch1').value = 'T1'; $('ses-ch2').value = 'T2'; }
  renderRamp();
  const files = await store.allFiles();
  for (const f of files) {
    try { S.sessions.push(await parseSummary(f.name, f.buf)); } catch (e) { console.error(e); }
  }
  sortSessions();
  renderFilters(); renderLibrary(); renderBanner();
  if (S.sessions.length) await openSession(S.sessions[0].id);
  else if (location.protocol !== 'file:') await loadSamples();
}
start();
})();
