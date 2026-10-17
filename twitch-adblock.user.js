// ==UserScript==
// @name         Twitch Adblock (Stream + Banner)
// @namespace    local.twitch-adblock
// @version      1.7.0
// @description  Umgeht Pre-/Mid-Roll-Werbung im Twitch-Stream (Playlist-Austausch) und blendet Werbebanner aus.
// @license      MIT
// @homepageURL https://github.com/r79jv66tjh-byte/twitch-adblock
// @supportURL   https://github.com/r79jv66tjh-byte/twitch-adblock/issues
// @updateURL    https://raw.githubusercontent.com/r79jv66tjh-byte/twitch-adblock/main/twitch-adblock.user.js
// @downloadURL  https://raw.githubusercontent.com/r79jv66tjh-byte/twitch-adblock/main/twitch-adblock.user.js
// @match        https://www.twitch.tv/*
// @match        https://twitch.tv/*
// @match        https://m.twitch.tv/*
// @match        https://player.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Einstellungen
  // ---------------------------------------------------------------------------
  const CONFIG = {
    // Player-Typen, über die ein werbefreier Ersatz-Stream angefragt wird (Reihenfolge = Priorität)
    playerTypes: ['embed', 'popout', 'autoplay'],
    // Öffentliche Client-ID des Twitch-Webplayers
    clientId: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    // Kleinen Hinweis im Player anzeigen, während Werbung umgangen wird
    showNotice: true,
    // Zähler für abgefangene Werbepausen unten links anzeigen
    showCounter: true,
    channelName: 'ttv-adblock',
    // Damit mehrere offene Twitch-Tabs sich nicht gegenseitig mitzählen
    tabId: Math.random().toString(36).slice(2),
    deviceId: null,
  };

  try {
    const m = document.cookie.match(/(?:^|;\s*)unique_id=([^;]+)/);
    if (m) CONFIG.deviceId = decodeURIComponent(m[1]);
  } catch (e) { /* egal */ }

  // ---------------------------------------------------------------------------
  // Dieser Code läuft IM Video-Worker von Twitch. Er fängt die HLS-Playlists ab,
  // erkennt eingebettete Werbung und ersetzt sie durch einen werbefreien Stream
  // oder schneidet die Werbesegmente heraus.
  // ---------------------------------------------------------------------------
  function workerMain(cfg) {
    const realFetch = self.fetch.bind(self);
    let bc = null;
    try { bc = new BroadcastChannel(cfg.channelName); } catch (e) { /* nicht verfügbar */ }
    const notify = (msg) => {
      msg.tabId = cfg.tabId;
      try { if (bc) bc.postMessage(msg); } catch (e) { /* egal */ }
    };

    const streams = new Map();     // URL der Media-Playlist -> { channel, res, fps }
    const backupCache = new Map(); // "kanal|playerType" -> { variants, time, hasAds }
    let adActive = false;

    const GQL_QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature authorization { isForbidden forbiddenReasonCode } __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

    function hasAds(text) {
      return text.includes('stitched-ad') || text.includes('X-TV-TWITCH-AD');
    }

    function parseAttr(line, name) {
      const m = line.match(new RegExp('[:,]' + name + '=("[^"]*"|[^,]*)'));
      return m ? m[1].replace(/"/g, '') : null;
    }

    function parseMaster(text, baseUrl) {
      const lines = text.split('\n');
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
        if (j >= lines.length) break;
        let url = lines[j].trim();
        try { url = new URL(url, baseUrl).href; } catch (e) { /* schon absolut */ }
        variants.push({
          url,
          res: parseAttr(line, 'RESOLUTION'),
          fps: parseFloat(parseAttr(line, 'FRAME-RATE')) || 0,
        });
        i = j;
      }
      return variants;
    }

    function pixels(res) {
      const m = res && res.match(/(\d+)x(\d+)/);
      return m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
    }

    function pickVariant(variants, info) {
      if (!variants.length) return null;
      const exact = variants.find(v => v.res === info.res && Math.round(v.fps) === Math.round(info.fps))
        || variants.find(v => v.res === info.res);
      if (exact) return exact;
      const target = pixels(info.res);
      return variants.slice().sort((a, b) => Math.abs(pixels(a.res) - target) - Math.abs(pixels(b.res) - target))[0];
    }

    // Entfernt Werbesegmente direkt aus der Playlist (Notlösung: Bild kann kurz stehen bleiben)
    function stripAds(text) {
      const lines = text.split('\n');
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXTINF') && !line.includes(',live')) {
          // Segment-URL (nächste Nicht-Tag-Zeile) mit überspringen
          while (i + 1 < lines.length && lines[i + 1].startsWith('#') && !lines[i + 1].startsWith('#EXTINF')) i++;
          if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) i++;
          continue;
        }
        if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) continue;
        if (line.startsWith('#EXT-X-DATERANGE') && line.includes('stitched-ad')) continue;
        out.push(line);
      }
      return out.join('\n');
    }

    async function createBackup(channel, playerType) {
      try {
        const headers = { 'Client-ID': cfg.clientId, 'Content-Type': 'text/plain;charset=UTF-8' };
        if (cfg.deviceId) headers['X-Device-Id'] = cfg.deviceId;
        const r = await realFetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            operationName: 'PlaybackAccessToken_Template',
            query: GQL_QUERY,
            variables: {
              isLive: true, login: channel, isVod: false, vodID: '',
              playerType, platform: playerType === 'autoplay' ? 'android' : 'web',
            },
          }),
        });
        if (!r.ok) return null;
        const json = await r.json();
        const tok = json && json.data && json.data.streamPlaybackAccessToken;
        if (!tok || !tok.value) return null;
        const params = new URLSearchParams({
          allow_source: 'true', allow_audio_only: 'true', fast_bread: 'true',
          p: String(Math.floor(Math.random() * 1e7)), player_backend: 'mediaplayer',
          playlist_include_framerate: 'true', reassignments_supported: 'true',
          sig: tok.signature, supported_codecs: 'avc1', token: tok.value,
          transcode_mode: 'cbr_v1', cdm: 'wv',
        });
        const master = await realFetch('https://usher.ttvnw.net/api/channel/hls/' + encodeURIComponent(channel) + '.m3u8?' + params);
        if (!master.ok) return null;
        return { variants: parseMaster(await master.text(), master.url), time: Date.now(), hasAds: false };
      } catch (e) {
        return null;
      }
    }

    async function getBackupPlaylist(info) {
      for (const playerType of cfg.playerTypes) {
        const key = info.channel + '|' + playerType;
        let entry = backupCache.get(key);
        if (entry && entry.hasAds) continue;
        if (!entry || Date.now() - entry.time > 4 * 60 * 1000) {
          entry = await createBackup(info.channel, playerType);
          if (!entry) continue;
          backupCache.set(key, entry);
        }
        const variant = pickVariant(entry.variants, info);
        if (!variant) continue;
        try {
          const r = await realFetch(variant.url);
          if (!r.ok) { backupCache.delete(key); continue; }
          const text = await r.text();
          if (hasAds(text)) { entry.hasAds = true; continue; }
          return text;
        } catch (e) {
          backupCache.delete(key);
        }
      }
      return null;
    }

    function rebuild(res, text) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    self.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);

      // Master-Playlist: Kanal und Auflösungen der Varianten merken
      if (url.includes('usher.ttvnw.net/api/channel/hls/')) {
        const res = await realFetch(input, init);
        if (!res.ok) return res;
        const text = await res.text();
        const m = url.match(/\/hls\/([^/.?]+)\.m3u8/);
        const channel = m ? decodeURIComponent(m[1]).toLowerCase() : null;
        for (const v of parseMaster(text, url)) streams.set(v.url, { channel, res: v.res, fps: v.fps });
        return rebuild(res, text);
      }

      // Media-Playlist: auf Werbung prüfen
      if (url.includes('.m3u8') && (streams.has(url) || url.includes('ttvnw.net'))) {
        const res = await realFetch(input, init);
        if (!res.ok) return res;
        let text = await res.text();
        if (hasAds(text)) {
          if (!adActive) { adActive = true; notify({ type: 'ad-start' }); }
          const info = streams.get(url);
          const replacement = info && info.channel ? await getBackupPlaylist(info) : null;
          text = replacement !== null ? replacement : stripAds(text);
          notify({ type: 'ad', mode: replacement !== null ? 'backup' : 'stripped', channel: info ? info.channel : null });
        } else if (adActive) {
          adActive = false;
          backupCache.clear();
          notify({ type: 'ad-end' });
        }
        return rebuild(res, text);
      }

      return realFetch(input, init);
    };
  }

  // ---------------------------------------------------------------------------
  // Worker von Twitch abfangen und obigen Code voranstellen
  // ---------------------------------------------------------------------------
  const RealWorker = window.Worker;

  function readBlobSync(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    return (xhr.status === 200 || xhr.status === 0) ? xhr.responseText : null;
  }

  class PatchedWorker extends RealWorker {
    constructor(scriptURL, options) {
      const url = String(scriptURL);
      let src = null;
      if (url.startsWith('blob:')) {
        try { src = readBlobSync(url); } catch (e) { src = null; }
      }
      if (!src || !/wasmworker|amazon-ivs/i.test(src)) {
        super(scriptURL, options);
        return;
      }
      const code = '(' + workerMain.toString() + ')(' + JSON.stringify(CONFIG) + ');\n' + src;
      super(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })), options);
    }
  }

  try {
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      get() { return PatchedWorker; },
      set() { /* Überschreiben durch die Seite ignorieren */ },
    });
  } catch (e) {
    window.Worker = PatchedWorker;
  }

  // ---------------------------------------------------------------------------
  // Werbebanner / Overlays auf der Seite ausblenden
  // ---------------------------------------------------------------------------
  const CSS = `
    [data-a-target="video-ad-label"],
    [data-a-target="video-ad-countdown"],
    [data-a-target="ax-overlay"],
    [data-a-target="outstream-ax-overlay"],
    [data-test-selector="sad-overlay"],
    [data-test-selector="ad-banner-default-text"],
    [data-test-selector="sda-wrapper"],
    .stream-display-ad,
    .stream-display-ad__wrapper,
    div[class*="StreamDisplayAd"],
    iframe[src*="amazon-adsystem.com"],
    iframe[src*="ads.twitch.tv"] {
      display: none !important;
    }
    #ttv-adblock-counter {
      position: fixed; z-index: 99999; left: 12px; top: 0;
      border-radius: 12px; max-width: calc(100vw - 8px);
      background: rgba(24, 24, 27, 0.92); color: #bf94ff;
      border: 1px solid rgba(145, 70, 255, 0.6);
      font: 600 12px/1.3 system-ui, sans-serif;
      user-select: none; opacity: .8;
    }
    #ttv-adblock-counter:hover, #ttv-adblock-counter.expanded { opacity: 1; }
    #ttv-adblock-counter.expanded { width: 280px; border-radius: 10px; }
    #ttv-adblock-counter.locked { border-color: rgba(145, 70, 255, 0.25); }
    #ttv-adblock-counter .ttv-ab-head {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 6px 4px 9px; cursor: grab; touch-action: none;
    }
    #ttv-adblock-counter .ttv-ab-head > span { flex: 1; white-space: nowrap; }
    #ttv-adblock-counter.dragging .ttv-ab-head { cursor: grabbing; }
    #ttv-adblock-counter.locked .ttv-ab-head { cursor: default; }
    #ttv-adblock-counter button {
      all: unset; cursor: pointer; line-height: 1; border-radius: 6px;
    }
    #ttv-adblock-counter .ttv-ab-icon { font-size: 12px; padding: 2px 4px; }
    #ttv-adblock-counter .ttv-ab-icon:hover { background: rgba(145, 70, 255, 0.35); }
    #ttv-adblock-counter .ttv-ab-panel {
      display: none; padding: 4px 10px 10px; color: #efeff1; font-weight: 400;
      border-top: 1px solid rgba(145, 70, 255, 0.3);
    }
    #ttv-adblock-counter.expanded .ttv-ab-panel { display: block; }
    #ttv-adblock-counter .ttv-ab-stats {
      display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 6px 0;
    }
    #ttv-adblock-counter .ttv-ab-stats b { font-weight: 600; text-align: right; color: #bf94ff; }
    #ttv-adblock-counter .ttv-ab-stats b.bad { color: #ff8a8a; }
    #ttv-adblock-counter .ttv-ab-muted { color: #adadb8; font-size: 11px; margin: 4px 0; }
    #ttv-adblock-counter .ttv-ab-reportrow {
      display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; margin: 8px 0;
    }
    #ttv-adblock-counter .ttv-ab-reportrow button {
      text-align: center; padding: 6px 4px; font-weight: 600; font-size: 11px; color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      border: 1px solid transparent; transition: background .15s, border-color .15s;
    }
    #ttv-adblock-counter .ttv-ab-stamp { background: rgba(145, 70, 255, 0.3); border-color: rgba(145, 70, 255, 0.7) !important; }
    #ttv-adblock-counter .ttv-ab-stamp:hover { background: rgba(145, 70, 255, 0.5); }
    #ttv-adblock-counter .ttv-ab-leak { background: rgba(235, 4, 0, 0.25); border-color: rgba(255, 90, 90, 0.6) !important; }
    #ttv-adblock-counter .ttv-ab-leak:hover { background: rgba(235, 4, 0, 0.4); }
    #ttv-adblock-counter .ttv-ab-sync {
      padding: 6px 8px !important; background: rgba(255, 255, 255, 0.06); opacity: .55;
      border-color: rgba(255, 255, 255, 0.15) !important;
    }
    #ttv-adblock-counter .ttv-ab-sync:hover { opacity: .85; }
    #ttv-adblock-counter .ttv-ab-sync.on {
      opacity: 1; background: rgba(0, 200, 120, 0.25); border-color: rgba(0, 220, 130, 0.7) !important;
    }
    #ttv-adblock-counter .ttv-ab-reportrow.synced .ttv-ab-stamp,
    #ttv-adblock-counter .ttv-ab-reportrow.synced .ttv-ab-leak { box-shadow: 0 0 0 1px rgba(0, 220, 130, 0.5); }
    #ttv-adblock-counter .ttv-ab-reportrow.synced button.pair-hover { filter: brightness(1.3); }
    #ttv-adblock-counter h4 { margin: 8px 0 4px; font-size: 11px; font-weight: 600; color: #adadb8; text-transform: uppercase; }
    #ttv-adblock-counter ul {
      list-style: none; margin: 0; padding: 0; max-height: 130px; overflow-y: auto; font-size: 11px;
    }
    #ttv-adblock-counter li { padding: 3px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
    #ttv-adblock-counter .ttv-ab-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    #ttv-adblock-counter .ttv-ab-actions button {
      padding: 4px 7px; font-size: 11px; background: rgba(255, 255, 255, 0.08); color: #efeff1;
    }
    #ttv-adblock-counter .ttv-ab-actions button:hover { background: rgba(255, 255, 255, 0.16); }
    #ttv-adblock-counter .ttv-ab-actions button.confirm { background: rgba(235, 4, 0, 0.55); color: #fff; font-weight: 600; }
    #ttv-adblock-counter .ttv-ab-emergency { opacity: .4; filter: grayscale(1); }
    #ttv-adblock-counter .ttv-ab-emergency.on {
      opacity: 1; filter: none; background: rgba(0, 200, 120, 0.25);
      box-shadow: 0 0 0 1px rgba(0, 220, 130, 0.7);
    }
    video.ttv-ab-blur { filter: blur(40px) brightness(0.35) !important; }
    .ttv-ab-veil {
      position: absolute; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center; text-align: center;
      padding: 16px; color: #fff; font: 600 16px/1.4 system-ui, sans-serif;
      text-shadow: 0 1px 4px rgba(0, 0, 0, .8); pointer-events: none;
    }
    #ttv-adblock-notice {
      position: fixed; z-index: 99999; left: 12px; top: 0;
      padding: 8px 12px; border-radius: 6px;
      background: rgba(145, 70, 255, 0.92); color: #fff;
      font: 600 13px/1.3 system-ui, sans-serif;
      pointer-events: none; transition: opacity .3s; opacity: 0;
    }
    #ttv-adblock-notice.show { opacity: 1; }
  `;

  function injectCss() {
    const style = document.createElement('style');
    style.id = 'ttv-adblock-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.documentElement) injectCss();
  else document.addEventListener('DOMContentLoaded', injectCss, { once: true });

  // ---------------------------------------------------------------------------
  // Zähler-Box mit ausklappbarem Panel und Melde-Funktion
  // (alles im localStorage von twitch.tv gespeichert)
  // ---------------------------------------------------------------------------
  const VERSION = '1.7.0';
  const STATS_KEY = 'ttvAdblockStats';
  const BOX_KEY = 'ttvAdblockCounterBox';
  const REPORTS_KEY = 'ttvAdblockReports';
  const MAX_REPORTS = 100;

  // Datum in Ortszeit (für „Heute“)
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function loadJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* egal */ }
  }

  function loadStats() {
    const s = loadJson(STATS_KEY, null) || {};
    if (typeof s.total !== 'number') s.total = 0;
    if (typeof s.today !== 'number') s.today = 0;
    if (typeof s.leaked !== 'number') s.leaked = 0;
    if (s.day !== today()) { s.day = today(); s.today = 0; }
    return s;
  }
  const saveStats = (s) => saveJson(STATS_KEY, s);

  function loadReports() {
    const r = loadJson(REPORTS_KEY, []);
    return Array.isArray(r) ? r : [];
  }

  const box = Object.assign({ x: null, y: null, locked: false, expanded: false, sync: false, emergency: true }, loadJson(BOX_KEY, {}));
  const saveBox = () => saveJson(BOX_KEY, box);

  let sessionCount = 0;
  let lastAd = null; // { time, channel, mode } der letzten Werbepause in diesem Tab
  let notice = null;
  let noticeTimer = null;
  const ui = {};

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function currentChannel() {
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    const reserved = ['directory', 'videos', 'settings', 'search', 'downloads', 'subscriptions', 'inventory', 'wallet', 'drops'];
    return seg && !reserved.includes(seg.toLowerCase()) ? seg.toLowerCase() : null;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' '
      + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  const MODE_TEXT = { backup: 'Ersatz-Stream', stripped: 'herausgeschnitten' };

  // Box im sichtbaren Bereich halten (z. B. nach Verkleinern des Fensters oder Aufklappen)
  function placeCounter() {
    if (!ui.root) return;
    const w = ui.root.offsetWidth;
    const h = ui.root.offsetHeight;
    let x = box.x === null ? 12 : box.x;
    let y = box.y === null ? window.innerHeight - h - 12 : box.y;
    x = Math.max(0, Math.min(x, window.innerWidth - w));
    y = Math.max(0, Math.min(y, window.innerHeight - h));
    ui.root.style.left = x + 'px';
    ui.root.style.top = y + 'px';
    placeNotice();
  }

  function updateEmergency() {
    ui.emergency.classList.toggle('on', !!box.emergency);
    ui.emergency.title = box.emergency
      ? 'Notfall-Modus AN: Rutscht Werbung durch, wird sie stumm und unscharf geschaltet – klicken zum Ausschalten'
      : 'Notfall-Modus AUS – klicken zum Einschalten';
  }

  function updateLock() {
    ui.root.classList.toggle('locked', !!box.locked);
    ui.lock.textContent = box.locked ? '🔒' : '🔓';
    ui.lock.title = box.locked ? 'Gesperrt – klicken zum Entsperren' : 'Verschiebbar – klicken zum Sperren';
  }

  function updateExpanded() {
    ui.root.classList.toggle('expanded', !!box.expanded);
    ui.toggle.textContent = box.expanded ? '▴' : '▾';
    ui.toggle.title = box.expanded ? 'Einklappen' : 'Details & Melden';
  }

  function updateSync() {
    ui.sync.classList.toggle('on', !!box.sync);
    ui.reportRow.classList.toggle('synced', !!box.sync);
    ui.sync.title = box.sync
      ? 'Sync AN: Ein Klick auf „Zeitstempel“ oder „Durchgerutscht“ löst beide aus – klicken zum Ausschalten'
      : 'Sync AUS: Buttons arbeiten einzeln – klicken, um beide zu koppeln';
  }

  function makeDraggable() {
    let start = null;
    ui.head.addEventListener('pointerdown', (e) => {
      if (box.locked || e.button !== 0 || e.target.closest('button')) return;
      const r = ui.root.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      ui.head.setPointerCapture(e.pointerId);
      ui.root.classList.add('dragging');
      e.preventDefault();
    });
    ui.head.addEventListener('pointermove', (e) => {
      if (!start) return;
      box.x = e.clientX - start.dx;
      box.y = e.clientY - start.dy;
      placeCounter();
    });
    const end = () => {
      if (!start) return;
      start = null;
      ui.root.classList.remove('dragging');
      // tatsächliche (ggf. begrenzte) Position speichern
      box.x = parseFloat(ui.root.style.left);
      box.y = parseFloat(ui.root.style.top);
      saveBox();
    };
    ui.head.addEventListener('pointerup', end);
    ui.head.addEventListener('pointercancel', end);
    window.addEventListener('resize', placeCounter);
  }

  // Bestätigung direkt im Button statt confirm()-Dialog (der kann vom Browser
  // unterdrückt werden): 1. Klick = „Sicher?“, 2. Klick innerhalb 4 s = ausführen
  function confirmClick(btn, action) {
    let armed = false;
    let timer = null;
    const disarm = () => {
      armed = false;
      clearTimeout(timer);
      btn.classList.remove('confirm');
      if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label;
    };
    btn.addEventListener('click', () => {
      if (!armed) {
        if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
        clearTimeout(btn._flashTimer);
        armed = true;
        btn.classList.add('confirm');
        btn.textContent = 'Sicher? Nochmal klicken';
        timer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      action();
    });
  }

  function flashButton(btn, text) {
    if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
    clearTimeout(btn._flashTimer);
    btn.textContent = text;
    btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
  }

  function reportsAsText() {
    const s = loadStats();
    const lines = [
      'Twitch Adblock ' + VERSION + ' – Protokoll',
      'Blockierte Werbepausen insgesamt: ' + s.total + ', durchgerutscht: ' + s.leaked,
      'Browser: ' + navigator.userAgent,
      '',
    ];
    for (const r of loadReports()) {
      lines.push(fmtTime(r.time) + ' | ' + (r.channel || '?') + ' | '
        + (r.auto ? 'automatisch erkannt' : 'manuell gemeldet')
        + ' | letzte Methode: ' + (MODE_TEXT[r.mode] || 'keine Werbung erkannt'));
    }
    return lines.join('\n');
  }

  // Text für eine manuelle Meldung, z. B.
  // "Werbung nicht blockiert – 17.10.2026 16:23:05 – Kanal: xyz – letzte Methode: Ersatz-Stream (vor 40 s)"
  function reportStamp() {
    const now = new Date();
    const recent = lastAd && Date.now() - lastAd.time < 5 * 60 * 1000 ? lastAd : null;
    const parts = [
      'Werbung nicht blockiert',
      now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' '
        + now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      'Kanal: ' + (currentChannel() || (recent && recent.channel) || '?'),
      recent
        ? 'letzte Methode: ' + (MODE_TEXT[recent.mode] || '?') + ' (vor ' + Math.round((Date.now() - recent.time) / 1000) + ' s)'
        : 'vom Script keine Werbung erkannt',
      'Script ' + VERSION,
    ];
    return parts.join(' – ');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* Fallback */ }
    const ta = el('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function buildCounter() {
    ui.root = el('div');
    ui.root.id = 'ttv-adblock-counter';

    // Kopfzeile: Zähler, Notfall-Modus, Auf-/Zuklappen, Schloss
    ui.head = el('div', 'ttv-ab-head');
    ui.text = el('span');
    ui.emergency = el('button', 'ttv-ab-icon ttv-ab-emergency', '🛟');
    ui.toggle = el('button', 'ttv-ab-icon');
    ui.lock = el('button', 'ttv-ab-icon');
    ui.head.append(ui.text, ui.emergency, ui.toggle, ui.lock);
    ui.head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      box.expanded = !box.expanded;
      saveBox();
      renderCounter();
    });

    // Ausklappbares Panel
    ui.panel = el('div', 'ttv-ab-panel');
    const stats = el('div', 'ttv-ab-stats');
    const row = (label, cls) => {
      const v = el('b', cls || '', '0');
      stats.append(el('span', '', label), v);
      return v;
    };
    ui.vTab = row('Dieser Tab');
    ui.vToday = row('Heute');
    ui.vTotal = row('Insgesamt');
    ui.vLeaked = row('Durchgerutscht', 'bad');
    ui.last = el('div', 'ttv-ab-muted');
    // Melde-Zeile: [Zeitstempel] [Durchgerutscht] [Sync]
    ui.reportRow = el('div', 'ttv-ab-reportrow');
    ui.stamp = el('button', 'ttv-ab-stamp', '⏱ Zeitstempel');
    ui.stamp.title = 'Kopiert einen Zeitstempel (Uhrzeit, Kanal, Methode) in die Zwischenablage – wird nicht gespeichert';
    ui.leak = el('button', 'ttv-ab-leak', '⚠ Durchgerutscht');
    ui.leak.title = 'Speichert die gerade gesehene Werbung im Durchgerutscht-Protokoll (+1)';
    ui.sync = el('button', 'ttv-ab-sync', '🔗');
    ui.reportRow.append(ui.stamp, ui.leak, ui.sync);
    ui.listTitle = el('h4', '', 'Durchgerutscht (automatisch erkannt)');
    ui.list = el('ul');
    const actions = el('div', 'ttv-ab-actions');
    ui.copy = el('button', '', '📋 Protokoll kopieren');
    ui.clear = el('button', '', '🗑 Durchgerutscht leeren');
    ui.reset = el('button', '', '↺ Zähler zurücksetzen');
    actions.append(ui.copy, ui.clear, ui.reset);
    ui.panel.append(stats, ui.last, ui.reportRow, ui.listTitle, ui.list, actions);

    ui.root.append(ui.head, ui.panel);
    document.body.appendChild(ui.root);

    ui.toggle.addEventListener('click', () => {
      box.expanded = !box.expanded;
      saveBox();
      renderCounter();
    });
    ui.lock.addEventListener('click', () => {
      box.locked = !box.locked;
      saveBox();
      updateLock();
    });
    ui.emergency.addEventListener('click', () => {
      box.emergency = !box.emergency;
      saveBox();
      updateEmergency();
      if (!box.emergency) emergencyOff();
      showNotice(box.emergency
        ? 'Notfall-Modus AN: durchgerutschte Werbung wird stumm & unscharf geschaltet'
        : 'Notfall-Modus AUS', 3000);
    });
    // Zeitstempel: nur in die Zwischenablage, nichts speichern
    async function doStamp() {
      const ok = await copyText(reportStamp());
      flashButton(ui.stamp, ok ? '✓ Kopiert' : '✗ Fehler');
    }
    // Durchgerutscht: im Protokoll speichern und Zähler +1
    function doLeak() {
      addReport(false);
      flashButton(ui.leak, '✓ Gespeichert');
    }
    // Ist Sync an, löst jeder der beiden Buttons auch den anderen aus
    ui.stamp.addEventListener('click', () => { doStamp(); if (box.sync) doLeak(); });
    ui.leak.addEventListener('click', () => { doLeak(); if (box.sync) doStamp(); });
    ui.sync.addEventListener('click', () => {
      box.sync = !box.sync;
      saveBox();
      updateSync();
    });
    // Bei aktivem Sync beim Überfahren beide Buttons hervorheben
    for (const [a, b] of [[ui.stamp, ui.leak], [ui.leak, ui.stamp]]) {
      a.addEventListener('mouseenter', () => { if (box.sync) b.classList.add('pair-hover'); });
      a.addEventListener('mouseleave', () => b.classList.remove('pair-hover'));
    }
    updateSync();
    ui.copy.addEventListener('click', async () => {
      flashButton(ui.copy, (await copyText(reportsAsText())) ? '✓ Kopiert' : '✗ Fehlgeschlagen');
    });
    confirmClick(ui.clear, () => {
      saveJson(REPORTS_KEY, []);
      const s = loadStats();
      s.leaked = 0;
      saveStats(s);
      renderCounter();
      flashButton(ui.clear, '✓ Geleert');
    });
    confirmClick(ui.reset, () => {
      saveStats({ total: 0, today: 0, leaked: 0, day: today() });
      sessionCount = 0;
      renderCounter();
      flashButton(ui.reset, '✓ Zurückgesetzt');
    });

    updateLock();
    updateEmergency();
    makeDraggable();
  }

  function renderCounter() {
    if (!CONFIG.showCounter || !document.body) return;
    if (!ui.root) buildCounter();
    const s = loadStats();
    ui.text.textContent = '🛡 ' + s.total + ' Werbepausen blockiert';
    ui.head.title = box.locked
      ? 'Doppelklick = Details ein-/ausklappen'
      : 'Ziehen = verschieben, Doppelklick = Details ein-/ausklappen';
    updateExpanded();

    if (box.expanded) {
      ui.vTab.textContent = String(sessionCount);
      ui.vToday.textContent = String(s.today);
      ui.vTotal.textContent = String(s.total);
      ui.vLeaked.textContent = String(s.leaked);
      ui.last.textContent = lastAd
        ? 'Letzte Werbepause: ' + fmtTime(lastAd.time) + (lastAd.channel ? ' bei ' + lastAd.channel : '')
          + ' (' + (MODE_TEXT[lastAd.mode] || '?') + ')'
        : 'In diesem Tab noch keine Werbepause.';

      const reports = loadReports();
      ui.list.replaceChildren();
      if (!reports.length) {
        ui.list.append(el('li', 'ttv-ab-muted', 'Keine Meldungen.'));
      } else {
        for (const r of reports.slice(0, 20)) {
          ui.list.append(el('li', '', fmtTime(r.time) + ' · ' + (r.channel || '?')
            + (r.mode ? ' · ' + MODE_TEXT[r.mode] : '') + ' · ' + (r.auto ? 'automatisch' : 'manuell')));
        }
      }
      ui.listTitle.textContent = 'Durchgerutscht – Protokoll (' + reports.length + ')';
    }
    placeCounter();
  }

  function countAdBreak() {
    const s = loadStats();
    s.total++;
    s.today++;
    saveStats(s);
    sessionCount++;
    renderCounter();
  }

  // Durchgerutschte Werbung speichern (automatisch erkannt: Twitch zeigt seine Werbe-Anzeige)
  function addReport(auto) {
    const recent = lastAd && Date.now() - lastAd.time < 3 * 60 * 1000 ? lastAd : null;
    const reports = loadReports();
    reports.unshift({
      time: new Date().toISOString(),
      channel: currentChannel() || (recent && recent.channel) || null,
      auto: !!auto,
      mode: recent ? recent.mode : null,
      version: VERSION,
    });
    saveJson(REPORTS_KEY, reports.slice(0, MAX_REPORTS));
    const s = loadStats();
    s.leaked++;
    saveStats(s);
    renderCounter();
  }

  if (document.body) renderCounter();
  else document.addEventListener('DOMContentLoaded', renderCounter, { once: true });
  // Box aktualisieren, wenn ein anderer Twitch-Tab gezählt oder gemeldet hat
  window.addEventListener('storage', (e) => {
    if (e.key === STATS_KEY || e.key === REPORTS_KEY) renderCounter();
  });

  // Automatische Erkennung: Zeigt Twitch seine eigene Werbe-Anzeige (Label/Countdown),
  // hat der Player Werbung erkannt, die nicht entfernt wurde.
  const AD_UI_SELECTOR = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]';
  let lastAutoReport = 0;

  // Notfall-Modus: durchgerutschte Werbung stumm und unscharf schalten
  const emergency = { active: false, videos: new Map() }; // video -> war vorher stumm?

  function emergencyOn() {
    for (const v of document.querySelectorAll('video')) {
      if (!emergency.videos.has(v)) emergency.videos.set(v, v.muted);
      if (!v.muted) v.muted = true; // Twitch könnte den Ton wieder anschalten – jede Runde prüfen
      v.classList.add('ttv-ab-blur');
      const host = v.parentElement;
      if (host && !host.querySelector(':scope > .ttv-ab-veil')) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(el('div', 'ttv-ab-veil', '🛟 Werbung durchgerutscht – stumm & ausgeblendet'));
      }
    }
    emergency.active = true;
  }

  function emergencyOff() {
    for (const [v, wasMuted] of emergency.videos) {
      v.classList.remove('ttv-ab-blur');
      v.muted = wasMuted;
    }
    emergency.videos.clear();
    for (const veil of document.querySelectorAll('.ttv-ab-veil')) veil.remove();
    emergency.active = false;
  }

  setInterval(() => {
    const adVisible = !!(document.body && document.querySelector(AD_UI_SELECTOR));

    if (adVisible && box.emergency) emergencyOn();
    else if (emergency.active) emergencyOff();

    if (!adVisible || Date.now() - lastAutoReport < 90 * 1000) return;
    lastAutoReport = Date.now();
    addReport(true);
    showNotice(box.emergency
      ? 'Werbung ist durchgerutscht – stumm & ausgeblendet, automatisch gemeldet'
      : 'Werbung ist durchgerutscht – automatisch gemeldet', 6000);
  }, 500);

  // ---------------------------------------------------------------------------
  // Hinweis direkt über der Box (oder darunter, wenn oben kein Platz ist)
  // ---------------------------------------------------------------------------
  function placeNotice() {
    if (!notice) return;
    if (!ui.root) {
      notice.style.left = '12px';
      notice.style.top = (window.innerHeight - notice.offsetHeight - 12) + 'px';
      return;
    }
    const r = ui.root.getBoundingClientRect();
    const h = notice.offsetHeight;
    const top = r.top - h - 6 >= 0 ? r.top - h - 6 : r.bottom + 6;
    const left = Math.max(0, Math.min(r.left, window.innerWidth - notice.offsetWidth));
    notice.style.left = left + 'px';
    notice.style.top = top + 'px';
  }

  function showNotice(text, autoHideMs) {
    if (!CONFIG.showNotice || !document.body) return;
    if (!notice) {
      notice = el('div');
      notice.id = 'ttv-adblock-notice';
      document.body.appendChild(notice);
    }
    clearTimeout(noticeTimer);
    if (text) {
      notice.textContent = text;
      notice.classList.add('show');
      placeNotice();
      if (autoHideMs) noticeTimer = setTimeout(() => notice.classList.remove('show'), autoHideMs);
    } else {
      notice.classList.remove('show');
    }
  }

  if (typeof BroadcastChannel !== 'undefined') {
    const bc = new BroadcastChannel(CONFIG.channelName);
    bc.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.tabId !== CONFIG.tabId) return; // Meldung aus einem anderen Tab
      if (msg.type === 'ad-start') {
        lastAd = { time: Date.now(), channel: currentChannel(), mode: null };
        countAdBreak();
      } else if (msg.type === 'ad') {
        lastAd = lastAd || { time: Date.now() };
        lastAd.mode = msg.mode;
        if (msg.channel) lastAd.channel = msg.channel;
        showNotice(msg.mode === 'backup'
          ? 'Werbung erkannt – werbefreier Ersatz-Stream aktiv'
          : 'Werbung wird herausgeschnitten – Bild kann kurz stehen bleiben');
        if (box.expanded) renderCounter();
      } else if (msg.type === 'ad-end') {
        showNotice(null);
      }
    };
  }
})();
