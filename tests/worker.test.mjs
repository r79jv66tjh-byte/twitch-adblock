// Tests for the video worker part of the userscript (run with: node --test tests/worker.test.mjs)
// Simulates Twitch's stream lists and playlists and checks what the script makes of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../twitch-adblock.user.js', import.meta.url), 'utf8');
const start = src.indexOf('  function workerMain(cfg) {');
const end = src.indexOf('\n  }\n', start) + 4;
const workerMain = new Function('return (' + src.slice(start, end).trim() + ')')();

// BroadcastChannels must not keep the test process alive
const NativeBC = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends NativeBC {
  constructor(name) { super(name); if (this.unref) this.unref(); }
};
globalThis.self = globalThis;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

// Starts the worker code with a fake fetch function and collects its messages
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

test('Ads without a replacement stream are cut out, time saved = sum of the spots', async () => {
  const media = ['AD', 'AD', 'LIVE', 'LIVE'];
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
  await self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8');
  await wait(50);
  assert.ok(!out.includes('https://ad/a.ts'), 'ad segment removed');
  assert.ok(out.includes('https://live/1.ts'), 'live segment kept');
  const end = w.msgs.find((m) => m.type === 'ad-end');
  assert.equal(end.seconds, 45, '15 s + 30 s, duplicate spots counted once');
  assert.ok(w.logs().includes('stripped'));
  assert.ok(w.logs().includes('gqlNoToken'));
});

test('New address form /api/v2/: ad-free replacement stream with quality', async () => {
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
  const out = await (await self.fetch('https://x.ttvnw.net/v1/playlist/MAIN.m3u8?a=2')).text(); // different query
  await self.fetch('https://x.ttvnw.net/v1/playlist/MAIN.m3u8?a=2');
  await wait(50);
  assert.ok(out.includes('https://backup/b.ts'), 'replacement stream is played');
  assert.ok(calls.some((c) => c.endsWith('/api/v2/channel/hls/kanal.m3u8')), 'replacement fetched via the v2 address');
  const ad = w.msgs.find((m) => m.type === 'ad');
  assert.equal(ad.mode, 'backup');
  assert.equal(ad.quality, '1080p');
  assert.ok(w.logs().includes('usherOk'));
  assert.ok(w.logs().includes('playlistSeen'));
});

test('Option "full quality only": a worse replacement stream is skipped', async () => {
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
  assert.ok(!out.includes('https://ad/a.ts'), 'ad removed anyway (cut out)');
  assert.ok(w.logs().includes('backupLowQuality'));
  assert.equal(w.msgs.find((m) => m.type === 'ad').mode, 'stripped');
});

test('Offline (HTTP 404) is passed through unchanged and logged', async () => {
  const w = startWorker(async () => resp('', 404));
  const r = await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/offline.m3u8');
  await wait(50);
  assert.equal(r.status, 404);
  const fail = w.msgs.find((m) => m.code === 'usherFail');
  assert.equal(fail.status, 404);
  assert.equal(fail.channel, 'offline');
});

