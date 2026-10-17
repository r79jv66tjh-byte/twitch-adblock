// Tests für den Video-Worker-Teil des Userscripts (läuft mit: node --test tests/)
// Simuliert Twitchs Stream-Listen und Playlists und prüft, was das Script daraus macht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../twitch-adblock.user.js', import.meta.url), 'utf8');
const start = src.indexOf('  function workerMain(cfg) {');
const end = src.indexOf('\n  }\n', start) + 4;
const workerMain = new Function('return (' + src.slice(start, end).trim() + ')')();

// BroadcastChannels sollen den Test-Prozess nicht offen halten
const NativeBC = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends NativeBC {
  constructor(name) { super(name); if (this.unref) this.unref(); }
};
globalThis.self = globalThis;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

// Startet den Worker-Code mit einer Fake-fetch-Funktion und sammelt seine Meldungen
function startWorker(fakeFetch, extraCfg = {}) {
  const channelName = 'test-' + (++counter);
  self.fetch = fakeFetch;
  const msgs = [];
  const bc = new BroadcastChannel(channelName);
  bc.onmessage = (e) => msgs.push(e.data);
  workerMain(Object.assign({ channelName, tabId: 't', playerTypes: ['embed'], clientId: 'x', deviceId: null }, extraCfg));
  return { msgs, bc, logs: () => msgs.filter((m) => m.type === 'log').map((m) => m.code) };
}

const resp = (body, status = 200) => new Response(body, { status });
const MASTER = (u) => '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=60.000\n' + u + '\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,FRAME-RATE=30.000\n' + u.replace('.m3u8', '-720.m3u8') + '\n';
const AD = '#EXTM3U\n#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",DURATION=15.0\n#EXT-X-DATERANGE:ID="stitched-ad-2",CLASS="twitch-stitched-ad",DURATION=30.0\n#EXTINF:2.000,Amazon\nhttps://ad/a.ts\n#EXTINF:2.000,live\nhttps://live/1.ts\n';
const LIVE = '#EXTM3U\n#EXTINF:2.000,live\nhttps://live/2.ts\n';
const TOKEN = JSON.stringify({ data: { streamPlaybackAccessToken: { value: 'tok', signature: 'sig' } } });
const NO_TOKEN = JSON.stringify({ data: { streamPlaybackAccessToken: null }, errors: [{ message: 'forbidden' }] });

