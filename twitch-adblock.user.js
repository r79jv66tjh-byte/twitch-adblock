// ==UserScript==
// @name         Twitch Adblock (Stream + Banner)
// @namespace    local.twitch-adblock
// @version      2.0.2
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
      devMode: false,    // Werkzeuge zur Fehlersuche im Panel anzeigen
      autoRecover: true, // hängendes Bild automatisch reparieren
      shortcuts: true,   // Alt+W = Durchgerutscht, Alt+Z = Zeitstempel
      updateCheck: true, // einmal am Tag auf GitHub nach Updates suchen
      hideTurbo: false,  // Turbo-Werbung ausblenden
      hidePrime: false,  // Prime-Gaming-Banner ausblenden
      stopFrontpage: false, // automatisch startendes Video auf der Startseite stoppen
      vod: false,        // Werbung in Aufzeichnungen filtern (experimentell)
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
    // Ereignis fürs Protokoll (Texte übersetzt die Hauptseite anhand des Codes)
    const log = (level, code, data) => notify(Object.assign({ type: 'log', level, code }, data));
    const loggedThisBreak = new Set();
    const logOnce = (key, level, code, data) => {
      if (loggedThisBreak.has(key)) return;
      loggedThisBreak.add(key);
      log(level, code, data);
    };
    let lastMediaFailLog = 0;

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

    // Gesparte Zeit der Pause: Summe der Spot-Längen, mindestens aber die gemessene Dauer (max. 10 min)
    function adBreakSeconds() {
      let sum = 0;
      for (const d of adSpots.values()) sum += d;
      sum = Math.max(sum, (Date.now() - adStart) / 1000);
      return Math.round(Math.min(sum, 600));
    }

    // Stream-Liste („usher“): alte und neue Adressform, z. B. /api/channel/hls/ und /api/v2/channel/hls/
    const USHER_RE = /usher\.ttvnw\.net(\/api\/(?:v\d+\/)?channel\/hls\/)/;
    let usherPath = '/api/channel/hls/';
    let lastChannel = null;

    // Für das Protokoll: einmalig festhalten, welche Playlist-Adressen der Player nutzt (ohne Zugangsdaten)
    const seenKinds = new Set();
    function logPlaylistSeen(kind, url) {
      if (seenKinds.has(kind)) return;
      seenKinds.add(kind);
      let safe = url;
      try {
        const u = new URL(url);
        safe = u.host + u.pathname.split('/').map((p) => (p.length > 24 ? p.slice(0, 8) + '…' : p)).join('/');
      } catch (e) { safe = String(url).split('?')[0].slice(0, 80); }
      log('info', 'playlistSeen', { kind, url: safe });
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
      if (!info.res) return variants[0]; // Auflösung unbekannt: beste Qualität (steht bei Twitch zuerst)
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

    // VODs: Inhalts-Segmente haben keinen Titel, Werbe-Segmente einen (z. B. „Amazon“)
    function stripVodAds(text) {
      const lines = text.split('\n');
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const title = line.startsWith('#EXTINF') ? (line.split(',')[1] || '').trim() : '';
        if (title && title !== 'live') {
          while (i + 1 < lines.length && lines[i + 1].startsWith('#') && !lines[i + 1].startsWith('#EXTINF')) i++;
          if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) i++;
          continue;
        }
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
        if (!r.ok) { log('warn', 'gqlFail', { playerType, status: r.status }); return null; }
        const json = await r.json();
        const tok = json && json.data && json.data.streamPlaybackAccessToken;
        if (!tok || !tok.value) {
          const auth = tok && tok.authorization;
          log('warn', 'gqlNoToken', { playerType, reason: (auth && auth.forbiddenReasonCode) || (json && json.errors && json.errors[0] && json.errors[0].message) || '' });
          return null;
        }
        const params = new URLSearchParams({
          allow_source: 'true', allow_audio_only: 'true', fast_bread: 'true',
          p: String(Math.floor(Math.random() * 1e7)), player_backend: 'mediaplayer',
          playlist_include_framerate: 'true', reassignments_supported: 'true',
          sig: tok.signature, supported_codecs: 'avc1', token: tok.value,
          transcode_mode: 'cbr_v1', cdm: 'wv',
        });
        const master = await realFetch('https://usher.ttvnw.net' + usherPath + encodeURIComponent(channel) + '.m3u8?' + params);
        if (!master.ok) { log('warn', 'backupUsherFail', { playerType, status: master.status }); return null; }
        return { variants: parseMaster(await master.text(), master.url), time: Date.now(), hasAds: false };
      } catch (e) {
        log('warn', 'backupError', { playerType, message: String((e && e.message) || e) });
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
          if (hasAds(text)) {
            entry.hasAds = true;
            logOnce('backupHasAds|' + playerType, 'info', 'backupHasAds', { playerType });
            continue;
          }
          logOnce('backupOk|' + playerType, 'info', 'backupOk', { playerType });
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

    async function handleFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);

      // Master-Playlist: Kanal und Auflösungen der Varianten merken
      const usher = url.match(USHER_RE);
      if (usher) {
        usherPath = usher[1];
        logPlaylistSeen('master', url);
        const m = url.match(/\/hls\/([^/.?]+)\.m3u8/);
        const channel = m ? decodeURIComponent(m[1]).toLowerCase() : null;
        const res = await realFetch(input, init);
        if (!res.ok) {
          // 404 = Twitch meldet den Kanal als offline, 403 = Zugriff verweigert
          log('error', 'usherFail', { channel, status: res.status });
          return res;
        }
        const text = await res.text();
        const variants = parseMaster(text, url);
        for (const v of variants) {
          const info = { channel, res: v.res, fps: v.fps };
          streams.set(v.url, info);
          streams.set(v.url.split('?')[0], info);
        }
        lastChannel = channel;
        log('info', 'usherOk', { channel, variants: variants.length });
        return rebuild(res, text);
      }

      // Media-Playlist: auf Werbung prüfen
      if (url.includes('.m3u8') && (streams.has(url) || url.includes('ttvnw.net'))) {
        logPlaylistSeen('media', url);
        const res = await realFetch(input, init);
        if (!res.ok) {
          if (Date.now() - lastMediaFailLog > 60 * 1000) {
            lastMediaFailLog = Date.now();
            log('warn', 'mediaFail', { status: res.status });
          }
          return res;
        }
        let text = await res.text();
        if (hasAds(text)) {
          if (!adActive) {
            adActive = true;
            adStart = Date.now();
            adSpots.clear();
            loggedThisBreak.clear();
            notify({ type: 'ad-start' });
          }
          collectAdSpots(text);
          // Playlist-Adresse nicht exakt bekannt? Dann den zuletzt geladenen Kanal nehmen
          const info = streams.get(url) || streams.get(url.split('?')[0])
            || (lastChannel ? { channel: lastChannel, res: null, fps: 0 } : null);
          if (info && !streams.has(url)) logOnce('mediaUnmatched', 'info', 'mediaUnmatched', { channel: info.channel });
          const replacement = info && info.channel ? await getBackupPlaylist(info) : null;
          if (replacement === null) logOnce('stripped', 'info', 'stripped', {});
          text = replacement !== null ? replacement : stripAds(text);
          notify({ type: 'ad', mode: replacement !== null ? 'backup' : 'stripped', channel: info ? info.channel : null });
        } else if (adActive) {
          adActive = false;
          backupCache.clear();
          notify({ type: 'ad-end', seconds: adBreakSeconds() });
        }
        return rebuild(res, text);
      }

      // Aufzeichnungen (VODs), experimentell: eingebettete Werbung herausschneiden
      if (cfg.vod && url.includes('.m3u8') && !url.includes('usher.ttvnw.net')) {
        const res = await realFetch(input, init);
        if (!res.ok) return res;
        const text = await res.text();
        if (!hasAds(text)) return rebuild(res, text);
        logOnce('vodAd', 'info', 'vodAd', {});
        return rebuild(res, stripVodAds(text));
      }

      return realFetch(input, init);
    }

    // Absicherung: Wirft unser Code einen Fehler, lädt der Stream ganz normal (ohne Filter)
    self.fetch = async function (input, init) {
      try {
        return await handleFetch(input, init);
      } catch (e) {
        log('error', 'exception', { message: String((e && e.message) || e) });
        return realFetch(input, init);
      }
    };

    log('info', 'workerReady', {});
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
      let readError = null;
      if (url.startsWith('blob:')) {
        try { src = readBlobSync(url); } catch (e) { readError = String((e && e.message) || e); }
      }
      if (!src || !/wasmworker|amazon-ivs/i.test(src)) {
        if (readError) logEvent('warn', 'workerUnreadable', { message: readError });
        super(scriptURL, options);
        return;
      }
      // VOD-Filter ist eine Einstellung – gilt für neu gestartete Player
      let vod = false;
      try { vod = !!settings.vod; } catch (e) { /* Einstellungen noch nicht geladen */ }
      const cfg = Object.assign({}, CONFIG, { vod });
      const code = '(' + workerMain.toString() + ')(' + JSON.stringify(cfg) + ');\n' + src;
      super(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })), options);
      logEvent('info', 'workerPatched', {});
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
    #ttv-adblock-counter.expanded { width: 330px; border-radius: 10px; }
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
    #ttv-adblock-counter.expanded .ttv-ab-panel { display: block; max-height: calc(100vh - 48px); overflow-y: auto; overscroll-behavior: contain; }
    #ttv-adblock-counter .ttv-ab-stats {
      display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 6px 0;
    }
    #ttv-adblock-counter .ttv-ab-stats b { font-weight: 600; text-align: right; color: #bf94ff; }
    #ttv-adblock-counter .ttv-ab-stats b.bad { color: #ff8a8a; }
    #ttv-adblock-counter .ttv-ab-stats b.good { color: #5fe0a5; }
    #ttv-adblock-counter .ttv-ab-issue:empty { display: none; }
    #ttv-adblock-counter .ttv-ab-issue {
      margin: 6px 0; padding: 5px 7px; border-radius: 6px; font-size: 11px;
      background: rgba(255, 180, 0, 0.12); color: #ffd37a; border: 1px solid rgba(255, 180, 0, 0.35);
    }
    #ttv-adblock-counter .ttv-ab-issue.error { background: rgba(235, 4, 0, 0.15); color: #ffb3b3; border-color: rgba(255, 90, 90, 0.5); }
    #ttv-adblock-counter button[hidden] { display: none !important; }
    #ttv-adblock-counter:not(.dev) .ttv-ab-dev { display: none !important; }
    #ttv-adblock-counter:not(.dev) .ttv-ab-reportrow { grid-template-columns: 1fr; }
    #ttv-adblock-counter .ttv-ab-update { color: #5fe0a5; font-weight: 700; background: rgba(0, 200, 120, 0.2); }
    #ttv-adblock-counter .ttv-ab-devbtn { background: rgba(255, 180, 0, 0.18); }
    #ttv-adblock-counter .ttv-ab-wide {
      display: block; width: 100%; box-sizing: border-box; margin-top: 8px; padding: 5px 7px;
      font-size: 11px; font-weight: 600; color: #adadb8; background: rgba(255, 255, 255, 0.05);
    }
    #ttv-adblock-counter .ttv-ab-wide:hover { background: rgba(255, 255, 255, 0.12); color: #efeff1; }
    #ttv-adblock-counter .ttv-ab-fold { display: none; padding: 4px 2px 0; }
    #ttv-adblock-counter .ttv-ab-fold.open { display: block; }
    #ttv-adblock-counter .ttv-ab-chart { display: flex; gap: 4px; align-items: flex-end; height: 74px; margin: 4px 0 6px; }
    #ttv-adblock-counter .ttv-ab-bar { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; height: 100%; }
    #ttv-adblock-counter .ttv-ab-bar b { font-size: 10px; color: #bf94ff; }
    #ttv-adblock-counter .ttv-ab-bar small { font-size: 10px; color: #adadb8; }
    #ttv-adblock-counter .ttv-ab-barbox { flex: 1; width: 100%; display: flex; align-items: flex-end; background: rgba(255, 255, 255, 0.04); border-radius: 3px; }
    #ttv-adblock-counter .ttv-ab-barbox i { display: block; width: 100%; min-height: 1px; background: #9146ff; border-radius: 3px; }
    #ttv-adblock-counter .ttv-ab-events { max-height: 160px; }
    #ttv-adblock-counter .ttv-ab-events li.lvl-warn { color: #ffd37a; }
    #ttv-adblock-counter .ttv-ab-events li.lvl-error { color: #ffb3b3; }
    #ttv-adblock-counter .ttv-ab-footer { margin-top: 8px; font-size: 10px; color: #adadb8; text-align: center; }
    #ttv-adblock-counter .ttv-ab-footer a { color: #bf94ff; text-decoration: none; }
    #ttv-adblock-counter .ttv-ab-footer a:hover { text-decoration: underline; }
    html.ttv-ab-hide-turbo a[href*="/turbo"],
    html.ttv-ab-hide-turbo [data-a-target*="turbo"],
    html.ttv-ab-hide-turbo button[aria-label*="Turbo"],
    html.ttv-ab-hide-prime [data-a-target="prime-offers-icon"],
    html.ttv-ab-hide-prime .top-nav__prime,
    html.ttv-ab-hide-prime a[href*="gaming.amazon.com"],
    html.ttv-ab-hide-prime a[href*="primegaming"] {
      display: none !important;
    }
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
    .ttv-ab-adui { visibility: hidden !important; }
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
  // Zähler-Box mit Panel, Melde-Funktion, Statistik und Einstellungen
  // (alles im localStorage von twitch.tv gespeichert)
  // ---------------------------------------------------------------------------
  const VERSION = '2.0.2';
  const REPO_URL = 'https://github.com/r79jv66tjh-byte/twitch-adblock';
  const RAW_URL = 'https://raw.githubusercontent.com/r79jv66tjh-byte/twitch-adblock/main/twitch-adblock.user.js';
  const ISSUE_URL = REPO_URL + '/issues/new?template=bug_report.yml';
  const CHANGELOG_URL = REPO_URL + '/blob/main/CHANGELOG.md';

  const STATS_KEY = 'ttvAdblockStats';
  const BOX_KEY = 'ttvAdblockCounterBox';
  const REPORTS_KEY = 'ttvAdblockReports';
  const SETTINGS_KEY = 'ttvAdblockSettings';
  const EVENTS_KEY = 'ttvAdblockEvents';
  const UPDATE_KEY = 'ttvAdblockUpdate';
  const SEEN_KEY = 'ttvAdblockSeenVersion';
  const RELOAD_KEY = 'ttvAdblockLastReload';
  const MAX_REPORTS = 100;
  const MAX_EVENTS = 200;

  // Kurzinfo „Was ist neu“ zur aktuellen Version
  const WHATS_NEW = {
    de: 'Ersatz-Stream funktioniert wieder mit Twitchs neuer Stream-Adresse, genauere „Zeit gespart“, bessere Diagnose',
    en: 'replacement stream works again with Twitch\'s new stream address, more accurate "time saved", better diagnostics',
  };

  // Datum in Ortszeit (für „Heute“ und den Verlauf)
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const today = () => dayKey();

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
    if (!s.days || typeof s.days !== 'object') s.days = {};         // Tag -> { ads, saved }
    if (!s.channels || typeof s.channels !== 'object') s.channels = {}; // Kanal -> { ads, saved, leaked }
    if (s.day !== today()) { s.day = today(); s.today = 0; s.savedToday = 0; }
    return s;
  }
  function saveStats(s) {
    // Verlauf auf 30 Tage begrenzen
    const keys = Object.keys(s.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete s.days[k];
    saveJson(STATS_KEY, s);
  }
  const emptyStats = () => ({ total: 0, today: 0, leaked: 0, savedTotal: 0, savedToday: 0, day: today(), days: {}, channels: {} });

  function bump(s, channel, field, amount) {
    const d = s.days[today()] || (s.days[today()] = { ads: 0, saved: 0 });
    if (field !== 'leaked') d[field] = (d[field] || 0) + amount;
    if (channel) {
      const c = s.channels[channel] || (s.channels[channel] = { ads: 0, saved: 0, leaked: 0 });
      c[field] = (c[field] || 0) + amount;
    }
  }

  function loadReports() {
    const r = loadJson(REPORTS_KEY, []);
    return Array.isArray(r) ? r : [];
  }

  const box = Object.assign({ x: null, y: null, locked: false, expanded: false, sync: false, settingsOpen: false, statsOpen: false }, loadJson(BOX_KEY, {}));
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
      stampTitle: 'Kopiert einen Zeitstempel (Uhrzeit, Kanal, Methode) in die Zwischenablage – wird nicht gespeichert (Alt+Z)',
      leak: '⚠ Durchgerutscht',
      leakTitle: 'Speichert die gerade gesehene Werbung im Durchgerutscht-Protokoll (+1) (Alt+W)',
      syncOn: 'Sync AN: Ein Klick auf „Zeitstempel“ oder „Durchgerutscht“ löst beide aus – klicken zum Ausschalten',
      syncOff: 'Sync AUS: Buttons arbeiten einzeln – klicken, um beide zu koppeln',
      listTitle: (n) => 'Durchgerutscht – Protokoll (' + n + ')',
      noReports: 'Keine Meldungen.',
      eventsTitle: 'Ereignisse',
      noEvents: 'Noch keine Ereignisse.',
      auto: 'automatisch',
      manual: 'manuell',
      copyLog: '📋 Protokoll kopieren',
      clearLeaked: '🗑 Durchgerutscht leeren',
      resetAll: '↺ Zähler zurücksetzen',
      reportBug: '🐞 Fehler melden',
      reportBugTitle: 'Kopiert das Protokoll und öffnet das Fehler-Formular auf GitHub',
      reportCopied: 'Protokoll kopiert – im GitHub-Formular unter „Protokoll“ mit Strg+V einfügen',
      reportCopyFailed: 'Kopieren fehlgeschlagen – bitte im Dev-Modus „Protokoll kopieren“ nutzen',
      checkUpdate: '🔄 Nach Updates suchen',
      upToDate: '✓ Aktuell',
      updateAvail: (v) => '⬆ Update ' + v + ' verfügbar – klicken zum Installieren',
      updateOpened: 'Update-Seite geöffnet – in Tampermonkey auf „Aktualisieren“ klicken',
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
      devTitle: '🛠 Dev-Modus aktiv – klicken zum Ausschalten',
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
      noticeRecover: 'Bild hängt – wird repariert …',
      noticeReload: 'Bild hängt weiterhin – Seite wird neu geladen …',
      whatsNew: (v, txt) => 'Aktualisiert auf ' + v + ' – Neu: ' + txt,
      whatsNewLink: 'Was ist neu?',
      version: (v) => 'Twitch Adblock v' + v,
      statsBtn: '📊 Verlauf & Kanäle',
      last7: 'Letzte 7 Tage (Werbepausen)',
      topChannels: 'Kanäle mit der meisten Werbung',
      noData: 'Noch keine Daten.',
      chanLine: (c) => c.ads + ' Pausen · ' + fmtDur(c.saved) + (c.leaked ? ' · ' + c.leaked + ' durchgerutscht' : ''),
      dayTitle: (d, ads, saved) => d + ': ' + ads + ' Werbepausen, ' + fmtDur(saved) + ' gespart',
      settings: '⚙ Einstellungen',
      groupView: 'Anzeige',
      groupBlock: 'Blocker',
      groupExtra: 'Extras',
      setNotice: 'Hinweise einblenden',
      setCounter: 'Zahlen in der Box anzeigen',
      setCounterHint: 'Aus = nur das 🛡-Symbol',
      setDev: '🛠 Dev-Modus',
      setDevHint: 'Zeigt Werkzeuge zur Fehlersuche: Ereignisse, Protokoll, Zeitstempel, Zurücksetzen',
      setAuto: 'Durchgerutschte Werbung automatisch protokollieren',
      setEmergency: 'Notfall-Modus (stumm & unscharf)',
      setRecover: 'Hängendes Bild automatisch reparieren',
      setRecoverHint: 'Springt zum Live-Bild, startet den Player neu, notfalls Seite neu laden (max. alle 5 min)',
      setVod: 'Werbung in Aufzeichnungen (VODs) filtern',
      setVodHint: 'Experimentell – wirkt nach dem Neuladen der Seite',
      setShortcuts: 'Tastenkürzel',
      setShortcutsHint: 'Alt+W = Durchgerutscht, Alt+Z = Zeitstempel',
      setUpdate: 'Täglich nach Updates suchen',
      setHideTurbo: 'Turbo-Werbung ausblenden',
      setHidePrime: 'Prime-Gaming-Banner ausblenden',
      setStopFront: 'Video auf der Startseite stoppen',
      setLang: 'Sprache',
      langAuto: 'Automatisch (Browser)',
      exportBtn: '💾 Sichern',
      exportTitle: 'Zähler, Verlauf, Einstellungen und Protokoll als Datei speichern',
      importBtn: '📂 Wiederherstellen',
      importTitle: 'Eine zuvor gesicherte Datei laden',
      imported: '✓ Wiederhergestellt',
      importFailed: '✗ Ungültige Datei',
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
      logPage: 'Seite',
      logLang: 'Sprache',
      logSettings: 'Einstellungen',
      logWorker: 'Video-Worker in diesem Tab verbunden',
      logLatest: 'Neueste Version laut GitHub',
      yes: 'ja',
      no: 'nein',
      on: 'an',
      off: 'aus',
      unknown: 'unbekannt',
      logEvents: 'Ereignisse (neueste zuerst)',
      logLeaks: 'Durchgerutscht',
      lastIssue: 'Letztes Problem',
      level: { info: 'INFO', warn: 'WARNUNG', error: 'FEHLER' },
      ev: {
        start: (d) => 'Script ' + d.version + ' gestartet',
        updated: (d) => 'Aktualisiert von ' + d.from + ' auf ' + d.to,
        workerPatched: () => 'Video-Worker von Twitch übernommen',
        workerReady: () => 'Video-Worker verbunden – Stream-Werbung wird gefiltert',
        workerUnreadable: (d) => 'Video-Worker konnte nicht gelesen werden – Stream-Werbung wird NICHT gefiltert (' + d.message + ')',
        noWorker: () => 'Kein Video-Worker erkannt – Twitch hat evtl. etwas geändert, Stream-Werbung wird nicht gefiltert',
        usherOk: (d) => 'Stream geladen: ' + d.channel + ' (' + d.variants + ' Qualitäten)',
        usherFail: (d) => d.status === 404
          ? 'Twitch meldet ' + d.channel + ' als OFFLINE (HTTP 404) – Twitch selbst liefert keinen Stream'
          : d.status === 403
            ? 'Twitch verweigert den Stream von ' + d.channel + ' (HTTP 403) – z. B. Region, Abo-only oder Anmeldung'
            : 'Stream-Liste für ' + d.channel + ' fehlgeschlagen (HTTP ' + d.status + ')',
        mediaFail: (d) => 'Stream-Abschnitt konnte nicht geladen werden (HTTP ' + d.status + ')',
        gqlFail: (d) => 'Ersatz-Stream (' + d.playerType + '): Anfrage bei Twitch fehlgeschlagen (HTTP ' + d.status + ')',
        gqlNoToken: (d) => 'Ersatz-Stream (' + d.playerType + '): kein Zugang von Twitch' + (d.reason ? ' (' + d.reason + ')' : ''),
        backupUsherFail: (d) => 'Ersatz-Stream (' + d.playerType + '): Stream-Liste fehlgeschlagen (HTTP ' + d.status + ')',
        backupError: (d) => 'Ersatz-Stream (' + d.playerType + '): Fehler – ' + d.message,
        backupHasAds: (d) => 'Ersatz-Stream (' + d.playerType + ') hat ebenfalls Werbung',
        backupOk: (d) => 'Werbefreier Ersatz-Stream aktiv (' + d.playerType + ')',
        stripped: () => 'Kein werbefreier Ersatz-Stream – Werbung wird herausgeschnitten',
        vodAd: () => 'Werbung in Aufzeichnung (VOD) herausgeschnitten',
        playlistSeen: (d) => 'Player nutzt ' + (d.kind === 'master' ? 'Stream-Liste' : 'Playlist') + ': ' + d.url,
        mediaUnmatched: (d) => 'Playlist-Adresse nicht zugeordnet – nutze zuletzt geladenen Kanal ' + d.channel,
        exception: (d) => 'Fehler im Script, Stream lädt ohne Filter weiter: ' + d.message,
        adBreak: (d) => 'Werbepause blockiert (' + modeText(d.mode) + (d.seconds ? ', ' + fmtDur(d.seconds) + ' gespart' : '') + ')',
        leakAuto: () => 'Werbung durchgerutscht (von Twitch angezeigt)',
        leakManual: () => 'Werbung durchgerutscht (manuell gemeldet)',
        videoError: (d) => 'Video-Fehler im Player (Code ' + d.code + ')' + (d.message ? ': ' + d.message : ''),
        playerError: (d) => 'Twitch-Player zeigt Fehler: ' + d.text,
        freeze: (d) => 'Bild hängt seit ' + d.seconds + ' s',
        recoverSeek: () => 'Reparatur 1: zum Live-Bild gesprungen',
        recoverPlay: () => 'Reparatur 2: Player neu gestartet (Pause/Play)',
        recoverReload: () => 'Reparatur 3: Seite wird neu geladen',
        recoverSkipReload: () => 'Bild hängt weiter – Neuladen übersprungen (erst vor kurzem neu geladen)',
        recovered: () => 'Bild läuft wieder',
        updateAvailable: (d) => 'Update verfügbar: ' + d.version,
        updateCheckFailed: (d) => 'Update-Prüfung fehlgeschlagen (' + d.message + ')',
        imported: () => 'Sicherung wiederhergestellt',
      },
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
      stampTitle: 'Copies a timestamp (time, channel, method) to the clipboard – nothing is saved (Alt+Z)',
      leak: '⚠ Slipped through',
      leakTitle: 'Saves the ad you just saw to the slipped-through log (+1) (Alt+W)',
      syncOn: 'Sync ON: clicking "Timestamp" or "Slipped through" triggers both – click to turn off',
      syncOff: 'Sync OFF: buttons work independently – click to link them',
      listTitle: (n) => 'Slipped through – log (' + n + ')',
      noReports: 'No reports.',
      eventsTitle: 'Events',
      noEvents: 'No events yet.',
      auto: 'automatic',
      manual: 'manual',
      copyLog: '📋 Copy log',
      clearLeaked: '🗑 Clear slipped through',
      resetAll: '↺ Reset counters',
      reportBug: '🐞 Report a problem',
      reportBugTitle: 'Copies the log and opens the bug report form on GitHub',
      reportCopied: 'Log copied – paste it with Ctrl+V into the "Log" field of the GitHub form',
      reportCopyFailed: 'Copying failed – please use "Copy log" in dev mode',
      checkUpdate: '🔄 Check for updates',
      upToDate: '✓ Up to date',
      updateAvail: (v) => '⬆ Update ' + v + ' available – click to install',
      updateOpened: 'Update page opened – click "Update" in Tampermonkey',
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
      devTitle: '🛠 Dev mode active – click to turn off',
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
      noticeRecover: 'Picture frozen – repairing …',
      noticeReload: 'Picture still frozen – reloading the page …',
      whatsNew: (v, txt) => 'Updated to ' + v + ' – new: ' + txt,
      whatsNewLink: "What's new?",
      version: (v) => 'Twitch Adblock v' + v,
      statsBtn: '📊 History & channels',
      last7: 'Last 7 days (ad breaks)',
      topChannels: 'Channels with the most ads',
      noData: 'No data yet.',
      chanLine: (c) => c.ads + ' breaks · ' + fmtDur(c.saved) + (c.leaked ? ' · ' + c.leaked + ' slipped through' : ''),
      dayTitle: (d, ads, saved) => d + ': ' + ads + ' ad breaks, ' + fmtDur(saved) + ' saved',
      settings: '⚙ Settings',
      groupView: 'Display',
      groupBlock: 'Blocker',
      groupExtra: 'Extras',
      setNotice: 'Show notices',
      setCounter: 'Show numbers in the box',
      setCounterHint: 'Off = only the 🛡 icon',
      setDev: '🛠 Dev mode',
      setDevHint: 'Shows troubleshooting tools: events, log, timestamp, reset',
      setAuto: 'Log ads that slip through automatically',
      setEmergency: 'Emergency mode (mute & blur)',
      setRecover: 'Repair frozen picture automatically',
      setRecoverHint: 'Jumps to the live picture, restarts the player, reloads the page if needed (max. every 5 min)',
      setVod: 'Filter ads in recordings (VODs)',
      setVodHint: 'Experimental – takes effect after reloading the page',
      setShortcuts: 'Keyboard shortcuts',
      setShortcutsHint: 'Alt+W = slipped through, Alt+Z = timestamp',
      setUpdate: 'Check for updates daily',
      setHideTurbo: 'Hide Turbo ads',
      setHidePrime: 'Hide Prime Gaming banners',
      setStopFront: 'Stop the video on the front page',
      setLang: 'Language',
      langAuto: 'Automatic (browser)',
      exportBtn: '💾 Back up',
      exportTitle: 'Save counters, history, settings and log to a file',
      importBtn: '📂 Restore',
      importTitle: 'Load a previously saved file',
      imported: '✓ Restored',
      importFailed: '✗ Invalid file',
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
      logPage: 'Page',
      logLang: 'Language',
      logSettings: 'Settings',
      logWorker: 'Video worker connected in this tab',
      logLatest: 'Latest version on GitHub',
      yes: 'yes',
      no: 'no',
      on: 'on',
      off: 'off',
      unknown: 'unknown',
      logEvents: 'Events (newest first)',
      logLeaks: 'Slipped through',
      lastIssue: 'Last problem',
      level: { info: 'INFO', warn: 'WARNING', error: 'ERROR' },
      ev: {
        start: (d) => 'Script ' + d.version + ' started',
        updated: (d) => 'Updated from ' + d.from + ' to ' + d.to,
        workerPatched: () => 'Took over Twitch video worker',
        workerReady: () => 'Video worker connected – stream ads are filtered',
        workerUnreadable: (d) => 'Could not read video worker – stream ads are NOT filtered (' + d.message + ')',
        noWorker: () => 'No video worker detected – Twitch may have changed something, stream ads are not filtered',
        usherOk: (d) => 'Stream loaded: ' + d.channel + ' (' + d.variants + ' qualities)',
        usherFail: (d) => d.status === 404
          ? 'Twitch reports ' + d.channel + ' as OFFLINE (HTTP 404) – Twitch itself delivers no stream'
          : d.status === 403
            ? 'Twitch denies the stream of ' + d.channel + ' (HTTP 403) – e.g. region, sub-only or login'
            : 'Stream list for ' + d.channel + ' failed (HTTP ' + d.status + ')',
        mediaFail: (d) => 'Could not load stream segment list (HTTP ' + d.status + ')',
        gqlFail: (d) => 'Replacement stream (' + d.playerType + '): request to Twitch failed (HTTP ' + d.status + ')',
        gqlNoToken: (d) => 'Replacement stream (' + d.playerType + '): no access from Twitch' + (d.reason ? ' (' + d.reason + ')' : ''),
        backupUsherFail: (d) => 'Replacement stream (' + d.playerType + '): stream list failed (HTTP ' + d.status + ')',
        backupError: (d) => 'Replacement stream (' + d.playerType + '): error – ' + d.message,
        backupHasAds: (d) => 'Replacement stream (' + d.playerType + ') has ads as well',
        backupOk: (d) => 'Ad-free replacement stream active (' + d.playerType + ')',
        stripped: () => 'No ad-free replacement stream – ads are being cut out',
        vodAd: () => 'Ad in recording (VOD) cut out',
        playlistSeen: (d) => 'Player uses ' + (d.kind === 'master' ? 'stream list' : 'playlist') + ': ' + d.url,
        mediaUnmatched: (d) => 'Playlist address not matched – using last loaded channel ' + d.channel,
        exception: (d) => 'Script error, stream continues without filter: ' + d.message,
        adBreak: (d) => 'Ad break blocked (' + modeText(d.mode) + (d.seconds ? ', ' + fmtDur(d.seconds) + ' saved' : '') + ')',
        leakAuto: () => 'Ad slipped through (shown by Twitch)',
        leakManual: () => 'Ad slipped through (reported manually)',
        videoError: (d) => 'Video error in player (code ' + d.code + ')' + (d.message ? ': ' + d.message : ''),
        playerError: (d) => 'Twitch player shows error: ' + d.text,
        freeze: (d) => 'Picture frozen for ' + d.seconds + ' s',
        recoverSeek: () => 'Repair 1: jumped to the live picture',
        recoverPlay: () => 'Repair 2: restarted the player (pause/play)',
        recoverReload: () => 'Repair 3: reloading the page',
        recoverSkipReload: () => 'Picture still frozen – reload skipped (reloaded only recently)',
        recovered: () => 'Picture is running again',
        updateAvailable: (d) => 'Update available: ' + d.version,
        updateCheckFailed: (d) => 'Update check failed (' + d.message + ')',
        imported: () => 'Backup restored',
      },
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

  function modeText(mode) {
    return mode === 'backup' ? t('modeBackup') : mode === 'stripped' ? t('modeStripped') : '?';
  }

  // Versionen vergleichen: > 0, wenn a neuer ist als b
  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  let sessionCount = 0;
  let workerSeen = false; // hat sich der Video-Worker in diesem Tab gemeldet?
  let lastAd = null;      // { time, channel, mode } der letzten Werbepause in diesem Tab
  let lastAdMsg = 0;      // Zeitpunkt der letzten Werbe-Meldung des Workers
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
    const reserved = ['directory', 'videos', 'settings', 'search', 'downloads', 'subscriptions', 'inventory', 'wallet', 'drops', 'turbo', 'p', 'friends'];
    return seg && !reserved.includes(seg.toLowerCase()) ? seg.toLowerCase() : null;
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(t('locale'), { day: '2-digit', month: '2-digit' }) + ' '
      + d.toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit' });
  }

  function fmtTimeSec(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(t('locale'), { day: '2-digit', month: '2-digit' }) + ' '
      + d.toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ---------------------------------------------------------------------------
  // Ereignis-Protokoll (Fehler, Stream-Status, Werbepausen) – für die Fehlersuche
  // ---------------------------------------------------------------------------
  function loadEvents() {
    const e = loadJson(EVENTS_KEY, []);
    return Array.isArray(e) ? e : [];
  }

  function logEvent(level, code, data) {
    try {
      const events = loadEvents();
      const entry = { t: Date.now(), level, code, data: data || {}, ch: currentChannel() };
      const last = events[0];
      // gleiches Ereignis kurz hintereinander nur hochzählen
      if (last && last.code === code && last.level === level && last.ch === entry.ch
          && JSON.stringify(last.data) === JSON.stringify(entry.data) && entry.t - last.t < 60 * 1000) {
        last.n = (last.n || 1) + 1;
        last.t = entry.t;
      } else {
        events.unshift(entry);
      }
      saveJson(EVENTS_KEY, events.slice(0, MAX_EVENTS));
      if (ui.root && box.expanded && (level !== 'info' || settings.devMode)) renderCounter();
    } catch (e) { /* Protokoll darf nie das Script stören */ }
  }

  function eventText(e) {
    const fn = TEXT[lang()].ev[e.code];
    let text;
    try { text = fn ? fn(e.data || {}) : e.code; } catch (err) { text = e.code; }
    return text + (e.n > 1 ? ' (×' + e.n + ')' : '');
  }

  function lastIssue() {
    return loadEvents().find((e) => e.level !== 'info' && Date.now() - e.t < 24 * 3600 * 1000) || null;
  }

  // ---------------------------------------------------------------------------
  // Box: Position, Zustände
  // ---------------------------------------------------------------------------

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
    if (ui.inputs && ui.inputs.emergency) ui.inputs.emergency.checked = !!settings.emergency;
  }

  function updateLock() {
    ui.root.classList.toggle('locked', !!box.locked);
    ui.lock.textContent = box.locked ? '🔒' : '🔓';
    ui.lock.title = box.locked ? t('lockOn') : t('lockOff');
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
    if (!btn) return;
    if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
    clearTimeout(btn._flashTimer);
    btn.textContent = text;
    btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Protokoll-Text, Zeitstempel, Zwischenablage
  // ---------------------------------------------------------------------------
  function reportsAsText() {
    const s = loadStats();
    const onOff = (v) => (v ? t('on') : t('off'));
    const upd = loadJson(UPDATE_KEY, {});
    const lines = [
      'Twitch Adblock ' + VERSION + ' – ' + t('logHeader'),
      t('logSummary')(s),
      'Browser: ' + navigator.userAgent,
      t('logPage') + ': ' + location.pathname + ' · ' + t('logLang') + ': ' + lang(),
      t('logSettings') + ': ' + Object.keys(CONFIG.defaults).map((k) => k + '=' + (typeof settings[k] === 'boolean' ? onOff(settings[k]) : settings[k])).join(', '),
      t('logWorker') + ': ' + (workerSeen ? t('yes') : t('no')),
      t('logLatest') + ': ' + (upd.latest || t('unknown')),
      '',
      '== ' + t('logEvents') + ' ==',
    ];
    for (const e of loadEvents().slice(0, 100)) {
      lines.push(fmtTimeSec(e.t) + ' [' + (TEXT[lang()].level[e.level] || e.level) + '] '
        + (e.ch ? e.ch + ': ' : '') + eventText(e));
    }
    lines.push('', '== ' + t('logLeaks') + ' ==');
    for (const r of loadReports()) {
      lines.push(fmtTime(new Date(r.time).getTime()) + ' | ' + (r.channel || '?') + ' | '
        + (r.auto ? t('logAuto') : t('logManual'))
        + ' | ' + t('logMethod') + ': ' + (r.mode ? modeText(r.mode) : t('logNoAd')));
    }
    return lines.join('\n');
  }

  // Text für eine manuelle Meldung, z. B.
  // "Werbung nicht blockiert – 17.10.2026 16:23:05 – Kanal: xyz – letzte Methode: Ersatz-Stream (vor 40 s) – Script 2.0.0"
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

  // Zeitstempel: nur in die Zwischenablage, nichts speichern
  async function doStamp() {
    const ok = await copyText(reportStamp());
    flashButton(ui.stamp, ok ? t('copied') : t('failed'));
    if (!ui.root || !box.expanded || !settings.devMode) showNotice(ok ? reportStamp() : t('failed'), 4000);
  }
  // Durchgerutscht: im Protokoll speichern und Zähler +1
  function doLeak() {
    addReport(false);
    flashButton(ui.leak, t('saved'));
    if (!ui.root || !box.expanded) showNotice(t('leak') + ' – ' + t('saved'), 3000);
  }
  // Ist Sync an, löst jeder der beiden Buttons auch den anderen aus
  const pressStamp = () => { doStamp(); if (box.sync) doLeak(); };
  const pressLeak = () => { doLeak(); if (box.sync) doStamp(); };

  // Protokoll kopieren und Fehler-Formular auf GitHub öffnen
  async function reportBug() {
    const ok = await copyText(reportsAsText());
    window.open(ISSUE_URL, '_blank', 'noopener');
    showNotice(ok ? t('reportCopied') : t('reportCopyFailed'), 12000, true);
  }

  // ---------------------------------------------------------------------------
  // Updates und „Was ist neu“
  // ---------------------------------------------------------------------------
  function updateInfo() {
    const u = loadJson(UPDATE_KEY, {});
    return u.latest && cmpVersion(u.latest, VERSION) > 0 ? u.latest : null;
  }

  async function checkUpdate() {
    try {
      const r = await fetch(RAW_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const v = ((await r.text()).match(/@version\s+([\d.]+)/) || [])[1];
      if (!v) throw new Error('no @version');
      const before = updateInfo();
      saveJson(UPDATE_KEY, { checked: Date.now(), latest: v });
      if (cmpVersion(v, VERSION) > 0 && before !== v) logEvent('info', 'updateAvailable', { version: v });
      renderCounter();
      return v;
    } catch (e) {
      saveJson(UPDATE_KEY, Object.assign(loadJson(UPDATE_KEY, {}), { checked: Date.now() }));
      logEvent('warn', 'updateCheckFailed', { message: String((e && e.message) || e) });
      return null;
    }
  }

  function openUpdate() {
    window.open(RAW_URL, '_blank', 'noopener');
    showNotice(t('updateOpened'), 8000, true);
  }

  // ---------------------------------------------------------------------------
  // Sichern / Wiederherstellen
  // ---------------------------------------------------------------------------
  function exportData() {
    const data = {
      app: 'twitch-adblock', version: VERSION, exported: new Date().toISOString(),
      stats: loadStats(), settings, reports: loadReports(), box, events: loadEvents(),
    };
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'twitch-adblock-backup-' + today() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function importData(file, btn) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || data.app !== 'twitch-adblock' || !data.stats) throw new Error('invalid');
        saveJson(STATS_KEY, data.stats);
        if (data.settings) saveJson(SETTINGS_KEY, data.settings);
        if (Array.isArray(data.reports)) saveJson(REPORTS_KEY, data.reports);
        if (Array.isArray(data.events)) saveJson(EVENTS_KEY, data.events);
        if (data.box) { Object.assign(box, data.box); saveBox(); }
        settings = loadSettings();
        applyPageOptions();
        logEvent('info', 'imported', {});
        rebuildCounter();
        flashButton(ui.importBtn, t('imported'));
      } catch (e) {
        flashButton(btn, t('importFailed'));
      }
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------------
  // Panel aufbauen
  // ---------------------------------------------------------------------------
  function setEmergency(on) {
    settings.emergency = !!on;
    saveSettings();
    updateEmergency();
    if (!settings.emergency) emergencyOff();
    showNotice(settings.emergency ? t('emergencyOnNotice') : t('emergencyOffNotice'), 3000);
  }

  function setSetting(key, value) {
    settings[key] = value;
    saveSettings();
    if (key === 'emergency') { updateEmergency(); if (!value) emergencyOff(); }
    if (key === 'showNotice' && !value) showNotice(null, 0, true);
    if (key === 'hideTurbo' || key === 'hidePrime') applyPageOptions();
    if (key === 'updateCheck' && value) checkUpdate();
    renderCounter();
  }

  function buildSettings() {
    ui.settingsBtn = el('button', 'ttv-ab-wide');
    ui.settingsWrap = el('div', 'ttv-ab-fold');
    ui.inputs = {};
    const group = (title) => ui.settingsWrap.append(el('h4', '', title));
    const check = (key, label, hint) => {
      const row = el('label', 'ttv-ab-setting');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = !!settings[key];
      input.addEventListener('change', () => (key === 'emergency' ? setEmergency(input.checked) : setSetting(key, input.checked)));
      const txt = el('span', '', label);
      if (hint) txt.append(el('small', '', hint));
      row.append(input, txt);
      ui.settingsWrap.append(row);
      ui.inputs[key] = input;
    };

    group(t('groupView'));
    check('showNotice', t('setNotice'));
    check('showCounter', t('setCounter'), t('setCounterHint'));
    check('devMode', t('setDev'), t('setDevHint'));
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

    group(t('groupBlock'));
    check('emergency', t('setEmergency'));
    check('autoDetect', t('setAuto'));
    check('autoRecover', t('setRecover'), t('setRecoverHint'));
    check('vod', t('setVod'), t('setVodHint'));

    group(t('groupExtra'));
    check('shortcuts', t('setShortcuts'), t('setShortcutsHint'));
    check('updateCheck', t('setUpdate'));
    check('hideTurbo', t('setHideTurbo'));
    check('hidePrime', t('setHidePrime'));
    check('stopFrontpage', t('setStopFront'));

    // Sichern / Wiederherstellen
    const backup = el('div', 'ttv-ab-actions');
    const exportBtn = el('button', '', t('exportBtn'));
    exportBtn.title = t('exportTitle');
    exportBtn.addEventListener('click', exportData);
    ui.importBtn = el('button', '', t('importBtn'));
    ui.importBtn.title = t('importTitle');
    const file = el('input');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.style.display = 'none';
    file.addEventListener('change', () => { if (file.files[0]) importData(file.files[0], ui.importBtn); file.value = ''; });
    ui.importBtn.addEventListener('click', () => file.click());
    backup.append(exportBtn, ui.importBtn, file);
    ui.settingsWrap.append(backup);

    ui.settingsBtn.addEventListener('click', () => {
      box.settingsOpen = !box.settingsOpen;
      saveBox();
      renderCounter();
    });
  }

  function buildStats() {
    ui.statsBtn = el('button', 'ttv-ab-wide');
    ui.statsWrap = el('div', 'ttv-ab-fold');
    ui.statsWrap.append(el('h4', '', t('last7')));
    ui.chart = el('div', 'ttv-ab-chart');
    ui.statsWrap.append(ui.chart);
    ui.statsWrap.append(el('h4', '', t('topChannels')));
    ui.channels = el('ul');
    ui.statsWrap.append(ui.channels);
    ui.statsBtn.addEventListener('click', () => {
      box.statsOpen = !box.statsOpen;
      saveBox();
      renderCounter();
    });
  }

  function renderStats(s) {
    // 7-Tage-Balken
    ui.chart.replaceChildren();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push({ key: dayKey(d), date: d });
    }
    const max = Math.max(1, ...days.map((d) => (s.days[d.key] || {}).ads || 0));
    for (const d of days) {
      const v = s.days[d.key] || { ads: 0, saved: 0 };
      const col = el('div', 'ttv-ab-bar');
      const label = d.date.toLocaleDateString(t('locale'), { weekday: 'short' });
      col.title = t('dayTitle')(d.date.toLocaleDateString(t('locale')), v.ads || 0, v.saved || 0);
      const fill = el('i');
      fill.style.height = Math.round(((v.ads || 0) / max) * 100) + '%';
      col.append(el('b', '', String(v.ads || 0)), el('span', 'ttv-ab-barbox'), el('small', '', label));
      col.children[1].append(fill);
      ui.chart.append(col);
    }
    // Top-Kanäle
    ui.channels.replaceChildren();
    const top = Object.entries(s.channels).sort((a, b) => (b[1].ads || 0) - (a[1].ads || 0)).slice(0, 5);
    if (!top.length) ui.channels.append(el('li', 'ttv-ab-muted', t('noData')));
    for (const [name, c] of top) {
      const li = el('li');
      li.append(el('b', '', name), el('span', 'ttv-ab-muted', ' · ' + t('chanLine')(c)));
      ui.channels.append(li);
    }
  }

  function buildCounter() {
    ui.root = el('div');
    ui.root.id = 'ttv-adblock-counter';

    // Kopfzeile: Zähler, Update, Dev, Notfall-Modus, Auf-/Zuklappen, Schloss
    ui.head = el('div', 'ttv-ab-head');
    ui.text = el('span');
    ui.update = el('button', 'ttv-ab-icon ttv-ab-update', '⬆');
    ui.dev = el('button', 'ttv-ab-icon ttv-ab-devbtn', '🛠');
    ui.emergency = el('button', 'ttv-ab-icon ttv-ab-emergency', '🛟');
    ui.toggle = el('button', 'ttv-ab-icon');
    ui.lock = el('button', 'ttv-ab-icon');
    ui.head.append(ui.text, ui.update, ui.dev, ui.emergency, ui.toggle, ui.lock);
    ui.head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      box.expanded = !box.expanded;
      saveBox();
      renderCounter();
    });

    // Panel
    ui.panel = el('div', 'ttv-ab-panel');
    const stats = el('div', 'ttv-ab-stats');
    const row = (label, cls, dev) => {
      const k = el('span', dev ? 'ttv-ab-dev' : '', label);
      const v = el('b', (cls || '') + (dev ? ' ttv-ab-dev' : ''), '0');
      stats.append(k, v);
      return v;
    };
    ui.vTab = row(t('statTab'), '', true);
    ui.vToday = row(t('statToday'));
    ui.vTotal = row(t('statTotal'));
    ui.vSavedToday = row(t('statSavedToday'), 'good');
    ui.vSavedTotal = row(t('statSavedTotal'), 'good');
    ui.vLeaked = row(t('statLeaked'), 'bad');
    ui.last = el('div', 'ttv-ab-muted ttv-ab-dev');
    ui.issue = el('div', 'ttv-ab-issue ttv-ab-dev');

    // Melde-Zeile: [Zeitstempel] [Durchgerutscht] [Sync] – Zeitstempel & Sync nur im Dev-Modus
    ui.reportRow = el('div', 'ttv-ab-reportrow');
    ui.stamp = el('button', 'ttv-ab-stamp ttv-ab-dev', t('stamp'));
    ui.stamp.title = t('stampTitle');
    ui.leak = el('button', 'ttv-ab-leak', t('leak'));
    ui.leak.title = t('leakTitle');
    ui.sync = el('button', 'ttv-ab-sync ttv-ab-dev', '🔗');
    ui.reportRow.append(ui.stamp, ui.leak, ui.sync);

    buildStats();

    // Dev-Bereich: Durchgerutscht-Liste, Ereignisse, Werkzeuge
    ui.devWrap = el('div', 'ttv-ab-dev');
    ui.listTitle = el('h4');
    ui.list = el('ul');
    ui.eventsTitle = el('h4', '', t('eventsTitle'));
    ui.events = el('ul', 'ttv-ab-events');
    const devActions = el('div', 'ttv-ab-actions');
    ui.copy = el('button', '', t('copyLog'));
    ui.clear = el('button', '', t('clearLeaked'));
    ui.reset = el('button', '', t('resetAll'));
    devActions.append(ui.copy, ui.clear, ui.reset);
    ui.devWrap.append(ui.listTitle, ui.list, ui.eventsTitle, ui.events, devActions);

    // Immer sichtbar: Fehler melden, Updates
    const mainActions = el('div', 'ttv-ab-actions');
    ui.reportBug = el('button', '', t('reportBug'));
    ui.reportBug.title = t('reportBugTitle');
    ui.checkUpdate = el('button', '', t('checkUpdate'));
    mainActions.append(ui.reportBug, ui.checkUpdate);

    buildSettings();

    // Fußzeile mit Version
    ui.footer = el('div', 'ttv-ab-footer');
    ui.versionText = el('span', '', t('version')(VERSION));
    const news = el('a', '', t('whatsNewLink'));
    news.href = CHANGELOG_URL;
    news.target = '_blank';
    news.rel = 'noopener';
    ui.footer.append(ui.versionText, document.createTextNode(' · '), news);

    ui.panel.append(stats, ui.last, ui.issue, ui.reportRow, ui.statsBtn, ui.statsWrap, ui.devWrap,
      mainActions, ui.settingsBtn, ui.settingsWrap, ui.footer);
    ui.root.append(ui.head, ui.panel);
    document.body.appendChild(ui.root);

    // Ereignisse
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
    ui.dev.addEventListener('click', () => {
      setSetting('devMode', false);
      if (ui.inputs.devMode) ui.inputs.devMode.checked = false;
    });
    ui.update.addEventListener('click', openUpdate);
    ui.stamp.addEventListener('click', pressStamp);
    ui.leak.addEventListener('click', pressLeak);
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
    ui.copy.addEventListener('click', async () => {
      flashButton(ui.copy, (await copyText(reportsAsText())) ? t('copied') : t('failed'));
    });
    ui.reportBug.addEventListener('click', reportBug);
    ui.checkUpdate.addEventListener('click', async () => {
      const v = await checkUpdate();
      if (v === null) openUpdate(); // Prüfung blockiert? Dann direkt die Update-Seite öffnen
      else if (cmpVersion(v, VERSION) > 0) flashButton(ui.checkUpdate, t('updateAvail')(v).split(' – ')[0]);
      else flashButton(ui.checkUpdate, t('upToDate') + ' (' + VERSION + ')');
    });
    confirmClick(ui.clear, () => {
      saveJson(REPORTS_KEY, []);
      const s = loadStats();
      s.leaked = 0;
      for (const c of Object.values(s.channels)) c.leaked = 0;
      saveStats(s);
      renderCounter();
      flashButton(ui.clear, t('cleared'));
    });
    confirmClick(ui.reset, () => {
      saveStats(emptyStats());
      sessionCount = 0;
      renderCounter();
      flashButton(ui.reset, t('resetDone'));
    });

    updateSync();
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
    const upd = settings.updateCheck ? updateInfo() : null;

    ui.text.textContent = !settings.showCounter
      ? '🛡'
      : s.savedTotal > 0 ? t('headSaved')(s.total, fmtDur(s.savedTotal)) : t('head')(s.total);
    ui.head.title = t('version')(VERSION) + '\n' + (box.locked ? t('headLocked') : t('headDrag'));
    ui.root.classList.toggle('expanded', !!box.expanded);
    ui.root.classList.toggle('dev', !!settings.devMode);
    ui.toggle.textContent = box.expanded ? '▴' : '▾';
    ui.toggle.title = box.expanded ? t('collapse') : t('expand');
    ui.update.hidden = !upd;
    if (upd) ui.update.title = t('updateAvail')(upd);
    ui.dev.hidden = !settings.devMode;
    ui.dev.title = t('devTitle');
    ui.settingsWrap.classList.toggle('open', !!box.settingsOpen);
    ui.settingsBtn.textContent = t('settings') + (box.settingsOpen ? ' ▴' : ' ▾');
    ui.statsWrap.classList.toggle('open', !!box.statsOpen);
    ui.statsBtn.textContent = t('statsBtn') + (box.statsOpen ? ' ▴' : ' ▾');
    for (const [k, input] of Object.entries(ui.inputs)) input.checked = !!settings[k];

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
      const issue = lastIssue();
      ui.issue.textContent = issue ? '⚠ ' + t('lastIssue') + ' (' + fmtTime(issue.t) + '): ' + eventText(issue) : '';
      ui.issue.classList.toggle('error', !!issue && issue.level === 'error');
      ui.versionText.textContent = t('version')(VERSION) + (upd ? ' → ' + upd : '');

      if (box.statsOpen) renderStats(s);

      if (settings.devMode) {
        const reports = loadReports();
        ui.list.replaceChildren();
        if (!reports.length) ui.list.append(el('li', 'ttv-ab-muted', t('noReports')));
        for (const r of reports.slice(0, 20)) {
          ui.list.append(el('li', '', fmtTime(new Date(r.time).getTime()) + ' · ' + (r.channel || '?')
            + (r.mode ? ' · ' + modeText(r.mode) : '') + ' · ' + (r.auto ? t('auto') : t('manual'))));
        }
        ui.listTitle.textContent = t('listTitle')(reports.length);

        const events = loadEvents().slice(0, 15);
        ui.events.replaceChildren();
        if (!events.length) ui.events.append(el('li', 'ttv-ab-muted', t('noEvents')));
        for (const e of events) {
          const li = el('li', 'lvl-' + e.level);
          li.append(el('span', 'ttv-ab-muted', fmtTimeSec(e.t).split(' ')[1] + ' '), document.createTextNode((e.ch ? e.ch + ': ' : '') + eventText(e)));
          ui.events.append(li);
        }
      }
    }
    placeCounter();
  }

  function countAdBreak() {
    const s = loadStats();
    s.total++;
    s.today++;
    bump(s, lastAd && lastAd.channel, 'ads', 1);
    saveStats(s);
    sessionCount++;
    renderCounter();
  }

  function addSavedTime(seconds) {
    if (!(seconds > 0)) return;
    const s = loadStats();
    s.savedTotal += seconds;
    s.savedToday += seconds;
    bump(s, lastAd && lastAd.channel, 'saved', seconds);
    saveStats(s);
    renderCounter();
  }

  // Durchgerutschte Werbung speichern (manuell oder automatisch erkannt)
  function addReport(auto) {
    const recent = lastAd && Date.now() - lastAd.time < 3 * 60 * 1000 ? lastAd : null;
    const channel = currentChannel() || (recent && recent.channel) || null;
    const reports = loadReports();
    reports.unshift({ time: new Date().toISOString(), channel, auto: !!auto, mode: recent ? recent.mode : null, version: VERSION });
    saveJson(REPORTS_KEY, reports.slice(0, MAX_REPORTS));
    const s = loadStats();
    s.leaked++;
    bump(s, channel, 'leaked', 1);
    saveStats(s);
    logEvent('warn', auto ? 'leakAuto' : 'leakManual', {});
    renderCounter();
  }

  // ---------------------------------------------------------------------------
  // Seiten-Optionen: Turbo/Prime ausblenden
  // ---------------------------------------------------------------------------
  function applyPageOptions() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('ttv-ab-hide-turbo', !!settings.hideTurbo);
    root.classList.toggle('ttv-ab-hide-prime', !!settings.hidePrime);
  }
  applyPageOptions();

  if (document.body) renderCounter();
  else document.addEventListener('DOMContentLoaded', renderCounter, { once: true });
  // Box aktualisieren, wenn ein anderer Twitch-Tab gezählt, gemeldet oder umgestellt hat
  window.addEventListener('storage', (e) => {
    if (e.key === STATS_KEY || e.key === REPORTS_KEY || e.key === UPDATE_KEY) renderCounter();
    if (e.key === SETTINGS_KEY) {
      settings = loadSettings();
      if (!settings.emergency) emergencyOff();
      applyPageOptions();
      rebuildCounter();
    }
  });

  // Tastenkürzel: Alt+W = Durchgerutscht, Alt+Z = Zeitstempel (nicht beim Tippen im Chat)
  window.addEventListener('keydown', (e) => {
    if (!settings.shortcuts || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const tgt = e.target;
    if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return;
    const key = (e.key || '').toLowerCase();
    if (key === 'w') { e.preventDefault(); pressLeak(); }
    else if (key === 'z') { e.preventDefault(); pressStamp(); }
  }, true);

  // ---------------------------------------------------------------------------
  // Durchgerutschte Werbung erkennen + Notfall-Modus
  // ---------------------------------------------------------------------------
  // Zeigt Twitch seine eigene Werbe-Anzeige (Label/Countdown), hat der Player
  // Werbung erkannt, die nicht entfernt wurde.
  const AD_UI_SELECTOR = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]';
  let lastLeak = 0;
  const emergency = { active: false, videos: new Map() }; // video -> war vorher stumm?

  // Twitch zeigt zur Werbung zusätzlich Knöpfe („Werbung ⓘ“, „Weitere Informationen“)
  // mit wechselnden Klassennamen – daher am Text erkennen und nur während der Werbung ausblenden
  const AD_UI_TEXT = /^(werbung|anzeige|ad|ads|weitere informationen|mehr erfahren|learn more)$/i;
  function hideAdControls() {
    const player = document.querySelector('[data-a-target="video-player"]') || document.querySelector('.video-player');
    if (!player) return;
    for (const e of player.querySelectorAll('button, a, p, span')) {
      if (e.children.length > 2 || !AD_UI_TEXT.test((e.textContent || '').trim())) continue;
      (e.closest('button, a') || e).classList.add('ttv-ab-adui');
    }
  }

  function emergencyOn() {
    hideAdControls();
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
    for (const e of document.querySelectorAll('.ttv-ab-adui')) e.classList.remove('ttv-ab-adui');
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
  // Überwachung: Video-/Player-Fehler, Video-Worker, hängendes Bild, Startseite
  // ---------------------------------------------------------------------------
  const watchedVideos = new WeakSet();
  const pageStart = Date.now();
  let noWorkerLogged = false;
  let lastPlayerError = '';
  const freeze = { video: null, time: -1, since: Date.now(), step: 0 };

  function mainVideo() {
    return document.querySelector('[data-a-target="video-player"] video') || document.querySelector('video');
  }

  // Hängendes Bild reparieren: 1. zum Live-Bild springen, 2. Pause/Play, 3. Seite neu laden
  function checkFreeze() {
    const v = mainVideo();
    const adRunning = Date.now() - lastAdMsg < 15 * 1000; // beim Herausschneiden steht das Bild absichtlich
    if (!settings.autoRecover || !v || !currentChannel() || v.paused || v.ended || document.hidden
        || adRunning || emergency.active || v.readyState === 0) {
      freeze.video = v; freeze.time = v ? v.currentTime : -1; freeze.since = Date.now(); freeze.step = 0;
      return;
    }
    if (v !== freeze.video || v.currentTime !== freeze.time) {
      if (freeze.step > 0 && v === freeze.video) logEvent('info', 'recovered', {});
      freeze.video = v; freeze.time = v.currentTime; freeze.since = Date.now(); freeze.step = 0;
      return;
    }
    const stuck = Date.now() - freeze.since;
    if (freeze.step === 0 && stuck > 10 * 1000) {
      logEvent('warn', 'freeze', { seconds: Math.round(stuck / 1000) });
      showNotice(t('noticeRecover'), 4000);
      if (v.buffered.length) {
        const end = v.buffered.end(v.buffered.length - 1);
        if (end - v.currentTime > 1) v.currentTime = end - 0.5;
      }
      logEvent('info', 'recoverSeek', {});
      freeze.step = 1; freeze.since = Date.now();
    } else if (freeze.step === 1 && stuck > 8 * 1000) {
      v.pause();
      setTimeout(() => { const p = v.play(); if (p && p.catch) p.catch(() => {}); }, 300);
      logEvent('info', 'recoverPlay', {});
      freeze.step = 2; freeze.since = Date.now();
    } else if (freeze.step === 2 && stuck > 12 * 1000) {
      freeze.step = 3;
      if (Date.now() - loadJson(RELOAD_KEY, 0) > 5 * 60 * 1000) {
        saveJson(RELOAD_KEY, Date.now());
        logEvent('warn', 'recoverReload', {});
        showNotice(t('noticeReload'), 3000, true);
        setTimeout(() => location.reload(), 1500);
      } else {
        logEvent('warn', 'recoverSkipReload', {});
      }
    }
  }

  setInterval(() => {
    if (!document.body) return;
    for (const v of document.querySelectorAll('video')) {
      if (watchedVideos.has(v)) continue;
      watchedVideos.add(v);
      v.addEventListener('error', () => {
        const err = v.error || {};
        logEvent('error', 'videoError', { code: err.code || '?', message: err.message || '' });
      });
    }
    // Twitch zeigt Player-Fehler als Text wie „Fehler #2000“ / „Error #4000“
    const player = document.querySelector('[data-a-target="video-player"]') || document.querySelector('.video-player');
    const m = player && (player.textContent || '').match(/[^.\n]{0,80}(?:Fehler|Error)\s*#\s*\d{3,5}[^.\n]{0,40}/i);
    const text = m ? m[0].trim() : '';
    if (text && text !== lastPlayerError) logEvent('error', 'playerError', { text });
    lastPlayerError = text;
    // Kein Video-Worker 20 s nach dem Laden, obwohl ein Video da ist
    if (!workerSeen && !noWorkerLogged && Date.now() - pageStart > 20 * 1000
        && currentChannel() && document.querySelector('video')) {
      noWorkerLogged = true;
      logEvent('warn', 'noWorker', {});
    }
    // Startseite: automatisch startendes Video stoppen
    if (settings.stopFrontpage && location.pathname === '/') {
      for (const v of document.querySelectorAll('video')) {
        if (!v.paused) { v.muted = true; v.pause(); }
      }
    }
    checkFreeze();
  }, 2000);

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

  // ---------------------------------------------------------------------------
  // Meldungen aus dem Video-Worker
  // ---------------------------------------------------------------------------
  if (typeof BroadcastChannel !== 'undefined') {
    const bc = new BroadcastChannel(CONFIG.channelName);
    bc.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.tabId !== CONFIG.tabId) return; // Meldung aus einem anderen Tab
      if (msg.type === 'log') {
        const { type, tabId, level, code, ...data } = msg;
        if (code === 'workerReady') workerSeen = true;
        logEvent(level, code, data);
      } else if (msg.type === 'ad-start') {
        lastAdMsg = Date.now();
        lastAd = { time: Date.now(), channel: currentChannel(), mode: null };
        countAdBreak();
      } else if (msg.type === 'ad') {
        lastAdMsg = Date.now();
        lastAd = lastAd || { time: Date.now() };
        lastAd.mode = msg.mode;
        if (msg.channel) lastAd.channel = msg.channel;
        showNotice(msg.mode === 'backup' ? t('noticeBackup') : t('noticeStripped'));
        if (box.expanded) renderCounter();
      } else if (msg.type === 'ad-end') {
        lastAdMsg = 0;
        logEvent('info', 'adBreak', { mode: lastAd ? lastAd.mode : null, seconds: msg.seconds || 0 });
        addSavedTime(msg.seconds);
        if (msg.seconds > 0) showNotice(t('noticeSaved')(fmtDur(msg.seconds)), 4000);
        else showNotice(null);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Start: „Was ist neu“, Update-Prüfung
  // ---------------------------------------------------------------------------
  logEvent('info', 'start', { version: VERSION });
  (function startup() {
    const seen = loadJson(SEEN_KEY, null);
    const hadData = localStorage.getItem(STATS_KEY) !== null;
    if (seen !== VERSION) {
      saveJson(SEEN_KEY, VERSION);
      if (seen || hadData) {
        logEvent('info', 'updated', { from: seen || '< 2.0.0', to: VERSION });
        const show = () => showNotice(t('whatsNew')(VERSION, WHATS_NEW[lang()]), 12000);
        if (document.body) setTimeout(show, 1500);
        else document.addEventListener('DOMContentLoaded', () => setTimeout(show, 1500), { once: true });
      }
    }
    const upd = loadJson(UPDATE_KEY, {});
    if (settings.updateCheck && Date.now() - (upd.checked || 0) > 24 * 3600 * 1000) {
      setTimeout(checkUpdate, 15 * 1000);
    }
  })();
})();
