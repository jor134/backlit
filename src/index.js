// BACKLIT Worker entry point.
// Static files in public/ are served automatically by Cloudflare's assets system.
// This Worker only handles the two /api routes, which is what lets the project have bindings
// (R2 bucket SONGS, D1 database DB) — a Worker with static assets and no code can't have them.
import { onRequest as family, verifySession } from './api/family.js';
import { onRequest as scores } from './api/scores.js';
export { Room } from './room.js';

// a band room: one Durable Object per room code, joined over a websocket
async function room(request, env) {
  if (!env.ROOM) return new Response('band rooms are not set up on Cloudflare (missing ROOM binding)', { status: 500 });
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) return new Response('bad room code', { status: 400 });
  if (env.FAMILY_PASSWORD && env.SESSION_SECRET && !(await verifySession(env, request))) return new Response('sign in first', { status: 401 });
  return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/family') return family({ request, env });
    if (url.pathname === '/api/scores') return scores({ request, env });
    return env.ASSETS.fetch(request);
  }
};
