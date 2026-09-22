// BACKLIT family song server: handles /api/family (called from src/index.js).
// Bindings, set in wrangler.jsonc: SONGS = R2 bucket holding the song .zip files,
//   DB = D1 database (used here only to limit sign-in attempts; the leaderboard needs it anyway).
// Secrets, set in the dashboard under Settings > Variables and Secrets:
//   FAMILY_PASSWORD, SESSION_SECRET (32+ random characters). Optional variable SONGS_PREFIX (a folder inside the bucket).
const DAYS = 30;
const te = new TextEncoder();
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers) });
const b64u = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, te.encode(data)));
}
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', te.encode(s)));
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
// changing FAMILY_PASSWORD or SESSION_SECRET signs everyone out
const pwVersion = async env => (await hmac(env.SESSION_SECRET, 'pw:' + env.FAMILY_PASSWORD)).slice(0, 10);
async function makeSession(env, name) {
  const p = b64u(te.encode(JSON.stringify({ n: name, v: await pwVersion(env), e: Date.now() + DAYS * 864e5 })));
  return p + '.' + await hmac(env.SESSION_SECRET, p);
}
async function readSession(env, request) {
  const m = /(?:^|;\s*)bl_s=([^;]+)/.exec(request.headers.get('Cookie') || ''); if (!m) return null;
  const [p, s] = m[1].split('.'); if (!p || !s || !same(s, await hmac(env.SESSION_SECRET, p))) return null;
  try { const o = JSON.parse(new TextDecoder().decode(unb64u(p))); return o.e > Date.now() && o.v === await pwVersion(env) ? o : null; } catch (e) { return null; }
}
const cookie = (v, age) => `bl_s=${v}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const cleanName = n => String(n || '').normalize('NFKC').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
async function limited(env, key, max, windowSec) {
  if (!env.DB) return false;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS hits(k TEXT PRIMARY KEY, n INTEGER, reset INTEGER)').run();
  const now = Date.now();
  const r = await env.DB.prepare('INSERT INTO hits(k,n,reset) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN reset<?3 THEN 1 ELSE n+1 END, reset=CASE WHEN reset<?3 THEN ?2 ELSE reset END RETURNING n')
    .bind(key, now + windowSec * 1000, now).first();
  return !!r && r.n > max;
}

export async function onRequest({ request, env }) {
  const missing = ['FAMILY_PASSWORD', 'SESSION_SECRET'].filter(k => !env[k]);
  if (!env.SONGS) missing.push('SONGS (R2 bucket binding)');
  if (missing.length) return json({ error: 'family server not set up on Cloudflare, missing: ' + missing.join(', ') }, 500);
  if (env.SESSION_SECRET.length < 32) return json({ error: 'SESSION_SECRET must be at least 32 characters' }, 500);

  const url = new URL(request.url), from = request.headers.get('Origin') || request.headers.get('Referer') || '';
  try { if (!from || new URL(from).host !== url.host) return json({ error: 'forbidden' }, 403); } catch (e) { return json({ error: 'forbidden' }, 403); }
  const action = url.searchParams.get('action'), prefix = String(env.SONGS_PREFIX || '').replace(/^\/+/, '');

  try {
    if (request.method === 'POST' && action === 'login') {
      if (await limited(env, 'login:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), 10, 900)) return json({ error: 'too many attempts, wait 15 minutes' }, 429);
      const body = await request.json().catch(() => ({}));
      const name = cleanName(body.name);
      if (!name) return json({ error: 'enter your name' }, 400);
      if (!same(await sha(String(body.password || '')), await sha(env.FAMILY_PASSWORD))) return json({ error: 'wrong family password' }, 401);
      return json({ name }, 200, { 'Set-Cookie': cookie(await makeSession(env, name), DAYS * 86400) });
    }
    if (request.method === 'POST' && action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });

    const s = await readSession(env, request);
    if (!s) return json({ error: 'sign in first' }, 401);
    if (request.method !== 'GET') return json({ error: 'not allowed' }, 405);
    if (action === 'me') return json({ name: s.n });
    if (action === 'list') {
      const songs = []; let cursor;
      for (let i = 0; i < 10; i++) {
        const r = await env.SONGS.list({ prefix: prefix || undefined, cursor, limit: 1000 });
        for (const o of r.objects) if (/\.zip$/i.test(o.key)) songs.push({ key: o.key, size: o.size, etag: o.etag });
        if (!r.truncated) break; cursor = r.cursor;
      }
      return json({ songs });
    }
    if (action === 'file') {
      const key = url.searchParams.get('key') || '';
      if (!/\.zip$/i.test(key) || !key.startsWith(prefix) || key.includes('..')) return json({ error: 'bad song' }, 400);
      const obj = await env.SONGS.get(key);
      if (!obj) return json({ error: 'song not found on the server' }, 404);
      return new Response(obj.body, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(obj.size), 'Cache-Control': 'private, no-store' } });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String(e && e.message || 'server error').slice(0, 120) }, 502);
  }
}
