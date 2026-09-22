// BACKLIT Worker entry point.
// Static files in public/ are served automatically by Cloudflare's assets system.
// This Worker only handles the two /api routes, which is what lets the project have bindings
// (R2 bucket SONGS, D1 database DB) — a Worker with static assets and no code can't have them.
import { onRequest as family } from './api/family.js';
import { onRequest as scores } from './api/scores.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/family') return family({ request, env });
    if (url.pathname === '/api/scores') return scores({ request, env });
    return env.ASSETS.fetch(request);
  }
};
