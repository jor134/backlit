// Headless test for src/room.js (band rooms) with fake websockets. Run: node tests/room.test.mjs
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os'; import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(os.tmpdir(), 'bl-room.mjs'); fs.copyFileSync(path.join(here, '..', 'src', 'room.js'), tmp);
let fails = 0; const ok = (c, m) => { console.log(c ? 'ok' : 'FAIL', m); if (!c) fails++; };

class FakeWS {
  constructor() { this.sent = []; this.handlers = {}; }
  accept() {}
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { (this.handlers.close || []).forEach(f => f()); }
  addEventListener(k, f) { (this.handlers[k] ||= []).push(f); }
  emit(obj) { (this.handlers.message || []).forEach(f => f({ data: JSON.stringify(obj) })); }
  last(t) { return [...this.sent].reverse().find(m => m.t === t); }
}
// Workers allow a 101 websocket-upgrade Response; Node's built-in Response does not, so stand one in
const NodeResponse = globalThis.Response;
globalThis.Response = class { constructor(body, init = {}) { if (init.status >= 200) return new NodeResponse(body, init); this.status = init.status; this.webSocket = init.webSocket; } };
globalThis.WebSocketPair = function () { const server = new FakeWS(); server.client = {}; return { 0: server.client, 1: server }; };
const { Room } = await import(pathToFileURL(tmp).href);

const room = new Room({}, {});
const join = async name => {
  const req = { headers: { get: k => k === 'Upgrade' ? 'websocket' : null }, url: 'https://x/api/room?code=ABCD&name=' + encodeURIComponent(name) };
  const before = new Set(room.players.keys());
  await room.fetch(req);
  const p = [...room.players.values()].find(q => !before.has(q.id));
  return p.ws;
};
const host = await join('Jordan'), guest = await join('Sam'), watcher = await join('Kid');
ok(room.players.size === 3 && host.last('you').id === room.hostId, 'three joined, first is host');

host.emit({ t: 'part', part: 'drums' }); guest.emit({ t: 'part', part: 'drums' });
ok([...room.players.values()].filter(p => p.part === 'drums').length === 1, 'an instrument can only be claimed once');
guest.emit({ t: 'part', part: 'guitar' });

guest.emit({ t: 'song', song: { id: 'sneaky-song-1', title: 'Nope' } });
ok(room.song === null, 'only the host picks the song');
host.emit({ t: 'song', song: { id: 'everlong-abc12', title: 'Everlong', artist: 'Foo Fighters', key: 'songs/x.zip' } });
ok(room.song.id === 'everlong-abc12' && guest.last('state').song.title === 'Everlong', 'song reaches the band');

host.emit({ t: 'ready', ok: true }); host.emit({ t: 'have', ok: true });
host.emit({ t: 'start' });
ok(!room.startAt, 'start blocked while a player is not ready');
guest.emit({ t: 'have', ok: true }); guest.emit({ t: 'ready', ok: true });
host.emit({ t: 'start' });
const go = guest.last('go');
ok(go && go.startAt > Date.now() + 3000 && go.song.id === 'everlong-abc12', 'start sends a shared start time to everyone');
ok(watcher.last('go') && !room.players.get(watcher.last('you').id).part, 'a player with no instrument still sees the countdown');

const t0 = Date.now(); host.emit({ t: 'ping', c: t0 });
const pong = host.last('pong'); ok(pong.c === t0 && Math.abs(pong.now - Date.now()) < 1000, 'ping answered with server time');

host.emit({ t: 'score', score: 4200, streak: 30, acc: 91 });
ok(room.players.get(host.last('you').id).score === 4200, 'live score recorded');

host.emit({ t: 'done', score: 8000, acc: 92, streak: 40, hits: 90, total: 100, diff: 'expert' });
ok(!guest.last('state').finished, 'not finished while the guitarist is still playing');
guest.emit({ t: 'done', score: 5000, acc: 80, streak: 20, hits: 70, total: 100, diff: 'hard' });
const st = guest.last('state');
ok(st.finished && st.players.filter(p => p.result).length === 2, 'finished once every player with an instrument is done');

host.close();
ok(room.hostId !== undefined && room.players.size === 2 && room.hostId === guest.last('state').host, 'host leaving hands the room to someone else');
host.sent.length = 0;
room.onMessage(room.players.get(guest.last('you').id), { t: 'song', song: { id: 'new-song-1', title: 'Next' } });
ok(room.song.id === 'new-song-1' && [...room.players.values()].every(p => !p.ready && !p.result), 'new song resets ready flags and results');
console.log(fails ? fails + ' FAILED' : 'ALL PASS');