test('Script error: the stream still loads (safety net)', async () => {
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

test('VOD filter: only when turned on, content is kept', async () => {
  const VOD = '#EXTM3U\n#EXT-X-DATERANGE:ID="stitched-ad-v",CLASS="twitch-stitched-ad",DURATION=15.0\n#EXTINF:2.000,Amazon\nhttps://ad/v.ts\n#EXTINF:10.000,\nhttps://vod/1.ts\n';
  for (const vod of [false, true]) {
    startWorker(async () => resp(VOD), { vod });
    const out = await (await self.fetch('https://d1.cloudfront.net/abc/chunked/index-dvr.m3u8')).text();
    assert.equal(out.includes('https://ad/v.ts'), !vod, 'ad ' + (vod ? 'removed' : 'kept'));
    assert.ok(out.includes('https://vod/1.ts'), 'VOD content kept');
  }
});

test('Two playlists at once (one with, one without ads): no flickering', async () => {
  const w = startWorker(async (url) => {
    url = String(url);
    if (url.includes('usher')) return resp(MASTER('https://x.ttvnw.net/v1/playlist/p.m3u8'));
    if (url.includes('gql')) return resp(NO_TOKEN);
    return resp(url.includes('p-720') ? LIVE : AD); // 1080p has ads, 720p doesn't
  });
  await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/kanal.m3u8');
  for (let i = 0; i < 6; i++) {
    await self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8');
    await self.fetch('https://x.ttvnw.net/v1/playlist/p-720.m3u8');
  }
  await wait(50);
  assert.equal(w.msgs.filter((m) => m.type === 'ad-start').length, 1, 'only one ad break');
  assert.equal(w.msgs.filter((m) => m.type === 'ad-end').length, 0, 'no flipping back and forth');
});

test('A briefly ad-free playlist in the middle of a break doesn\'t end the break', async () => {
  const seq = [AD, LIVE, AD, LIVE, LIVE];
  const w = startWorker(async (url) => {
    url = String(url);
    if (url.includes('gql')) return resp(NO_TOKEN);
    return resp(seq.shift());
  });
  for (let i = 0; i < 5; i++) await self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8');
  await wait(50);
  assert.equal(w.msgs.filter((m) => m.type === 'ad-start').length, 1);
  assert.equal(w.msgs.filter((m) => m.type === 'ad-end').length, 1, 'end only after two ad-free fetches');
});

test('A request cancelled by the player is not a script error', async () => {
  const w = startWorker(async () => { const e = new Error('Request cancelled'); e.name = 'AbortError'; throw e; });
  await assert.rejects(() => self.fetch('https://x.ttvnw.net/v1/playlist/p.m3u8'));
  await wait(50);
  assert.ok(!w.logs().includes('exception'), 'not logged as an error');
});

// Several player types: embed has ads, popout delivers 360p, autoplay 720p (both ad-free)
function multiTypeFetch() {
  const BACKUP_RES = { embed: '1920x1080', popout: '640x360', autoplay: '1280x720' };
  return async (url, init) => {
    url = String(url);
    if (url.includes('gql')) {
      const type = JSON.parse(init.body).variables.playerType;
      return resp(JSON.stringify({ data: { streamPlaybackAccessToken: { value: type, signature: 'sig' } } }));
    }
    if (url.includes('usher') && url.includes('sig=')) {
      const type = new URL(url).searchParams.get('token');
      return resp('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=' + BACKUP_RES[type] + '\nhttps://x.ttvnw.net/v1/playlist/B-' + type + '.m3u8\n');
    }
    if (url.includes('usher')) return resp(MASTER('https://x.ttvnw.net/v1/playlist/MAIN.m3u8'));
    if (url.includes('B-embed')) return resp(AD);
    if (url.includes('B-')) return resp('#EXTM3U\n#EXTINF:2.000,live\nhttps://' + url.split('B-')[1].split('.')[0] + '/b.ts\n');
    return resp(AD);
  };
}

test('Replacement stream: the ad-free player type with the best quality wins', async () => {
  const w = startWorker(multiTypeFetch(), { playerTypes: ['embed', 'popout', 'autoplay'] });
  await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/kanal.m3u8');
  const out = await (await self.fetch('https://x.ttvnw.net/v1/playlist/MAIN.m3u8')).text();
  await wait(50);
  assert.ok(out.includes('https://autoplay/b.ts'), '720p (autoplay) instead of 360p (popout)');
  const ad = w.msgs.find((m) => m.type === 'ad');
  assert.equal(ad.mode, 'backup');
  assert.equal(ad.quality, '720p');
  assert.ok(w.logs().includes('backupHasAds'), 'embed with ads detected');
});

test('Self-test: measures all player types and names the best ad-free one', async () => {
  const w = startWorker(multiTypeFetch(), { playerTypes: ['embed', 'popout', 'autoplay'] });
  await self.fetch('https://usher.ttvnw.net/api/v2/channel/hls/kanal.m3u8');
  w.bc.postMessage({ tabId: 't', type: 'selftest' });
  await wait(200);
  const res = w.msgs.find((m) => m.type === 'selftest-result');
  assert.deepEqual(res.backupAll.map((it) => [it.type, it.quality, it.hasAds]),
    [['embed', '1080p', true], ['popout', '360p', false], ['autoplay', '720p', false]]);
  assert.equal(res.backupType, 'autoplay');
  assert.equal(res.backupQuality, '720p');
  assert.equal(res.backupHasAds, false);
});

test('Self-test: worker answers with stream list and replacement stream', async () => {
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
  assert.ok(res, 'answer received');
  assert.equal(res.channel, 'kanal');
  assert.equal(res.usherPath, '/api/v2/channel/hls/');
  assert.equal(res.backup, true);
  assert.equal(res.backupQuality, '1080p');
  assert.equal(res.backupHasAds, false);
  assert.equal(res.backupAll.length, 1);
});
