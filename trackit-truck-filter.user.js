// ==UserScript==
// @name         TrackIt Truck Filter & Idle Alert
// @namespace    https://github.com/written-ink/hbm
// @version      1.1.0
// @description  Show only your trucks on the Command Alkon TrackIt dispatch map, and play an alert when one of them goes idle (returning to base).
// @match        https://trackit-eu.commandalkon.io/dispatch/*
// @match        https://*.commandalkon.io/dispatch/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it finds trucks (no knowledge of the page's internals needed):
 *   1. Map markers: hooks Google Maps (google.maps.Marker / AdvancedMarkerElement)
 *      and Leaflet (L.Marker). The truck number and status are read from the
 *      marker's title, label, tooltip and icon URL. Hidden trucks are removed from the map.
 *   2. Data feed: watches the page's fetch/XHR responses (JSON or XML) for
 *      records that have a truck id and a status field.
 *   3. Lists (optional): "Pick truck row" in Settings lets you click a truck row in
 *      any on-page list; matching rows are then filtered and read for status too.
 *
 * An idle alert fires when a truck's status changes from something else to a status
 * matching the "Idle pattern" (default: "idle").
 */
(function () {
  'use strict';
  const W = window;
  if (W.__tkf) return;

  // ---------------------------------------------------------------- settings
  const KEY = 'tkf.settings.v1';
  const DEFAULTS = {
    myTrucks: [],          // truck ids the user owns
    filterOn: true,        // show only my trucks
    soundOn: true,
    desktopOn: false,
    beeps: 3,              // how many times the chime repeats
    alertScope: 'mine',    // 'mine' | 'all'
    idlePattern: 'idle',   // regex (case-insensitive) matched against the status
    idPattern: '',         // optional regex; first capture group (or whole match) = truck id
    rowSelector: '',       // optional CSS selector for truck rows in on-page lists
    cooldownSec: 120,      // minimum gap between alerts for the same truck
    panel: { x: null, y: 80, collapsed: false },
  };
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  const S = loadSettings();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage blocked */ } }

  const mine = () => new Set(S.myTrucks.map(normId));
  function normId(id) { return String(id).trim().toUpperCase(); }
  function safeRe(src, fallback) { try { return new RegExp(src, 'i'); } catch (e) { return fallback; } }
  const idleRe = () => safeRe(S.idlePattern || 'idle', /idle/i);

  // ---------------------------------------------------------------- registry
  // id -> { id, status: {marker, net, dom}, eff, prevEff, since, markers:Set, rows:Set, lastSeen, lastAlert }
  const trucks = new Map();
  const log = [];          // idle events
  const diag = { net: [], markers: [], rows: [], sources: new Set() };

  function truck(id) {
    id = normId(id);
    let t = trucks.get(id);
    if (!t) {
      t = { id, status: {}, eff: null, prevEff: null, since: Date.now(), markers: new Set(), rows: new Set(), lastSeen: 0, lastAlert: 0 };
      trucks.set(id, t);
      scheduleRender();
    }
    t.lastSeen = Date.now();
    return t;
  }

  function isShown(id) {
    if (!S.filterOn) return true;
    const m = mine();
    return m.size === 0 || m.has(normId(id));
  }

  function setStatus(t, source, value) {
    if (value == null || value === '') return;
    value = String(value).trim();
    t.status[source] = value;
    const eff = t.status.net || t.status.marker || t.status.dom || null;
    if (eff === t.eff) return;
    const prev = t.eff;
    t.prevEff = prev;
    t.eff = eff;
    t.since = Date.now();
    scheduleRender();
    const re = idleRe();
    if (prev != null && re.test(eff) && !re.test(prev)) onIdle(t, prev);
  }

  // ---------------------------------------------------------------- text helpers
  const STATUS_WORDS = [
    'out of service', 'returning', 'return', 'to plant', 'to job', 'on job', 'at job', 'at plant',
    'in yard', 'pouring', 'unloading', 'loading', 'loaded', 'washing', 'wash', 'idle', 'available',
    'break', 'en route', 'enroute', 'begin pour', 'end pour', 'ticketed', 'off duty', 'on duty',
  ];
  function statusFromText(txt) {
    if (!txt) return null;
    const s = String(txt).toLowerCase();
    // user idle pattern first, so custom words ("leeg", "inactief", a colour name) are recognised
    const m = s.match(idleRe());
    if (m) return m[0];
    for (const w of STATUS_WORDS) if (s.includes(w)) return w;
    return null;
  }
  function idFromText(txt) {
    if (!txt) return null;
    txt = String(txt);
    if (S.idPattern) {
      const re = safeRe(S.idPattern, null);
      const m = re && txt.match(re);
      if (m) return m[1] || m[0];
      return null;
    }
    // "Truck 123", "Trk: 45A", "#123", or the first alphanumeric token containing a digit
    let m = txt.match(/(?:truck|trk|unit|vehicle|mixer|veh|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{0,9})/i);
    if (m && /\d/.test(m[1])) return m[1];
    m = txt.match(/\b([A-Z]{0,4}-?\d{1,6}[A-Z]?)\b/i);
    return m ? m[1] : null;
  }
  function iconName(icon) {
    if (!icon) return '';
    const url = typeof icon === 'string' ? icon : (icon.url || '');
    if (!url || url.startsWith('data:')) return '';
    return decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || '');
  }
  function plain(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (v.text != null) return String(v.text);                    // google label object
    if (v.textContent != null) return v.textContent;              // DOM node
    return '';
  }
  function remember(list, item, max) { list.unshift(item); if (list.length > max) list.length = max; }

  // ---------------------------------------------------------------- markers: shared
  function registerMarker(m, info) {
    // info: { title, label, icon, extra, kind }
    const text = [info.title, info.label, info.extra].filter(Boolean).join(' | ');
    const iname = iconName(info.icon);
    const id = idFromText(info.label) || idFromText(info.title) || idFromText(info.extra);
    if (!m.__tkfLogged) {
      m.__tkfLogged = true;
      remember(diag.markers, { kind: info.kind, text, icon: iname, id }, 40);
    }
    if (!id) return;
    diag.sources.add(info.kind);
    const t = truck(id);
    if (m.__tkfId && m.__tkfId !== t.id) { const o = trucks.get(m.__tkfId); o && o.markers.delete(m); }
    m.__tkfId = t.id;
    t.markers.add(m);
    // status: explicit word in text, otherwise a word in the icon file name, otherwise the icon name itself
    const st = statusFromText(text) || statusFromText(iname.replace(/[_\-.]/g, ' ')) || (iname ? 'icon:' + iname : null);
    setStatus(t, 'marker', st);
  }

  // ---------------------------------------------------------------- Google Maps
  function patchGoogle() {
    const g = W.google && W.google.maps;
    if (!g || !g.Marker) return false;
    if (g.Marker.__tkf) return true;
    const P = g.Marker.prototype;
    const origSetMap = P.setMap;
    const info = (m) => ({
      kind: 'google',
      title: m.getTitle && m.getTitle(),
      label: plain(m.getLabel && m.getLabel()),
      icon: m.getIcon && m.getIcon(),
    });
    // Markers created before we patched get adopted the next time the app touches them.
    const adopt = (m) => {
      if (m.__tkfApply) return;
      if (m.__tkfMap === undefined) m.__tkfMap = m.get('map');
      m.__tkfApply = (show) => origSetMap.call(m, show ? m.__tkfMap : null);
    };
    P.setMap = function (map) {
      this.__tkfMap = map;
      adopt(this);
      try { registerMarker(this, info(this)); } catch (e) { /* never break the page */ }
      const hide = map && this.__tkfId && !isShown(this.__tkfId);
      return origSetMap.call(this, hide ? null : map);
    };
    P.getMap = function () { return this.__tkfMap !== undefined ? this.__tkfMap : this.get('map'); };
    ['setTitle', 'setLabel', 'setIcon', 'setPosition', 'setOptions', 'setValues'].forEach((fn) => {
      const o = P[fn];
      if (!o) return;
      P[fn] = function () {
        const r = o.apply(this, arguments);
        try {
          const had = this.__tkfId, fresh = !this.__tkfApply;
          adopt(this);
          registerMarker(this, info(this));
          // a marker that just revealed its id, was just adopted, or had options reset: re-apply visibility
          if (this.__tkfId && (fresh || had !== this.__tkfId || fn === 'setValues' || fn === 'setOptions')) {
            this.__tkfApply(isShown(this.__tkfId));
          }
        } catch (e) { /* ignore */ }
        return r;
      };
    });
    g.Marker.__tkf = true;

    // Newer Advanced Markers
    const A = g.marker && g.marker.AdvancedMarkerElement;
    if (A && !A.__tkf) {
      const d = findDesc(A.prototype, 'map');
      if (d && d.set) {
        Object.defineProperty(A.prototype, 'map', {
          configurable: true,
          get() { return this.__tkfMap !== undefined ? this.__tkfMap : d.get.call(this); },
          set(map) {
            this.__tkfMap = map;
            this.__tkfApply = (show) => d.set.call(this, show ? this.__tkfMap : null);
            try {
              registerMarker(this, { kind: 'google-adv', title: this.title, extra: plain(this.content) });
            } catch (e) { /* ignore */ }
            d.set.call(this, map && this.__tkfId && !isShown(this.__tkfId) ? null : map);
          },
        });
      }
      A.__tkf = true;
    }
    return true;
  }
  function findDesc(o, k) {
    while (o) { const d = Object.getOwnPropertyDescriptor(o, k); if (d) return d; o = Object.getPrototypeOf(o); }
    return null;
  }

  // ---------------------------------------------------------------- Leaflet
  function patchLeaflet() {
    const L = W.L;
    if (!L || !L.Marker || !L.Marker.prototype || !L.version) return false;
    if (L.Marker.__tkf) return true;
    const P = L.Marker.prototype;
    const info = (m) => {
      const tip = m.getTooltip && m.getTooltip();
      const pop = m.getPopup && m.getPopup();
      const io = (m.options.icon && m.options.icon.options) || {};
      return {
        kind: 'leaflet',
        title: m.options.title || m.options.alt,
        label: plain(tip && tip.getContent && tip.getContent()),
        extra: [plain(io.html), plain(pop && pop.getContent && pop.getContent())].join(' ').replace(/<[^>]+>/g, ' '),
        icon: io.iconUrl,
      };
    };
    const vis = (m) => {
      m.__tkfApply = (show) => {
        [m._icon, m._shadow].forEach((el) => { if (el) el.style.display = show ? '' : 'none'; });
      };
      if (m.__tkfId) m.__tkfApply(isShown(m.__tkfId));
    };
    ['onAdd', 'setIcon', 'bindTooltip', 'setTooltipContent', 'setLatLng', 'update'].forEach((fn) => {
      const o = P[fn];
      if (!o) return;
      P[fn] = function () {
        const r = o.apply(this, arguments);
        try { registerMarker(this, info(this)); vis(this); } catch (e) { /* ignore */ }
        return r;
      };
    });
    L.Marker.__tkf = true;
    return true;
  }

  // Map libraries load after us (document-start), so poll until both are patched or 60s pass.
  let polls = 0;
  const pollTimer = setInterval(() => {
    let g = false, l = false;
    try { g = patchGoogle(); } catch (e) { /* ignore */ }
    try { l = patchLeaflet(); } catch (e) { /* ignore */ }
    if ((g && l) || ++polls > 1200) clearInterval(pollTimer);
  }, 50);

  // ---------------------------------------------------------------- network feed
  const ID_KEY = /^(truck|trk|vehicle|veh|unit|mixer)[\s_-]*(id|no|num|number|code|name|nr)?$|^(truckid|truckno|trucknumber|truckcode|vehicleid|vehicleno|unitid|unitno|unitcode|name|code|id)$/i;
  const STATUS_KEY = /status|state|activity|condition/i;
  const PREFERRED_ID = /truck|trk|vehicle|veh|unit|mixer/i;

  function pickRecord(obj) {
    const keys = Object.keys(obj);
    const idKeys = keys.filter((k) => ID_KEY.test(k) && ['string', 'number'].includes(typeof obj[k]));
    if (!idKeys.length) return null;
    const idKey = idKeys.find((k) => PREFERRED_ID.test(k)) || idKeys[0];
    const stKey = keys.find((k) => STATUS_KEY.test(k) && ['string', 'number'].includes(typeof obj[k]) && !/id$|code$/i.test(k))
      || keys.find((k) => STATUS_KEY.test(k) && ['string', 'number'].includes(typeof obj[k]));
    if (!stKey) return null;
    // Generic "id"/"name" only counts when the record looks like a truck (has a truck-ish key or position)
    if (!PREFERRED_ID.test(idKey) && !keys.some((k) => /lat|lon|lng|truck|vehicle|position/i.test(k))) return null;
    return { id: obj[idKey], status: obj[stKey], idKey, stKey };
  }

  function walkJson(node, out, depth) {
    if (!node || depth > 8 || out.length > 5000) return;
    if (Array.isArray(node)) { node.forEach((n) => walkJson(n, out, depth + 1)); return; }
    if (typeof node !== 'object') return;
    const r = pickRecord(node);
    if (r) out.push(r);
    for (const k in node) if (node[k] && typeof node[k] === 'object') walkJson(node[k], out, depth + 1);
  }

  function walkXml(doc, out) {
    const els = doc.getElementsByTagName('*');
    for (let i = 0; i < els.length && out.length < 5000; i++) {
      const el = els[i];
      const obj = {};
      for (const a of el.attributes) obj[a.name] = a.value;
      for (const c of el.children) if (!c.children.length) obj[c.tagName] = c.textContent;
      if (Object.keys(obj).length < 2) continue;
      const hint = PREFERRED_ID.test(el.tagName) ? { truck: '' } : {};
      const r = pickRecord(Object.assign(hint, obj));
      if (r && r.id !== '') out.push(r);
    }
  }

  function handlePayload(url, text) {
    if (!text || typeof text !== 'string' || text.length > 8e6) return;
    const head = text.trimStart().slice(0, 1);
    const out = [];
    try {
      if (head === '{' || head === '[') walkJson(JSON.parse(text), out, 0);
      else if (head === '<' && !/^<!doctype html|^<html/i.test(text.trimStart())) {
        walkXml(new DOMParser().parseFromString(text, 'text/xml'), out);
      } else return;
    } catch (e) { return; }
    remember(diag.net, { url: String(url).slice(0, 200), records: out.length, sample: text.slice(0, 1500),
      keys: out[0] ? out[0].idKey + ' / ' + out[0].stKey : '' }, 8);
    if (!out.length) return;
    diag.sources.add('network');
    out.forEach((r) => setStatus(truck(r.id), 'net', r.status));
  }

  if (W.fetch) {
    const of = W.fetch;
    W.fetch = function () {
      const p = of.apply(this, arguments);
      const url = arguments[0] && (arguments[0].url || arguments[0]);
      p.then((res) => {
        try {
          const ct = res.headers.get('content-type') || '';
          if (/json|xml|text\/plain|javascript/i.test(ct)) res.clone().text().then((t) => handlePayload(url, t)).catch(() => {});
        } catch (e) { /* ignore */ }
      }).catch(() => {});
      return p;
    };
  }
  if (W.XMLHttpRequest) {
    const XP = W.XMLHttpRequest.prototype;
    const oOpen = XP.open, oSend = XP.send;
    XP.open = function (m, url) { this.__tkfUrl = url; return oOpen.apply(this, arguments); };
    XP.send = function () {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') handlePayload(this.__tkfUrl, this.responseText);
          else if (this.responseType === 'json') handlePayload(this.__tkfUrl, JSON.stringify(this.response));
          else if (this.responseType === 'document' && this.responseXML) {
            handlePayload(this.__tkfUrl, new XMLSerializer().serializeToString(this.responseXML));
          }
        } catch (e) { /* ignore */ }
      });
      return oSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------- on-page lists (optional)
  function textOf(node) {
    // join text nodes with spaces so adjacent cells ("101" + "To Job") don't merge
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (w.nextNode()) parts.push(w.currentNode.nodeValue);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  function scanRows() {
    if (!S.rowSelector || !document.body) return;
    let rows;
    try { rows = document.querySelectorAll(S.rowSelector); } catch (e) { return; }
    rows.forEach((row) => {
      if (host && host.contains(row)) return;
      const txt = textOf(row);
      const id = idFromText(txt);
      if (!id) return;
      diag.sources.add('list');
      const t = truck(id);
      t.rows.add(row);
      row.__tkfId = t.id;
      const st = statusFromText(txt) || statusFromText(row.getAttribute('title')) || statusFromText(row.className);
      setStatus(t, 'dom', st);
      row.style.display = isShown(t.id) ? '' : 'none';
      if (diag.rows.length < 20 && !row.__tkfLogged) { row.__tkfLogged = true; remember(diag.rows, { text: txt.slice(0, 150), id, st }, 20); }
    });
  }
  setInterval(scanRows, 2000);
  // Lists are often rebuilt on every refresh; filter new rows before they are painted.
  let scanQueued = false;
  new MutationObserver((muts) => {
    if (!S.rowSelector || scanQueued) return;
    if (muts.every((m) => host && host.contains(m.target))) return;
    scanQueued = true;
    queueMicrotask(() => { scanQueued = false; scanRows(); });
  }).observe(document, { childList: true, subtree: true });

  // ---------------------------------------------------------------- apply filter
  function applyFilter() {
    trucks.forEach((t) => {
      const show = isShown(t.id);
      t.markers.forEach((m) => { try { m.__tkfApply && m.__tkfApply(show); } catch (e) { /* ignore */ } });
      t.rows.forEach((r) => { if (r.isConnected) r.style.display = show ? '' : 'none'; else t.rows.delete(r); });
    });
    scheduleRender();
  }

  // ---------------------------------------------------------------- alerts
  let actx = null;
  function audio() {
    if (!actx) { const C = W.AudioContext || W.webkitAudioContext; if (C) actx = new C(); }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  // Browsers only allow sound after a user gesture; the first click anywhere unlocks it.
  ['pointerdown', 'keydown'].forEach((ev) => W.addEventListener(ev, () => { try { audio(); } catch (e) { /* ignore */ } }, { capture: true, once: true }));

  function chime(times) {
    const ctx = audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.05;
    for (let i = 0; i < times; i++) {
      [[880, 0], [660, 0.22]].forEach(([f, dt]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const s = t0 + i * 0.8 + dt;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(s);
        o.stop(s + 0.4);
      });
    }
  }

  function onIdle(t, prev) {
    const now = Date.now();
    if (S.alertScope === 'mine') {
      const m = mine();
      if (m.size && !m.has(t.id)) return;
      if (!m.size) return; // no trucks chosen yet -> stay quiet
    }
    if (now - t.lastAlert < S.cooldownSec * 1000) return;
    t.lastAlert = now;
    remember(log, { id: t.id, prev, at: now }, 30);
    if (S.soundOn) try { chime(S.beeps); } catch (e) { /* ignore */ }
    if (S.desktopOn && W.Notification && Notification.permission === 'granted') {
      try { new Notification('Truck ' + t.id + ' is idle', { body: 'Was: ' + prev + ' — returning to base', tag: 'tkf-' + t.id }); } catch (e) { /* ignore */ }
    }
    flash = now;
    scheduleRender();
  }
  let flash = 0;

  // ---------------------------------------------------------------- panel UI
  let host = null, root = null, renderQueued = false, query = '', settingsOpen = false, diagOpen = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; render(); }, 300);
  }

  const STYLE = `
    :host { all: initial; }
    .p { position: fixed; z-index: 2147483000; width: 290px; max-height: 80vh; display: flex; flex-direction: column;
      font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1c2230; background: #fff;
      border: 1px solid #c9d0db; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); overflow: hidden; }
    .p.flash { animation: fl 1s ease-in-out 6; }
    @keyframes fl { 50% { box-shadow: 0 0 0 4px #f5a623, 0 8px 28px rgba(0,0,0,.22); } }
    .h { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #1f3a5f; color: #fff; cursor: move; user-select: none; }
    .h b { flex: 1; font-size: 13px; }
    .h button { background: transparent; border: 0; color: #fff; cursor: pointer; font-size: 14px; padding: 0 4px; }
    .b { padding: 8px 10px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
    input[type=text], input[type=number], select { font: inherit; padding: 4px 6px; border: 1px solid #c9d0db; border-radius: 6px; min-width: 0; }
    input[type=text] { flex: 1; }
    button.btn { font: inherit; padding: 4px 8px; border: 1px solid #c9d0db; background: #f3f5f8; border-radius: 6px; cursor: pointer; }
    button.btn:hover { background: #e6ebf2; }
    button.pri { background: #1f3a5f; color: #fff; border-color: #1f3a5f; }
    .list { border: 1px solid #e3e7ee; border-radius: 6px; max-height: 38vh; overflow: auto; }
    .t { display: grid; grid-template-columns: 20px 1fr auto; gap: 6px; align-items: center; padding: 4px 6px; border-bottom: 1px solid #f0f2f5; }
    .t:last-child { border-bottom: 0; }
    .t .id { font-weight: 600; }
    .t .since { color: #6b7485; font-size: 11px; }
    .st { font-size: 11px; padding: 1px 6px; border-radius: 10px; background: #e8edf4; color: #33415c; white-space: nowrap; max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
    .st.idle { background: #fde7c2; color: #7a4a00; font-weight: 600; }
    .muted { color: #6b7485; font-size: 12px; }
    .log div { font-size: 12px; padding: 2px 0; }
    details summary { cursor: pointer; font-weight: 600; }
    .grid { display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: center; margin-top: 6px; }
    textarea { width: 100%; box-sizing: border-box; height: 120px; font: 11px monospace; }
    .collapsed .b { display: none; }
  `;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'checked' || k === 'value') e[k] = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    kids.flat().forEach((k) => k != null && e.append(k.nodeType ? k : String(k)));
    return e;
  }
  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h';
  }

  function shouldShowPanel() {
    return W.__tkfForcePanel || /map\.jsp/i.test(location.pathname) || trucks.size > 0;
  }

  function mount() {
    if (host || !document.body || !shouldShowPanel()) return;
    host = el('div', { id: 'tkf-host' });
    root = host.attachShadow({ mode: 'open' });
    document.body.append(host);
    render();
  }
  setInterval(() => { mount(); }, 1000);
  setInterval(() => { if (root && !renderQueued) render(); }, 5000); // keep "since" times fresh

  function render() {
    if (!root) { mount(); return; }
    const active = root.activeElement;
    const focusKey = active && active.dataset ? active.dataset.k : null;
    const caret = active && active.selectionStart;
    const prevList = root.querySelector('.list');
    const scroll = prevList ? prevList.scrollTop : 0;

    const my = mine();
    const re = idleRe();
    const all = [...trucks.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    my.forEach((id) => { if (!trucks.has(id)) all.push({ id, eff: null, since: Date.now(), ghost: true }); });
    const q = query.trim().toUpperCase();
    const visible = all.filter((t) => !q || t.id.includes(q)).sort((a, b) => (my.has(b.id) - my.has(a.id)) || a.id.localeCompare(b.id, undefined, { numeric: true }));

    const x = S.panel.x == null ? Math.max(10, W.innerWidth - 310) : S.panel.x;
    const panel = el('div', { class: 'p' + (S.panel.collapsed ? ' collapsed' : '') + (Date.now() - flash < 6000 ? ' flash' : ''),
      style: `left:${Math.min(x, W.innerWidth - 60)}px;top:${Math.min(S.panel.y, W.innerHeight - 40)}px` });

    const idleMine = all.filter((t) => my.has(t.id) && t.eff && re.test(t.eff)).length;
    const head = el('div', { class: 'h' },
      el('b', {}, '🚚 My trucks ', el('span', { style: 'font-weight:400;opacity:.8' }, `${my.size} chosen · ${idleMine} idle`)),
      el('button', { title: S.soundOn ? 'Mute alerts' : 'Unmute alerts', onclick: () => { S.soundOn = !S.soundOn; save(); if (S.soundOn) chime(1); render(); } }, S.soundOn ? '🔔' : '🔕'),
      el('button', { title: S.panel.collapsed ? 'Expand' : 'Collapse', onclick: () => { S.panel.collapsed = !S.panel.collapsed; save(); render(); } }, S.panel.collapsed ? '▢' : '—'));
    drag(head, panel);

    const body = el('div', { class: 'b' },
      el('div', { class: 'row' },
        el('label', {}, el('input', { type: 'checkbox', checked: S.filterOn, onchange: (e) => { S.filterOn = e.target.checked; save(); applyFilter(); } }), 'Show only my trucks on map'),
      ),
      el('div', { class: 'row' },
        el('input', { type: 'text', 'data-k': 'q', placeholder: 'Search or add truck no. (Enter)', value: query,
          oninput: (e) => { query = e.target.value; scheduleRender(); },
          onkeydown: (e) => {
            if (e.key !== 'Enter') return;
            const ids = query.split(/[\s,;]+/).map(normId).filter(Boolean);
            ids.forEach((id) => { if (!S.myTrucks.map(normId).includes(id)) S.myTrucks.push(id); });
            query = ''; save(); applyFilter();
          } }),
      ),
      el('div', { class: 'row muted' },
        el('span', { style: 'flex:1' }, `${trucks.size} trucks seen`),
        el('button', { class: 'btn', onclick: () => { S.myTrucks = visible.filter((t) => !t.ghost).map((t) => t.id); save(); applyFilter(); } }, 'Tick all listed'),
        el('button', { class: 'btn', onclick: () => { S.myTrucks = []; save(); applyFilter(); } }, 'Clear')),
      el('div', { class: 'list' },
        visible.length ? visible.map((t) => el('div', { class: 't' },
          el('input', { type: 'checkbox', checked: my.has(t.id), title: 'Mine', onchange: (e) => {
            const set = mine();
            e.target.checked ? set.add(t.id) : set.delete(t.id);
            S.myTrucks = [...set]; save(); applyFilter();
          } }),
          el('div', {}, el('span', { class: 'id' }, t.id), ' ', el('span', { class: 'since' }, t.ghost ? 'not seen yet' : (t.eff ? 'for ' + ago(t.since) : ''))),
          el('span', { class: 'st' + (t.eff && re.test(t.eff) ? ' idle' : ''), title: t.eff || '' }, t.eff || '—'),
        )) : el('div', { class: 'muted', style: 'padding:8px' }, 'No trucks detected yet. Wait for the map to load, or type your truck numbers above and press Enter.')),
      el('div', { class: 'row' },
        el('button', { class: 'btn pri', onclick: () => chime(S.beeps) }, '▶ Test sound'),
        el('label', {}, el('input', { type: 'checkbox', checked: S.desktopOn, onchange: async (e) => {
          S.desktopOn = e.target.checked; save();
          if (S.desktopOn && W.Notification && Notification.permission === 'default') await Notification.requestPermission();
          render();
        } }), 'Desktop popup'),
      ),
      log.length ? el('div', { class: 'log' }, el('div', { class: 'muted' }, 'Idle alerts'),
        log.slice(0, 6).map((l) => el('div', {}, `${new Date(l.at).toLocaleTimeString()} — ${l.id} went idle (was ${l.prev})`))) : null,
      settingsPanel(),
      diagPanel(),
    );
    panel.append(head, body);

    root.replaceChildren(el('style', {}, STYLE), panel);
    const list = root.querySelector('.list');
    if (list) list.scrollTop = scroll;
    if (focusKey) {
      const f = root.querySelector(`[data-k="${focusKey}"]`);
      if (f) { f.focus(); try { f.setSelectionRange(caret, caret); } catch (e) { /* number inputs */ } }
    }
  }

  function settingsPanel() {
    const field = (label, key, type, extra) => [el('span', { class: 'muted' }, label),
      el('input', Object.assign({ type, 'data-k': key, value: S[key], onchange: (e) => {
        S[key] = type === 'number' ? Number(e.target.value) || 0 : e.target.value; save(); applyFilter();
      } }, extra || {}))];
    const d = el('details', { open: settingsOpen || null, ontoggle: (e) => { settingsOpen = e.target.open; } },
      el('summary', {}, 'Settings'),
      el('div', { class: 'grid' },
        el('span', { class: 'muted' }, 'Alert for'),
        el('select', { onchange: (e) => { S.alertScope = e.target.value; save(); } },
          el('option', { value: 'mine', selected: S.alertScope === 'mine' || null }, 'My trucks only'),
          el('option', { value: 'all', selected: S.alertScope === 'all' || null }, 'All trucks')),
        ...field('Idle pattern', 'idlePattern', 'text', { title: 'Regular expression matched against the status, e.g. idle|returning' }),
        ...field('Beeps', 'beeps', 'number', { min: 1, max: 10 }),
        ...field('Re-alert after (s)', 'cooldownSec', 'number', { min: 0 }),
        ...field('Truck id regex', 'idPattern', 'text', { placeholder: 'auto', title: 'Optional. First capture group is the truck id' }),
        ...field('List row selector', 'rowSelector', 'text', { placeholder: 'none' }),
      ),
      el('div', { class: 'row', style: 'margin-top:6px' },
        el('button', { class: 'btn', onclick: startPicker }, '🎯 Pick truck row'),
        el('span', { class: 'muted' }, 'click a truck in any list on the page')),
    );
    return d;
  }

  function diagText() {
    return JSON.stringify({
      page: location.href.split('?')[0],
      version: '1.1.0',
      libs: { google: !!(W.google && W.google.maps), leaflet: !!(W.L && W.L.version), ol: !!W.ol },
      sources: [...diag.sources],
      trucks: [...trucks.values()].slice(0, 40).map((t) => ({ id: t.id, eff: t.eff, status: t.status })),
      markers: diag.markers,
      network: diag.net,
      rows: diag.rows,
      settings: Object.assign({}, S, { panel: undefined }),
    }, null, 1);
  }
  function diagPanel() {
    return el('details', { open: diagOpen || null, ontoggle: (e) => { diagOpen = e.target.open; if (diagOpen) render(); } },
      el('summary', {}, 'Diagnostics'),
      el('div', { class: 'muted', style: 'margin:4px 0' }, `Map: ${W.google && W.google.maps ? 'Google' : W.L && W.L.version ? 'Leaflet' : W.ol ? 'OpenLayers (list mode only)' : 'not found yet'} · Sources: ${[...diag.sources].join(', ') || 'none yet'}`),
      diagOpen ? el('textarea', { readonly: true }, diagText()) : null,
      el('button', { class: 'btn', onclick: () => {
        const t = diagText();
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).catch(() => prompt('Copy this:', t));
      } }, 'Copy diagnostics'));
  }

  function drag(handle, panel) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const sx = e.clientX - panel.offsetLeft, sy = e.clientY - panel.offsetTop;
      const move = (ev) => { panel.style.left = ev.clientX - sx + 'px'; panel.style.top = ev.clientY - sy + 'px'; };
      const up = () => {
        W.removeEventListener('pointermove', move); W.removeEventListener('pointerup', up);
        S.panel.x = panel.offsetLeft; S.panel.y = panel.offsetTop; save();
      };
      W.addEventListener('pointermove', move); W.addEventListener('pointerup', up);
    });
  }

  // Element picker: user clicks one truck row; we derive a selector that matches its siblings.
  function startPicker() {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #f5a623;background:rgba(245,166,35,.15);z-index:2147483001;';
    document.body.append(box);
    let cur = null;
    const over = (e) => {
      if (host.contains(e.target)) return;
      cur = e.target;
      const r = cur.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };
    const click = (e) => {
      if (host.contains(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      W.removeEventListener('mouseover', over, true); W.removeEventListener('click', click, true);
      box.remove();
      const sel = selectorFor(cur);
      if (sel) { S.rowSelector = sel; settingsOpen = true; save(); scanRows(); applyFilter(); }
    };
    W.addEventListener('mouseover', over, true);
    W.addEventListener('click', click, true);
  }
  function selectorFor(node) {
    // climb to the nearest element that has same-tag siblings (a row), then build tag.class selector
    let n = node;
    while (n && n !== document.body) {
      const p = n.parentElement;
      if (p && [...p.children].filter((c) => c.tagName === n.tagName).length > 2) break;
      n = p;
    }
    if (!n || n === document.body) n = node;
    const cls = [...n.classList].filter((c) => !/active|selected|hover|odd|even|idle|status/i.test(c)).map((c) => '.' + CSS.escape(c)).join('');
    let sel = n.tagName.toLowerCase() + cls;
    if (!cls && n.parentElement) {
      const p = n.parentElement;
      const pc = [...p.classList].map((c) => '.' + CSS.escape(c)).join('');
      sel = (p.id ? '#' + CSS.escape(p.id) : p.tagName.toLowerCase() + pc) + ' > ' + sel;
    }
    return sel;
  }

  // Expose a small API for troubleshooting from the browser console: __tkf.trucks, __tkf.diag()
  W.__tkf = { trucks, settings: S, diag: diagText, applyFilter, chime, handlePayload };
})();
