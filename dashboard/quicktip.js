/* QuickTips: one tooltip system for mouse and touch, shared by Boxenmauer and Telemetrie.
   - Mouse / trackpad: hover an element for a moment and the tip appears.
   - iPad / touch: press and hold (about half a second); the tap's action is then not triggered.
   - Help mode (the "?" button in the top bar): every tap shows the tip instead of acting.
   Tips come from data-tip, title (moved to data-tip so the browser's own slow tooltip does not double up)
   or aria-label, plus per-app lookups: window.QT_TIPS = [[cssSelector, text], …] and
   window.QT_TEXT = { 'Button label': 'tip', … } for elements without own text. */
(function () {
  'use strict';
  const HOVER_DELAY = 380, HOLD = 480, MOVE_TOL = 10;
  const css = `
  .qt-tip { position: fixed; z-index: 100000; max-width: min(320px, calc(100vw - 24px)); padding: 8px 12px 8px 14px; border-radius: 6px;
    background: var(--band, #0c0f13); color: var(--band-fg, #e9edf2); font: 500 13px/1.4 var(--font-body, system-ui, sans-serif);
    box-shadow: 0 6px 24px rgba(0,0,0,.35); border-left: 3px solid var(--accent, #d81f26); pointer-events: none;
    opacity: 0; transform: translateY(4px); transition: opacity .12s ease, transform .12s ease; text-wrap: pretty; }
  .qt-tip.on { opacity: 1; transform: none; }
  .qt-tip b { display: block; font: italic 700 13px/1.2 var(--font-display, sans-serif); letter-spacing: .03em; text-transform: uppercase; color: #fff; margin-bottom: 2px; }
  .qt-tip kbd { font: 11px var(--font-data, monospace); border: 1px solid #556; border-radius: 3px; padding: 0 4px; }
  [data-tip] { -webkit-touch-callout: none; }
  button[data-tip], label[data-tip], select[data-tip], a[data-tip] { -webkit-user-select: none; user-select: none; }
  html.qt-help [data-tip] { outline: 1.5px dashed color-mix(in srgb, var(--accent, #d81f26) 75%, transparent); outline-offset: -2px; cursor: help; }
  a.btn { text-decoration: none; color: inherit; }
  .qt-help-btn { font-weight: 700; min-width: 40px; }
  .qt-help-btn[aria-pressed="true"] { background: var(--accent, #d81f26); border-color: var(--accent, #d81f26); color: #fff; }
  @media (prefers-reduced-motion: reduce) { .qt-tip { transition: none; } }`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const tip = document.createElement('div'); tip.className = 'qt-tip'; tip.setAttribute('role', 'tooltip');
  let tipFor = null, hideTimer = null, hoverTimer = null, holdTimer = null, holdStart = null, swallowClick = false;
  const helpOn = () => document.documentElement.classList.contains('qt-help');

  const SKIP = 'iframe, .leaflet-tile, .leaflet-marker-icon, canvas.no-tip, [data-no-tip]';
  function harvest(el) {
    if (el.nodeType !== 1 || el.matches(SKIP)) return;
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      el.removeAttribute('title');
      if (t) el.dataset.tip = (window.QT_TITLE_MAP || {})[t] || t;
    }
  }
  function lookup(el) {
    if (el.dataset.tip) return el.dataset.tip;
    for (const [sel, text, mode] of window.QT_TIPS || []) {
      try {
        if (!el.matches(sel)) continue;
        if (mode === 'help') el.dataset.tipHelp = '1'; // big work areas (charts, maps): only in help mode, never on hover
        return (el.dataset.tip = typeof text === 'function' ? text(el) : text);
      } catch { /* bad selector */ }
    }
    if (el.matches('button, a, label.btn, .chip, select, [role=button]')) {
      const label = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const t = (window.QT_TEXT || {})[label] || (window.QT_TEXT || {})[el.getAttribute('aria-label') || ''];
      if (t) return (el.dataset.tip = t);
      if (el.getAttribute('aria-label') && !label) return (el.dataset.tip = el.getAttribute('aria-label'));
    }
    return '';
  }
  // the nearest element (from the event target up) that has a tip
  function target(node) {
    for (let el = node; el && el !== document.body && el.nodeType === 1; el = el.parentElement) {
      if (el.matches(SKIP)) return null;
      harvest(el);
      const t = lookup(el);
      if (t) return { el, text: t };
    }
    return null;
  }
  function show(el, text) {
    clearTimeout(hideTimer);
    tipFor = el;
    const parts = String(text).split('\n');
    tip.replaceChildren();
    if (parts.length > 1) { const b = document.createElement('b'); b.textContent = parts.shift(); tip.append(b); }
    tip.append(document.createTextNode(parts.join(' ')));
    if (!tip.isConnected) document.body.appendChild(tip);
    // dialogs open with showModal() sit in the top layer: the tip must live inside them to be visible
    const dlg = el.closest('dialog[open]');
    if (dlg && tip.parentElement !== dlg) dlg.appendChild(tip); else if (!dlg && tip.parentElement !== document.body) document.body.appendChild(tip);
    tip.classList.remove('on');
    tip.style.left = '0px'; tip.style.top = '0px';
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, m = 10;
    let top = r.bottom + 8;
    if (top + t.height > vh - m) top = r.top - t.height - 8;
    if (top < m) top = Math.min(vh - t.height - m, r.bottom + 8);
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(m, Math.min(vw - t.width - m, left));
    tip.style.left = `${Math.round(left)}px`; tip.style.top = `${Math.round(top)}px`;
    requestAnimationFrame(() => tip.classList.add('on'));
  }
  function hide(delay = 0) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { tip.classList.remove('on'); tipFor = null; }, delay);
  }

  // Mouse / trackpad hover
  document.addEventListener('pointerover', ev => {
    if (ev.pointerType !== 'mouse') return;
    const hit = target(ev.target);
    clearTimeout(hoverTimer);
    if (!hit || hit.el.dataset.tipHelp) { if (tipFor && !tipFor.contains(ev.target) && !helpOn()) hide(); return; }
    if (hit.el === tipFor) return;
    hoverTimer = setTimeout(() => show(hit.el, hit.text), tipFor ? 60 : HOVER_DELAY);
  }, true);
  document.addEventListener('pointerout', ev => {
    if (ev.pointerType !== 'mouse') return;
    if (tipFor && (!ev.relatedTarget || !tipFor.contains(ev.relatedTarget))) { clearTimeout(hoverTimer); hide(60); }
  }, true);
  document.addEventListener('pointerdown', ev => {
    clearTimeout(hoverTimer);
    if (ev.pointerType === 'mouse') { if (!helpOn()) hide(); return; }
    // Touch: press and hold shows the tip
    if (tipFor && !helpOn()) hide();
    const hit = target(ev.target);
    if (!hit || hit.el.dataset.tipHelp || helpOn()) return;
    holdStart = { x: ev.clientX, y: ev.clientY, el: hit.el };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      show(hit.el, hit.text); swallowClick = true; holdStart = null;
      try { navigator.vibrate?.(10); } catch { /* not supported */ }
      hide(4500);
    }, HOLD);
  }, true);
  const cancelHold = ev => {
    if (!holdStart) return;
    if (ev.type === 'pointermove' && Math.hypot(ev.clientX - holdStart.x, ev.clientY - holdStart.y) < MOVE_TOL) return;
    clearTimeout(holdTimer); holdStart = null;
  };
  document.addEventListener('pointermove', cancelHold, true);
  document.addEventListener('pointerup', cancelHold, true);
  document.addEventListener('pointercancel', cancelHold, true);
  document.addEventListener('scroll', () => { clearTimeout(holdTimer); holdStart = null; if (tipFor && !helpOn()) hide(); }, true);
  document.addEventListener('contextmenu', ev => { if (swallowClick || (holdStart && target(ev.target))) ev.preventDefault(); }, true);
  // After a long press, or in help mode, the tap shows the tip instead of acting.
  document.addEventListener('click', ev => {
    if (swallowClick) { swallowClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
    if (!helpOn() || ev.target.closest('.qt-help-btn')) return;
    const hit = target(ev.target);
    ev.preventDefault(); ev.stopPropagation();
    if (hit) show(hit.el, hit.text); else hide();
  }, true);
  // Inputs and selects react on focus/change before click: block those in help mode too.
  document.addEventListener('focusin', ev => {
    if (!helpOn() || !ev.target.matches('input, select, textarea')) return;
    const hit = target(ev.target); ev.target.blur(); if (hit) show(hit.el, hit.text);
  }, true);
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { hide(); if (helpOn()) setHelp(false); }
  });

  // mark everything that has a tip, so help mode can outline it
  function scanAll() {
    document.querySelectorAll('[title]').forEach(harvest);
    for (const [sel] of window.QT_TIPS || []) { try { document.querySelectorAll(sel).forEach(lookup); } catch { /* bad selector */ } }
    document.querySelectorAll('button, a, label.btn, .chip, select, [role=button]').forEach(lookup);
  }
  function setHelp(on) {
    if (on) scanAll();
    document.documentElement.classList.toggle('qt-help', on);
    document.querySelectorAll('.qt-help-btn').forEach(b => b.setAttribute('aria-pressed', String(on)));
    hide();
  }
  window.QuickTip = { show, hide, setHelp, toggleHelp: () => setHelp(!helpOn()), refresh: () => document.querySelectorAll('[title]').forEach(harvest) };

  // Move title attributes over as soon as elements appear, so the browser never shows its own tooltip.
  const mo = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') { harvest(m.target); continue; }
      for (const n of m.addedNodes) if (n.nodeType === 1) { harvest(n); n.querySelectorAll?.('[title]').forEach(harvest); }
    }
    if (tipFor && !tipFor.isConnected) hide();
    if (helpOn()) { clearTimeout(scanTimer); scanTimer = setTimeout(scanAll, 120); }
  });
  let scanTimer = null;
  const start = () => {
    // the link to the other app only works where both apps are served side by side (online version)
    if (location.protocol === 'file:') document.querySelectorAll('.app-link').forEach(a => { a.hidden = true; });
    document.querySelectorAll('[title]').forEach(harvest);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
    document.querySelectorAll('.qt-help-btn').forEach(b => b.addEventListener('click', () => setHelp(!helpOn())));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
