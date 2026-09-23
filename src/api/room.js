// BACKLIT band rooms: one Durable Object per room code.
// Players are in different houses, each on their own copy of the song, so the room only carries
// who is in the band, which song, a shared start time, and live scores.
const MAX_PLAYERS = 6;
const PARTS = ['guitar', 'bass', 'drums', 'vocals'];
const LEAD_MS = 6000; // countdown before a song starts

export class Room {
  constructor(state, env) { this.state = state; this.env = env; this.players = new Map(); this.song = null; this.hostId = null; this.startAt = 0; this.lastSend = 0; }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.players.size >= MAX_PLAYERS) return new Response('room full', { status: 409 });
    const name = (new URL(request.url).searchParams.get('name') || 'player').slice(0, 16);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const id = Math.random().toString(36).slice(2, 8);
    const p = { id, name, part: null, ready: false, hasSong: false, score: 0, streak: 0, acc: 0, done: false, result: null, ws: server };
    this.players.set(id, p);
    if (!this.hostId || !this.players.has(this.hostId)) this.hostId = id;
    server.send(JSON.stringify({ t: 'you', id, now: Date.now() }));
    server.addEventListener('message', e => { try { this.onMessage(p, JSON.parse(e.data)); } catch (err) {} });
    const gone = () => { this.players.delete(id); if (this.hostId === id) this.hostId = [...this.players.keys()][0] || null; this.send(true); };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    this.send(true);
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(p, m) {
    const isHost = p.id === this.hostId;
    switch (m.t) {
      case 'ping': p.ws.send(JSON.stringify({ t: 'pong', c: m.c, now: Date.now() })); return;
      case 'part': {
        const part = PARTS.includes(m.part) ? m.part : null;
        if (part && [...this.players.values()].some(q => q !== p && q.part === part)) return;
        p.part = part; p.ready = false; break;
      }
      case 'have': p.hasSong = !!m.ok; break;
      case 'ready': p.ready = !!m.ok; break;
      case 'song': {
        if (!isHost) return;
        this.song = m.song && m.song.id ? { id: String(m.song.id).slice(0, 140), title: String(m.song.title || '').slice(0, 80), artist: String(m.song.artist || '').slice(0, 80), key: m.song.key ? String(m.song.key).slice(0, 200) : null } : null;
        this.startAt = 0;
        for (const q of this.players.values()) { q.ready = false; q.hasSong = false; q.done = false; q.result = null; q.score = 0; q.streak = 0; q.acc = 0; }
        break;
      }
      case 'start': {
        if (!isHost || !this.song) return;
        const band = [...this.players.values()].filter(q => q.part);
        if (!band.length || !band.every(q => q.ready && q.hasSong)) return;
        this.startAt = Date.now() + LEAD_MS;
        for (const q of this.players.values()) { q.done = false; q.result = null; q.score = 0; q.streak = 0; q.acc = 0; }
        this.broadcast({ t: 'go', startAt: this.startAt, song: this.song });
        break;
      }
      case 'score': p.score = +m.score || 0; p.streak = +m.streak || 0; p.acc = +m.acc || 0; this.send(false); return;
      case 'done': {
        p.done = true; p.score = +m.score || 0;
        p.result = { part: m.part || p.part, diff: String(m.diff || '').slice(0, 8), score: +m.score || 0, acc: +m.acc || 0, streak: +m.streak || 0, hits: +m.hits || 0, total: +m.total || 0 };
        this.watchStragglers();
        break;
      }
      case 'leave': p.ws.close(1000, 'left'); return;
      default: return;
    }
    this.send(true);
  }

  // someone whose laptop slept or whose browser tab was buried never reports back:
  // don't leave the rest of the band waiting on the results screen for ever
  watchStragglers() {
    clearTimeout(this.finishTimer);
    const band = [...this.players.values()].filter(q => q.part);
    if (!band.length || band.every(q => q.done)) return;
    this.finishTimer = setTimeout(() => {
      for (const q of this.players.values()) if (q.part && !q.done) { q.done = true; q.result = { part: q.part, diff: '', score: q.score, acc: q.acc, streak: q.streak, hits: 0, total: 0, dropped: true }; }
      this.send(true);
    }, 90000);
  }

  state_() {
    const band = [...this.players.values()].filter(q => q.part);
    return { t: 'state', host: this.hostId, song: this.song, startAt: this.startAt,
      finished: band.length > 0 && band.every(q => q.done),
      players: [...this.players.values()].map(q => ({ id: q.id, name: q.name, part: q.part, ready: q.ready, hasSong: q.hasSong, score: q.score, streak: q.streak, acc: q.acc, done: q.done, result: q.result })) };
  }
  send(force) { // live scores are chatty: only every 400ms unless something real changed
    const now = Date.now();
    if (!force && now - this.lastSend < 400) return;
    this.lastSend = now; this.broadcast(this.state_());
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const q of this.players.values()) { try { q.ws.send(s); } catch (e) {} }
  }
}