test('Werbung ohne Ersatz-Stream wird herausgeschnitten, gesparte Zeit = Summe der Spots', async () => {
  const media = ['AD', 'AD', 'LIVE'];
  const w = startWorker(async (url) => {
    url = String(url);
    if (url.includes('usher')) return resp(MASTER('https://x.ttvnw.net/v1/playlist/p.m3u8'));
    if (url.includes('gql')) return resp(NO_TOKEN);
    return resp(media.shift() === 'AD' ? AD : LIVE);
  });
  await self.fetch('https://usher.ttvnw.net/api/channel/hls/kanal.m3u8');
  const out = await (await self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8')).text();
  await self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8');
  await self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8');
  await wait(50);
  assert.ok(!out.includes('https://ad/a.ts'), 'Werbesegment entfernt');
  assert.ok(out.includes('https://live/1.ts'), 'Live-Segment bleibt');
  const end = w.msgs.find((m) => m.type === 'ad-end');
  assert.equal(end.seconds, 45, '15 s + 30 s, doppelte Spots nur einmal');
  assert.ok(w.logs().includes('stripped'));
  assert.ok(w.logs().includes('gqlNoToken'));
});

test('Neue Adressform /api/v2/: werbefreier Ersatz-Stream mit Qualität', async () => {
  const calls = [];
  let main = 0;
  const w = startWorker(async (url) => {
    url = String(url);
    calls.push(url.split('?')[0]);
    if (url.includes('/api/v2/channel/hls/')) return resp(MASTER(url.includes('sig=') ? 'https://x.ttvnw.net/v1/playlist/BACKUP.m3u8' : 'https://x.ttvnw.net/v1/playlist/MAIN.m3u8?a=1'));
    if (url.includes('gql')) return resp(TOKEN);
    if (url.includes('BACKUP')) return resp('#EXTM3U\n#EXTINF:2.000,live\nhttps://backup/b.ts\n');
    main++;
    return resp(main === 1 ? AD : LIVE);
  });
  await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/kanal.m3u8?x=1');
  const out = await (await self.fetch('https://x.ttvnw.net/v1/playlist/MAIN.m3u8?a=2')).text(); // andere Query
  await self.fetch('https://x.ttvnw.net/v1/playlist/MAIN.m3u8?a=2');
  await wait(50);
  assert.ok(out.includes('https://backup/b.ts'), 'Ersatz-Stream wird abgespielt');
  assert.ok(calls.some((c) => c.endsWith('/api/v2/channel/hls/kanal.m3u8')), 'Ersatz über v2-Adresse geholt');
  const ad = w.msgs.find((m) => m.type === 'ad');
  assert.equal(ad.mode, 'backup');
  assert.equal(ad.quality, '1080p');
  assert.ok(w.logs().includes('usherOk'));
  assert.ok(w.logs().includes('playlistSeen'));
});

test('Option „nur volle Qualität“: schlechterer Ersatz-Stream wird übersprungen', async () => {
  const w = startWorker(async (url) => {
    url = String(url);
    if (url.includes('usher') && url.includes('sig=')) return resp('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=852x480\nhttps://x.ttvnw.net/v1/playlist/LOW.m3u8\n');
    if (url.includes('usher')) return resp(MASTER('https://x.ttvnw.net/v1/playlist/MAIN.m3u8'));
    if (url.includes('gql')) return resp(TOKEN);
    if (url.includes('LOW')) return resp(LIVE);
    return resp(AD);
  }, { preferQuality: true });
  await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/kanal.m3u8');
  const out = await (await self.fetch('https://x.ttvnw.net/v1/playlist/MAIN.m3u8')).text();
  await wait(50);
  assert.ok(!out.includes('https://ad/a.ts'), 'Werbung trotzdem entfernt (herausgeschnitten)');
  assert.ok(w.logs().includes('backupLowQuality'));
  assert.equal(w.msgs.find((m) => m.type === 'ad').mode, 'stripped');
});

test('Offline (HTTP 404) wird unverändert durchgereicht und protokolliert', async () => {
  const w = startWorker(async () => resp('', 404));
  const r = await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/offline.m3u8');
  await wait(50);
  assert.equal(r.status, 404);
  const fail = w.msgs.find((m) => m.code === 'usherFail');
  assert.equal(fail.status, 404);
  assert.equal(fail.channel, 'offline');
});

test('Fehler im Script: Stream lädt trotzdem (Absicherung)', async () => {
  let n = 0;
  const w = startWorker(async () => {
    n++;
    const r = resp(LIVE);
    if (n === 1) r.text = () => { throw new Error('kaputt'); };
    return r;
  });
  const r = await self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8');
  await wait(50);
  assert.equal(r.status, 200);
  assert.ok(w.logs().includes('exception'));
});

test('VOD-Filter: nur wenn eingeschaltet, Inhalt bleibt erhalten', async () => {
  const VOD = '#EXTM3U\n#EXT-X-DATERANGE:ID="stitched-ad-v",CLASS="twitch-stitched-ad",DURATION=15.0\n#EXTINF:2.000,Amazon\nhttps://ad/v.ts\n#EXTINF:10.000,\nhttps://vod/1.ts\n';
  for (const vod of [false, true]) {
    startWorker(async () => resp(VOD), { vod });
    const out = await (await self.fetch('https://d1.cloudfront.net/abc/chunked/index-dvr.m3u8')).text();
    assert.equal(out.includes('https://ad/v.ts'), !vod, 'Werbung ' + (vod ? 'entfernt' : 'bleibt'));
    assert.ok(out.includes('https://vod/1.ts'), 'VOD-Inhalt bleibt');
  }
});

test('Selbsttest: Worker antwortet mit Stream-Liste und Ersatz-Stream', async () => {
  const w = startWorker(async (url) => {
    url = String(url);
    if (url.includes('usher')) return resp(MASTER('https://x.ttvnw.net/v1/playlist/p.m3u8'));
    if (url.includes('gql')) return resp(TOKEN);
    return resp(LIVE);
  });
  await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/kanal.m3u8');
  w.bc.postMessage({ tabId: 't', type: 'selftest' });
  await wait(200);
  const res = w.msgs.find((m) => m.type === 'selftest-result');
  assert.ok(res, 'Antwort erhalten');
  assert.equal(res.channel, 'kanal');
  assert.equal(res.usherPath, '/api/v2/channel/hls/');
  assert.equal(res.backup, true);
  assert.equal(res.backupQuality, '1080p');
  assert.equal(res.backupHasAds, false);
});
