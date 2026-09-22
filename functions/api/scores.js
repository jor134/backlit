// BACKLIT leaderboards: Cloudflare Pages Function at /api/scores, stored in D1.
// Cloudflare settings for this Pages project:  Bindings: D1 database -> variable name DB
// Tables are created automatically on first use.
// GET  /api/scores?list=songs                       -> songs that have scores
// GET  /api/scores?song=ID&part=drums&diff=expert   -> top 10
// POST /api/scores {song:{id,title,artist},name,entries:[{part,diff,score,hits,total,streak}]} -> ranks
const PARTS = new Set(['guitar', 'bass', 'drums', 'vocals']);
const DIFFS = new Set(['easy', 'medium', 'hard', 'expert']);
const KEEP = 100, SHOW = 10, POSTS_PER_HOUR = 30;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const idOk = s => typeof s === 'string' && /^[a-z0-9-]{3,120}$/.test(s);
const cleanName = n => String(n || '').normalize('NFKC').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const int = x => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : NaN; };

let ready = false;
async function schema(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS scores(id INTEGER PRIMARY KEY AUTOINCREMENT, song TEXT NOT NULL, part TEXT NOT NULL, diff TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL, acc INTEGER, streak INTEGER, date TEXT)'),
    db.prepare('CREATE INDEX IF NOT EXISTS scores_board ON scores(song, part, diff, score DESC, id)'),
    db.prepare('CREATE TABLE IF NOT EXISTS songs(id TEXT PRIMARY KEY, title TEXT, artist TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS hits(k TEXT PRIMARY KEY, n INTEGER, reset INTEGER)')
  ]);
  ready = true;
}
async function limited(db, key, max, windowSec) {
  const now = Date.now();
  const r = await db.prepare('INSERT INTO hits(k,n,reset) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN reset<?3 THEN 1 ELSE n+1 END, reset=CASE WHEN reset<?3 THEN ?2 ELSE reset END RETURNING n')
    .bind(key, now + windowSec * 1000, now).first();
  return !!r && r.n > max;
}

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: 'leaderboard not set up on Cloudflare, missing: DB (D1 database binding)' }, 500);
  const url = new URL(request.url), from = request.headers.get('Origin') || request.headers.get('Referer') || '';
  try { if (!from || new URL(from).host !== url.host) return json({ error: 'forbidden' }, 403); } catch (e) { return json({ error: 'forbidden' }, 403); }
  const db = env.DB;
  try {
    await schema(db);
    if (request.method === 'GET') {
      const q = url.searchParams;
      if (q.get('list') === 'songs') {
        const { results } = await db.prepare('SELECT id, title, artist FROM songs ORDER BY title COLLATE NOCASE').all();
        return json({ songs: results });
      }
      const song = q.get('song'), part = q.get('part'), diff = q.get('diff');
      if (!idOk(song) || !PARTS.has(part) || !DIFFS.has(diff)) return json({ error: 'bad request' }, 400);
      const { results } = await db.prepare('SELECT name, score, acc, streak, date FROM scores WHERE song=?1 AND part=?2 AND diff=?3 ORDER BY score DESC, id ASC LIMIT ?4').bind(song, part, diff, SHOW).all();
      return json({ rows: results });
    }
    if (request.method !== 'POST') return json({ error: 'GET or POST only' }, 405);

    const body = await request.json().catch(() => ({}));
    const song = body.song || {};
    if (!idOk(song.id)) return json({ error: 'unknown song' }, 400);
    const name = cleanName(body.name);
    if (!name) return json({ error: 'enter a name' }, 400);
    if (await limited(db, 'post:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), POSTS_PER_HOUR, 3600)) return json({ error: 'too many posts, try again later' }, 429);

    const date = new Date().toISOString().slice(0, 10), ranks = [], seen = new Set();
    await db.prepare('INSERT INTO songs(id,title,artist) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist')
      .bind(song.id, String(song.title || '').slice(0, 80), String(song.artist || '').slice(0, 80)).run();
    for (const e of (Array.isArray(body.entries) ? body.entries : []).slice(0, 4)) {
      if (!e || !PARTS.has(e.part) || !DIFFS.has(e.diff) || seen.has(e.part)) continue;
      const total = int(e.total), hits = int(e.hits), score = int(e.score), streak = int(e.streak) || 0;
      // plausibility: can't beat the maximum possible score for that many notes
      const maxPer = e.part === 'vocals' ? 400 : 200;
      if (!(total > 0 && total < 20000 && hits >= 0 && hits <= total && score > 0 && score <= total * maxPer && streak >= 0 && streak <= hits)) continue;
      seen.add(e.part);
      const row = await db.prepare('INSERT INTO scores(song,part,diff,name,score,acc,streak,date) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id')
        .bind(song.id, e.part, e.diff, name, score, Math.round(100 * hits / total), streak, date).first();
      const above = await db.prepare('SELECT COUNT(*) AS c FROM scores WHERE song=?1 AND part=?2 AND diff=?3 AND (score>?4 OR (score=?4 AND id<?5))')
        .bind(song.id, e.part, e.diff, score, row.id).first();
      await db.prepare('DELETE FROM scores WHERE song=?1 AND part=?2 AND diff=?3 AND id NOT IN (SELECT id FROM scores WHERE song=?1 AND part=?2 AND diff=?3 ORDER BY score DESC, id ASC LIMIT ?4)')
        .bind(song.id, e.part, e.diff, KEEP).run();
      const rank = above.c + 1;
      ranks.push({ part: e.part, diff: e.diff, score, rank: rank <= KEEP ? rank : null });
    }
    if (!ranks.length) return json({ error: 'no valid scores to post' }, 400);
    return json({ ranks });
  } catch (e) {
    return json({ error: 'leaderboard unavailable' }, 502);
  }
}
