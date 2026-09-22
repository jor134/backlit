// Headless test for src/api/*.js and the Worker entry, with a local SQLite stand-in for D1 and an in-memory R2.
// Run: node tests/api.test.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const load = async f => { const tmp = path.join(os.tmpdir(), 'bl-' + f.replace('.js', '.mjs')); fs.copyFileSync(path.join(here, '..', 'src', 'api', f), tmp); return import(pathToFileURL(tmp).href + '?' + Date.now()); };
let fails = 0; const ok = (c, m) => { console.log(c ? 'ok' : 'FAIL', m); if (!c) fails++; };

function d1() { // minimal D1 API over SQLite
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => db.prepare(sql).run(...args) });
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); } };
}
function r2(files) { return {
  list: async ({ prefix = '' }) => ({ objects: Object.keys(files).filter(k => k.startsWith(prefix)).map(k => ({ key: k, size: files[k].length, etag: 'e-' + k.length })), truncated: false }),
  get: async k => files[k] ? { body: new Blob([files[k]]).stream(), size: files[k].length } : null }; }

const zip = fs.readFileSync(path.join(here, 'fixture.zip'));
const env = { FAMILY_PASSWORD: 'rock on', SESSION_SECRET: 'x'.repeat(40), DB: d1(), SONGS: r2({ 'songs/Foo Fighters - Everlong.zip': zip, 'songs/readme.txt': Buffer.from('x'), 'other/secret.zip': zip }), SONGS_PREFIX: 'songs/' };
const fam = await load('family.js'), sc = await load('scores.js');
let jar = '';
const call = async (mod, method, qs, body, headers = {}) => {
  const req = new Request('https://backlit.pages.dev/api/x?' + new URLSearchParams(qs), { method, body: body ? JSON.stringify(body) : undefined,
    headers: Object.assign({ Origin: 'https://backlit.pages.dev', Cookie: jar, 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' }, headers) });
  const res = await mod.onRequest({ request: req, env });
  const sc = res.headers.get('Set-Cookie'); if (sc) jar = sc.split(';')[0];
  const ct = res.headers.get('Content-Type') || '';
  return { code: res.status, body: ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()), headers: res.headers };
};

// family server
let r = await call(fam, 'GET', { action: 'list' }); ok(r.code === 401, 'list needs sign-in');
r = await call(fam, 'POST', { action: 'login' }, { name: 'Mum', password: 'nope' }); ok(r.code === 401, 'wrong password rejected');
r = await call(fam, 'POST', { action: 'login' }, { name: 'Mum', password: 'rock on' }); ok(r.code === 200 && /HttpOnly; Secure; SameSite=Strict/.test(r.headers.get('Set-Cookie')), 'sign-in sets secure cookie');
r = await call(fam, 'GET', { action: 'me' }); ok(r.body.name === 'Mum', 'session works');
r = await call(fam, 'GET', { action: 'list' }); ok(r.body.songs.length === 1 && r.body.songs[0].key === 'songs/Foo Fighters - Everlong.zip', 'only zips in the songs folder listed');
r = await call(fam, 'GET', { action: 'file', key: 'songs/Foo Fighters - Everlong.zip' }); ok(r.code === 200 && r.body.length === zip.length && r.body[0] === 0x50, 'zip streams from R2 intact');
r = await call(fam, 'GET', { action: 'file', key: 'other/secret.zip' }); ok(r.code === 400, 'files outside the songs folder refused');
const good = jar; jar = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA'); r = await call(fam, 'GET', { action: 'me' }); ok(r.code === 401, 'tampered cookie rejected'); jar = good;
env.FAMILY_PASSWORD = 'new'; r = await call(fam, 'GET', { action: 'me' }); ok(r.code === 401, 'changing password signs everyone out'); env.FAMILY_PASSWORD = 'rock on';
r = await call(fam, 'GET', { action: 'me' }, null, { Origin: 'https://evil.com' }); ok(r.code === 403, 'other sites blocked');
for (let i = 0; i < 12; i++) r = await call(fam, 'POST', { action: 'login' }, { name: 'x', password: 'guess' + i }); ok(r.code === 429, 'password guessing limited');

// leaderboard
const song = { id: 'foo-fighters-everlong-abc12', title: 'Everlong', artist: 'Foo Fighters' };
const post = (name, entries, ip = '5.5.5.5') => call(sc, 'POST', {}, { song, name, entries }, { 'CF-Connecting-IP': ip });
r = await post('Jordan', [{ part: 'drums', diff: 'expert', score: 9000, hits: 90, total: 100, streak: 50 }, { part: 'vocals', diff: 'medium', score: 3000, hits: 20, total: 30, streak: 10 }]);
ok(r.code === 200 && r.body.ranks.length === 2 && r.body.ranks.every(x => x.rank === 1), 'post two parts, both #1');
r = await post('Sam <b>', [{ part: 'drums', diff: 'expert', score: 12000, hits: 95, total: 100, streak: 60 }]); ok(r.body.ranks[0].rank === 1, 'higher score takes #1');
r = await post('Pat', [{ part: 'drums', diff: 'expert', score: 9000, hits: 90, total: 100, streak: 5 }]); ok(r.body.ranks[0].rank === 3, 'ties rank behind the earlier score');
r = await post('Cheat', [{ part: 'drums', diff: 'expert', score: 999999, hits: 100, total: 100, streak: 100 }]); ok(r.code === 400, 'impossible score rejected');
r = await call(sc, 'GET', { song: song.id, part: 'drums', diff: 'expert' });
ok(r.body.rows.map(x => x.name).join() === 'Sam b,Jordan,Pat' && r.body.rows[1].acc === 90, 'top list ordered, name cleaned');
r = await call(sc, 'GET', { list: 'songs' }); ok(r.body.songs.length === 1 && r.body.songs[0].title === 'Everlong', 'song list');
for (let i = 0; i < 105; i++) await post('P' + i, [{ part: 'guitar', diff: 'easy', score: 100 + i, hits: 1, total: 100, streak: 1 }], 'ip' + i);
r = await post('Low', [{ part: 'guitar', diff: 'easy', score: 1, hits: 1, total: 100, streak: 1 }], 'lowip'); ok(r.body.ranks[0].rank === null, 'outside top 100 reported');
const count = (await env.DB.prepare("SELECT COUNT(*) AS c FROM scores WHERE part='guitar'").first()).c; ok(count === 100, 'board trimmed to 100');
for (let i = 0; i < 31; i++) r = await post('Spam', [{ part: 'bass', diff: 'easy', score: 10, hits: 1, total: 10, streak: 1 }], 'spammer'); ok(r.code === 429, 'post rate limit');
r = await call(sc, 'GET', { song: '../x', part: 'drums', diff: 'expert' }); ok(r.code === 400, 'bad song id rejected');
const bare = { ...env }; delete bare.DB; r = await sc.onRequest({ request: new Request('https://a.dev/api/scores?list=songs', { headers: { Origin: 'https://a.dev' } }), env: bare });
ok(r.status === 500 && /DB/.test((await r.json()).error), 'missing D1 binding named');
console.log(fails ? fails + ' FAILED' : 'ALL PASS');

// the Worker entry: /api routes reach the handlers, everything else falls through to the static files
{
  const tmp = path.join(os.tmpdir(), 'bl-index.mjs');
  fs.writeFileSync(tmp, fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8')
    .replace("'./api/family.js'", JSON.stringify(pathToFileURL(path.join(os.tmpdir(), 'bl-family.mjs')).href))
    .replace("'./api/scores.js'", JSON.stringify(pathToFileURL(path.join(os.tmpdir(), 'bl-scores.mjs')).href)));
  const worker = (await import(pathToFileURL(tmp).href + '?' + Date.now())).default;
  const withAssets = Object.assign({ ASSETS: { fetch: async () => new Response('the game page', { headers: { 'Content-Type': 'text/html' } }) } }, env);
  const head = { Origin: 'https://backlit.workers.dev', Cookie: jar };
  let res = await worker.fetch(new Request('https://backlit.workers.dev/index.html', { headers: head }), withAssets);
  ok((await res.text()) === 'the game page', 'static files served by the assets system');
  res = await worker.fetch(new Request('https://backlit.workers.dev/api/family?action=me', { headers: { Origin: head.Origin } }), withAssets);
  ok(res.status === 401 && (await res.json()).error === 'sign in first', 'api/family reaches the family server');
  res = await worker.fetch(new Request('https://backlit.workers.dev/api/scores?list=songs', { headers: head }), withAssets);
  ok((await res.json()).songs.length === 1, 'api/scores reaches the leaderboard');
  console.log(fails ? fails + ' FAILED' : 'ALL PASS (worker routing too)');
}
