// ==UserScript==
// @name         Twitch Adblock (Stream + Banner)
// @namespace    local.twitch-adblock
// @version      1.8.0
// @description  Bypasses pre-/mid-roll ads in the Twitch stream (playlist swap) and hides ad banners. Ad counter with time saved, emergency mode, DE/EN.
// @description:de Umgeht Pre-/Mid-Roll-Werbung im Twitch-Stream (Playlist-Austausch) und blendet Werbebanner aus. Werbe-Zähler mit gesparter Zeit, Notfall-Modus, DE/EN.
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
    // Standardwerte der Einstellungen (änderbar im Panel unter ⚙)
    defaults: {
      showNotice: true,  // Hinweise einblenden
      showCounter: true, // Zahlen in der Box anzeigen (aus = nur 🛡-Symbol)
      autoDetect: true,  // durchgerutschte Werbung automatisch protokollieren
      emergency: true,   // Notfall-Modus
      lang: 'auto',      // 'auto' | 'de' | 'en'
    },
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
    let adStart = 0;
    const adSpots = new Map(); // ID des Werbespots -> Dauer in Sekunden (aus #EXT-X-DATERANGE)

    // Werbespots der aktuellen Pause mit ihrer Länge merken
    function collectAdSpots(text) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('#EXT-X-DATERANGE') || !line.includes('stitched-ad')) continue;
        const id = (line.match(/[:,]ID="([^"]+)"/) || [])[1];
        const dur = parseFloat((line.match(/[:,]DURATION=([\d.]+)/) || [])[1]);
        if (id && dur > 0) adSpots.set(id, dur);
      }
    }

    // Gesparte Zeit der Pause: Summe der Spot-Längen, sonst gemessene Dauer (max. 10 min)
    function adBreakSeconds() {
      let sum = 0;
      for (const d of adSpots.values()) sum += d;
      if (!sum) sum = (Date.now() - adStart) / 1000;
      return Math.round(Math.min(sum, 600));
    }

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
          if (!adActive) {
            adActive = true;
            adStart = Date.now();
            adSpots.clear();
            notify({ type: 'ad-start' });
          }
          collectAdSpots(text);
          const info = streams.get(url);
          const replacement = info && info.channel ? await getBackupPlaylist(info) : null;
          text = replacement !== null ? replacement : stripAds(text);
          notify({ type: 'ad', mode: replacement !== null ? 'backup' : 'stripped', channel: info ? info.channel : null });
        } else if (adActive) {
          adActive = false;
          backupCache.clear();
          notify({ type: 'ad-end', seconds: adBreakSeconds() });
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
    #ttv-adblock-counter.expanded { width: 300px; border-radius: 10px; }
    #ttv-adblock-counter.locked { border-color: rgba(145, 70, 255, 0.25); }
    #ttv-adblock-counter .ttv-ab-head {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 6px 4px 9px; cursor: grab; touch-action: none;
    }
    #ttv-adblock-counter .ttv-ab-head > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #ttv-adblock-counter .ttv-ab-head > button { flex: none; }
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
    #ttv-adblock-counter .ttv-ab-stats b.good { color: #5fe0a5; }
    #ttv-adblock-counter .ttv-ab-settings-btn {
      display: block; width: 100%; box-sizing: border-box; margin-top: 10px; padding: 5px 7px;
      font-size: 11px; font-weight: 600; color: #adadb8; background: rgba(255, 255, 255, 0.05);
    }
    #ttv-adblock-counter .ttv-ab-settings-btn:hover { background: rgba(255, 255, 255, 0.12); color: #efeff1; }
    #ttv-adblock-counter .ttv-ab-settings { display: none; padding: 6px 2px 0; }
    #ttv-adblock-counter .ttv-ab-settings.open { display: block; }
    #ttv-adblock-counter .ttv-ab-setting {
      display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; font-size: 12px; cursor: pointer;
    }
    #ttv-adblock-counter .ttv-ab-setting input { margin: 1px 0 0; accent-color: #9146ff; cursor: pointer; }
    #ttv-adblock-counter .ttv-ab-setting small { display: block; color: #adadb8; font-size: 10px; }
    #ttv-adblock-counter .ttv-ab-lang { align-items: center; justify-content: space-between; cursor: default; }
    #ttv-adblock-counter .ttv-ab-lang select {
      background: #18181b; color: #efeff1; border: 1px solid rgba(145, 70, 255, 0.6);
      border-radius: 6px; padding: 2px 4px; font-size: 12px;
    }
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
  // Zähler-Box mit ausklappbarem Panel, Melde-Funktion und Einstellungen
  // (alles im localStorage von twitch.tv gespeichert)
  // ---------------------------------------------------------------------------
  const VERSION = '1.8.0';
  const STATS_KEY = 'ttvAdblockStats';
  const BOX_KEY = 'ttvAdblockCounterBox';
  const REPORTS_KEY = 'ttvAdblockReports';
  const SETTINGS_KEY = 'ttvAdblockSettings';
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
    for (const k of ['total', 'today', 'leaked', 'savedTotal', 'savedToday']) {
      if (typeof s[k] !== 'number') s[k] = 0;
    }
    if (s.day !== today()) { s.day = today(); s.today = 0; s.savedToday = 0; }
    return s;
  }
  const saveStats = (s) => saveJson(STATS_KEY, s);

  function loadReports() {
    const r = loadJson(REPORTS_KEY, []);
    return Array.isArray(r) ? r : [];
  }

  const box = Object.assign({ x: null, y: null, locked: false, expanded: false, sync: false, settingsOpen: false }, loadJson(BOX_KEY, {}));
  const saveBox = () => saveJson(BOX_KEY, box);

  // Einstellungen (ältere Versionen hatten den Notfall-Modus in der Box gespeichert)
  function loadSettings() {
    const s = Object.assign({}, CONFIG.defaults, loadJson(SETTINGS_KEY, {}));
    if (loadJson(SETTINGS_KEY, null) === null && typeof box.emergency === 'boolean') s.emergency = box.emergency;
    return s;
  }
  let settings = loadSettings();
  const saveSettings = () => saveJson(SETTINGS_KEY, settings);

  // ---------------------------------------------------------------------------
  // Texte Deutsch / Englisch
  // ---------------------------------------------------------------------------
  const TEXT = {
    de: {
      locale: 'de-DE',
      headSaved: (n, d) => '🛡 ' + n + (n === 1 ? ' Werbepause · ' : ' Werbepausen · ') + d + ' gespart',
      head: (n) => '🛡 ' + n + (n === 1 ? ' Werbepause blockiert' : ' Werbepausen blockiert'),
      headLocked: 'Doppelklick = Details ein-/ausklappen',
      headDrag: 'Ziehen = verschieben, Doppelklick = Details ein-/ausklappen',
      statTab: 'Dieser Tab',
      statToday: 'Heute',
      statTotal: 'Insgesamt',
      statSavedToday: 'Zeit gespart heute',
      statSavedTotal: 'Zeit gespart insgesamt',
      statLeaked: 'Durchgerutscht',
      lastAd: (time, ch, mode) => 'Letzte Werbepause: ' + time + (ch ? ' bei ' + ch : '') + ' (' + mode + ')',
      noAdYet: 'In diesem Tab noch keine Werbepause.',
      modeBackup: 'Ersatz-Stream',
      modeStripped: 'herausgeschnitten',
      stamp: '⏱ Zeitstempel',
      stampTitle: 'Kopiert einen Zeitstempel (Uhrzeit, Kanal, Methode) in die Zwischenablage – wird nicht gespeichert',
      leak: '⚠ Durchgerutscht',
      leakTitle: 'Speichert die gerade gesehene Werbung im Durchgerutscht-Protokoll (+1)',
      syncOn: 'Sync AN: Ein Klick auf „Zeitstempel“ oder „Durchgerutscht“ löst beide aus – klicken zum Ausschalten',
      syncOff: 'Sync AUS: Buttons arbeiten einzeln – klicken, um beide zu koppeln',
      listTitle: (n) => 'Durchgerutscht – Protokoll (' + n + ')',
      noReports: 'Keine Meldungen.',
      auto: 'automatisch',
      manual: 'manuell',
      copyLog: '📋 Protokoll kopieren',
      clearLeaked: '🗑 Durchgerutscht leeren',
      resetAll: '↺ Zähler zurücksetzen',
      sure: 'Sicher? Nochmal klicken',
      copied: '✓ Kopiert',
      failed: '✗ Fehler',
      saved: '✓ Gespeichert',
      cleared: '✓ Geleert',
      resetDone: '✓ Zurückgesetzt',
      lockOn: 'Gesperrt – klicken zum Entsperren',
      lockOff: 'Verschiebbar – klicken zum Sperren',
      expand: 'Details, Melden & Einstellungen',
      collapse: 'Einklappen',
      emergencyOnTitle: 'Notfall-Modus AN: Rutscht Werbung durch, wird sie stumm und unscharf geschaltet – klicken zum Ausschalten',
      emergencyOffTitle: 'Notfall-Modus AUS – klicken zum Einschalten',
      emergencyOnNotice: 'Notfall-Modus AN: durchgerutschte Werbung wird stumm & unscharf geschaltet',
      emergencyOffNotice: 'Notfall-Modus AUS',
      veil: '🛟 Werbung durchgerutscht – stumm & ausgeblendet',
      leakLoggedEmergency: 'Werbung ist durchgerutscht – stumm & ausgeblendet, automatisch protokolliert',
      leakLogged: 'Werbung ist durchgerutscht – automatisch protokolliert',
      leakEmergency: 'Werbung ist durchgerutscht – stumm & ausgeblendet',
      noticeBackup: 'Werbung erkannt – werbefreier Ersatz-Stream aktiv',
      noticeStripped: 'Werbung wird herausgeschnitten – Bild kann kurz stehen bleiben',
      noticeSaved: (d) => 'Werbepause vorbei – ' + d + ' gespart',
      settings: '⚙ Einstellungen',
      setNotice: 'Hinweise einblenden',
      setCounter: 'Zahlen in der Box anzeigen',
      setCounterHint: 'Aus = nur das 🛡-Symbol',
      setAuto: 'Durchgerutschte Werbung automatisch protokollieren',
      setEmergency: 'Notfall-Modus (stumm & unscharf)',
      setLang: 'Sprache',
      langAuto: 'Automatisch (Browser)',
      stampParts: (date, ch, recent) => [
        'Werbung nicht blockiert', date, 'Kanal: ' + ch,
        recent ? 'letzte Methode: ' + recent.mode + ' (vor ' + recent.ago + ' s)' : 'vom Script keine Werbung erkannt',
      ],
      logHeader: 'Protokoll',
      logSummary: (s) => 'Blockierte Werbepausen insgesamt: ' + s.total + ', Zeit gespart: ' + fmtDur(s.savedTotal) + ', durchgerutscht: ' + s.leaked,
      logAuto: 'automatisch erkannt',
      logManual: 'manuell gemeldet',
      logMethod: 'letzte Methode',
      logNoAd: 'keine Werbung erkannt',
    },
    en: {
      locale: 'en-GB',
      headSaved: (n, d) => '🛡 ' + n + (n === 1 ? ' ad break · ' : ' ad breaks · ') + d + ' saved',
      head: (n) => '🛡 ' + n + (n === 1 ? ' ad break blocked' : ' ad breaks blocked'),
      headLocked: 'Double-click = show/hide details',
      headDrag: 'Drag = move, double-click = show/hide details',
      statTab: 'This tab',
      statToday: 'Today',
      statTotal: 'Total',
      statSavedToday: 'Time saved today',
      statSavedTotal: 'Time saved total',
      statLeaked: 'Slipped through',
      lastAd: (time, ch, mode) => 'Last ad break: ' + time + (ch ? ' on ' + ch : '') + ' (' + mode + ')',
      noAdYet: 'No ad break in this tab yet.',
      modeBackup: 'replacement stream',
      modeStripped: 'cut out',
      stamp: '⏱ Timestamp',
      stampTitle: 'Copies a timestamp (time, channel, method) to the clipboard – nothing is saved',
      leak: '⚠ Slipped through',
      leakTitle: 'Saves the ad you just saw to the slipped-through log (+1)',
      syncOn: 'Sync ON: clicking "Timestamp" or "Slipped through" triggers both – click to turn off',
      syncOff: 'Sync OFF: buttons work independently – click to link them',
      listTitle: (n) => 'Slipped through – log (' + n + ')',
      noReports: 'No reports.',
      auto: 'automatic',
      manual: 'manual',
      copyLog: '📋 Copy log',
      clearLeaked: '🗑 Clear slipped through',
      resetAll: '↺ Reset counters',
      sure: 'Sure? Click again',
      copied: '✓ Copied',
      failed: '✗ Error',
      saved: '✓ Saved',
      cleared: '✓ Cleared',
      resetDone: '✓ Reset',
      lockOn: 'Locked – click to unlock',
      lockOff: 'Movable – click to lock',
      expand: 'Details, reporting & settings',
      collapse: 'Collapse',
      emergencyOnTitle: 'Emergency mode ON: ads that slip through are muted and blurred – click to turn off',
      emergencyOffTitle: 'Emergency mode OFF – click to turn on',
      emergencyOnNotice: 'Emergency mode ON: ads that slip through are muted & blurred',
      emergencyOffNotice: 'Emergency mode OFF',
      veil: '🛟 Ad slipped through – muted & hidden',
      leakLoggedEmergency: 'Ad slipped through – muted & hidden, logged automatically',
      leakLogged: 'Ad slipped through – logged automatically',
      leakEmergency: 'Ad slipped through – muted & hidden',
      noticeBackup: 'Ad detected – ad-free replacement stream active',
      noticeStripped: 'Ad is being cut out – picture may freeze briefly',
      noticeSaved: (d) => 'Ad break over – ' + d + ' saved',
      settings: '⚙ Settings',
      setNotice: 'Show notices',
      setCounter: 'Show numbers in the box',
      setCounterHint: 'Off = only the 🛡 icon',
      setAuto: 'Log ads that slip through automatically',
      setEmergency: 'Emergency mode (mute & blur)',
      setLang: 'Language',
      langAuto: 'Automatic (browser)',
      stampParts: (date, ch, recent) => [
        'Ad not blocked', date, 'Channel: ' + ch,
        recent ? 'last method: ' + recent.mode + ' (' + recent.ago + ' s ago)' : 'no ad detected by the script',
      ],
      logHeader: 'log',
      logSummary: (s) => 'Ad breaks blocked in total: ' + s.total + ', time saved: ' + fmtDur(s.savedTotal) + ', slipped through: ' + s.leaked,
      logAuto: 'detected automatically',
      logManual: 'reported manually',
      logMethod: 'last method',
      logNoAd: 'no ad detected',
    },
  };

  function lang() {
    if (settings.lang === 'de' || settings.lang === 'en') return settings.lang;
    return /^de\b/i.test(navigator.language || '') ? 'de' : 'en';
  }
  const t = (key) => TEXT[lang()][key];

  // Dauer kurz formatieren: 45 s · 12 min · 1 h 13 min
  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + ' s';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return m % 60 ? h + ' h ' + (m % 60) + ' min' : h + ' h';
  }

  const modeText = (mode) => (mode === 'backup' ? t('modeBackup') : mode === 'stripped' ? t('modeStripped') : '?');

  let sessionCount = 0;
  let lastAd = null; // { time, channel, mode } der letzten Werbepause in diesem Tab
  let notice = null;
  let noticeTimer = null;
  let ui = {};

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
    return d.toLocaleDateString(t('locale'), { day: '2-digit', month: '2-digit' }) + ' '
      + d.toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit' });
  }

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
  window.addEventListener('resize', placeCounter);

  function updateEmergency() {
    if (!ui.root) return;
    ui.emergency.classList.toggle('on', !!settings.emergency);
    ui.emergency.title = settings.emergency ? t('emergencyOnTitle') : t('emergencyOffTitle');
    ui.setEmergency.checked = !!settings.emergency;
  }

  function updateLock() {
    ui.root.classList.toggle('locked', !!box.locked);
    ui.lock.textContent = box.locked ? '🔒' : '🔓';
    ui.lock.title = box.locked ? t('lockOn') : t('lockOff');
  }

  function updateExpanded() {
    ui.root.classList.toggle('expanded', !!box.expanded);
    ui.toggle.textContent = box.expanded ? '▴' : '▾';
    ui.toggle.title = box.expanded ? t('collapse') : t('expand');
    ui.settingsWrap.classList.toggle('open', !!box.settingsOpen);
    ui.settingsBtn.textContent = t('settings') + (box.settingsOpen ? ' ▴' : ' ▾');
  }

  function updateSync() {
    ui.sync.classList.toggle('on', !!box.sync);
    ui.reportRow.classList.toggle('synced', !!box.sync);
    ui.sync.title = box.sync ? t('syncOn') : t('syncOff');
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
        btn.textContent = t('sure');
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
      'Twitch Adblock ' + VERSION + ' – ' + t('logHeader'),
      t('logSummary')(s),
      'Browser: ' + navigator.userAgent,
      '',
    ];
    for (const r of loadReports()) {
      lines.push(fmtTime(r.time) + ' | ' + (r.channel || '?') + ' | '
        + (r.auto ? t('logAuto') : t('logManual'))
        + ' | ' + t('logMethod') + ': ' + (r.mode ? modeText(r.mode) : t('logNoAd')));
    }
    return lines.join('\n');
  }

  // Text für eine manuelle Meldung, z. B.
  // "Werbung nicht blockiert – 17.10.2026 16:23:05 – Kanal: xyz – letzte Methode: Ersatz-Stream (vor 40 s) – Script 1.8.0"
  function reportStamp() {
    const now = new Date();
    const recent = lastAd && Date.now() - lastAd.time < 5 * 60 * 1000 ? lastAd : null;
    const date = now.toLocaleDateString(t('locale'), { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' '
      + now.toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = t('stampParts')(
      date,
      currentChannel() || (recent && recent.channel) || '?',
      recent ? { mode: modeText(recent.mode), ago: Math.round((Date.now() - recent.time) / 1000) } : null,
    );
    parts.push('Script ' + VERSION);
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

  function setEmergency(on) {
    settings.emergency = !!on;
    saveSettings();
    updateEmergency();
    if (!settings.emergency) emergencyOff();
    showNotice(settings.emergency ? t('emergencyOnNotice') : t('emergencyOffNotice'), 3000);
  }

  // Einstellungs-Bereich im Panel
  function buildSettings() {
    ui.settingsBtn = el('button', 'ttv-ab-settings-btn');
    ui.settingsWrap = el('div', 'ttv-ab-settings');
    const check = (label, hint, value, onChange) => {
      const row = el('label', 'ttv-ab-setting');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', () => onChange(input.checked));
      const txt = el('span', '', label);
      if (hint) txt.append(el('small', '', hint));
      row.append(input, txt);
      ui.settingsWrap.append(row);
      return input;
    };
    check(t('setNotice'), null, settings.showNotice, (v) => {
      settings.showNotice = v;
      saveSettings();
      if (!v) showNotice(null, 0, true);
    });
    check(t('setCounter'), t('setCounterHint'), settings.showCounter, (v) => {
      settings.showCounter = v;
      saveSettings();
      renderCounter();
    });
    check(t('setAuto'), null, settings.autoDetect, (v) => {
      settings.autoDetect = v;
      saveSettings();
    });
    ui.setEmergency = check(t('setEmergency'), null, settings.emergency, (v) => setEmergency(v));

    const langRow = el('label', 'ttv-ab-setting ttv-ab-lang');
    const select = el('select');
    for (const [val, label] of [['auto', t('langAuto')], ['de', 'Deutsch'], ['en', 'English']]) {
      const o = el('option', '', label);
      o.value = val;
      select.append(o);
    }
    select.value = settings.lang;
    select.addEventListener('change', () => {
      settings.lang = select.value;
      saveSettings();
      rebuildCounter();
    });
    langRow.append(el('span', '', t('setLang')), select);
    ui.settingsWrap.append(langRow);

    ui.settingsBtn.addEventListener('click', () => {
      box.settingsOpen = !box.settingsOpen;
      saveBox();
      renderCounter();
    });
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
    ui.vTab = row(t('statTab'));
    ui.vToday = row(t('statToday'));
    ui.vTotal = row(t('statTotal'));
    ui.vSavedToday = row(t('statSavedToday'), 'good');
    ui.vSavedTotal = row(t('statSavedTotal'), 'good');
    ui.vLeaked = row(t('statLeaked'), 'bad');
    ui.last = el('div', 'ttv-ab-muted');
    // Melde-Zeile: [Zeitstempel] [Durchgerutscht] [Sync]
    ui.reportRow = el('div', 'ttv-ab-reportrow');
    ui.stamp = el('button', 'ttv-ab-stamp', t('stamp'));
    ui.stamp.title = t('stampTitle');
    ui.leak = el('button', 'ttv-ab-leak', t('leak'));
    ui.leak.title = t('leakTitle');
    ui.sync = el('button', 'ttv-ab-sync', '🔗');
    ui.reportRow.append(ui.stamp, ui.leak, ui.sync);
    ui.listTitle = el('h4');
    ui.list = el('ul');
    const actions = el('div', 'ttv-ab-actions');
    ui.copy = el('button', '', t('copyLog'));
    ui.clear = el('button', '', t('clearLeaked'));
    ui.reset = el('button', '', t('resetAll'));
    actions.append(ui.copy, ui.clear, ui.reset);
    buildSettings();
    ui.panel.append(stats, ui.last, ui.reportRow, ui.listTitle, ui.list, actions, ui.settingsBtn, ui.settingsWrap);

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
      renderCounter();
    });
    ui.emergency.addEventListener('click', () => setEmergency(!settings.emergency));
    // Zeitstempel: nur in die Zwischenablage, nichts speichern
    async function doStamp() {
      const ok = await copyText(reportStamp());
      flashButton(ui.stamp, ok ? t('copied') : t('failed'));
    }
    // Durchgerutscht: im Protokoll speichern und Zähler +1
    function doLeak() {
      addReport(false);
      flashButton(ui.leak, t('saved'));
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
      flashButton(ui.copy, (await copyText(reportsAsText())) ? t('copied') : t('failed'));
    });
    confirmClick(ui.clear, () => {
      saveJson(REPORTS_KEY, []);
      const s = loadStats();
      s.leaked = 0;
      saveStats(s);
      renderCounter();
      flashButton(ui.clear, t('cleared'));
    });
    confirmClick(ui.reset, () => {
      saveStats({ total: 0, today: 0, leaked: 0, savedTotal: 0, savedToday: 0, day: today() });
      sessionCount = 0;
      renderCounter();
      flashButton(ui.reset, t('resetDone'));
    });

    updateLock();
    updateEmergency();
    makeDraggable();
  }

  // Box komplett neu aufbauen (z. B. nach Sprachwechsel)
  function rebuildCounter() {
    if (ui.root) ui.root.remove();
    ui = {};
    renderCounter();
  }

  function renderCounter() {
    if (!document.body) return;
    if (!ui.root) buildCounter();
    const s = loadStats();
    ui.text.textContent = !settings.showCounter
      ? '🛡'
      : s.savedTotal > 0 ? t('headSaved')(s.total, fmtDur(s.savedTotal)) : t('head')(s.total);
    ui.head.title = box.locked ? t('headLocked') : t('headDrag');
    updateExpanded();

    if (box.expanded) {
      ui.vTab.textContent = String(sessionCount);
      ui.vToday.textContent = String(s.today);
      ui.vTotal.textContent = String(s.total);
      ui.vSavedToday.textContent = fmtDur(s.savedToday);
      ui.vSavedTotal.textContent = fmtDur(s.savedTotal);
      ui.vLeaked.textContent = String(s.leaked);
      ui.last.textContent = lastAd
        ? t('lastAd')(fmtTime(lastAd.time), lastAd.channel, modeText(lastAd.mode))
        : t('noAdYet');

      const reports = loadReports();
      ui.list.replaceChildren();
      if (!reports.length) {
        ui.list.append(el('li', 'ttv-ab-muted', t('noReports')));
      } else {
        for (const r of reports.slice(0, 20)) {
          ui.list.append(el('li', '', fmtTime(r.time) + ' · ' + (r.channel || '?')
            + (r.mode ? ' · ' + modeText(r.mode) : '') + ' · ' + (r.auto ? t('auto') : t('manual'))));
        }
      }
      ui.listTitle.textContent = t('listTitle')(reports.length);
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

  function addSavedTime(seconds) {
    if (!(seconds > 0)) return;
    const s = loadStats();
    s.savedTotal += seconds;
    s.savedToday += seconds;
    saveStats(s);
    renderCounter();
  }

  // Durchgerutschte Werbung speichern (manuell oder automatisch erkannt)
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
  // Box aktualisieren, wenn ein anderer Twitch-Tab gezählt, gemeldet oder umgestellt hat
  window.addEventListener('storage', (e) => {
    if (e.key === STATS_KEY || e.key === REPORTS_KEY) renderCounter();
    if (e.key === SETTINGS_KEY) {
      settings = loadSettings();
      if (!settings.emergency) emergencyOff();
      rebuildCounter();
    }
  });

  // Erkennung durchgerutschter Werbung: Zeigt Twitch seine eigene Werbe-Anzeige
  // (Label/Countdown), hat der Player Werbung erkannt, die nicht entfernt wurde.
  const AD_UI_SELECTOR = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]';
  let lastLeak = 0;

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
        host.appendChild(el('div', 'ttv-ab-veil', t('veil')));
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

    if (adVisible && settings.emergency) emergencyOn();
    else if (emergency.active) emergencyOff();

    // pro durchgerutschter Werbepause nur einmal melden
    if (!adVisible || Date.now() - lastLeak < 90 * 1000) return;
    if (!settings.autoDetect && !settings.emergency) return;
    lastLeak = Date.now();
    if (settings.autoDetect) addReport(true);
    showNotice(settings.autoDetect
      ? (settings.emergency ? t('leakLoggedEmergency') : t('leakLogged'))
      : t('leakEmergency'), 6000);
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

  function showNotice(text, autoHideMs, force) {
    if ((!settings.showNotice && !force) || !document.body) return;
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
        showNotice(msg.mode === 'backup' ? t('noticeBackup') : t('noticeStripped'));
        if (box.expanded) renderCounter();
      } else if (msg.type === 'ad-end') {
        addSavedTime(msg.seconds);
        if (msg.seconds > 0) showNotice(t('noticeSaved')(fmtDur(msg.seconds)), 4000);
        else showNotice(null);
      }
    };
  }
})();
