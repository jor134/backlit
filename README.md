# BACKLIT

Rock Band style rhythm game. Runs on Cloudflare as a Worker with static assets, deployed from GitHub.

## What goes where

```
public/               the game itself (what players' browsers load)
  index.html
  sw.js
  manifest.webmanifest
  icon-192.png
  icon-512.png
src/
  index.js            the Worker: sends /api/... to the code below, everything else to public/
  api/family.js       family song server: sign-in + songs from the R2 bucket
  api/scores.js       leaderboards, stored in D1
wrangler.jsonc        Cloudflare settings: which bucket and database to connect
tests/                checks you can run with Node (not deployed)
README.md
```

## Cloudflare setup (one time)

1. **R2 bucket for songs.** R2 > Create bucket (e.g. `backlit-songs`). Upload song zips named `Artist - Title.zip`.
2. **D1 database for leaderboards.** Storage & Databases > D1 > Create (e.g. `backlit`). Copy its database ID.
   No tables to create; the game makes them on first use.
3. **Edit `wrangler.jsonc`** in this repo: put your bucket name and the D1 database ID in it.
   Bindings must be in this file. A Git deploy rewrites the Worker's bindings from it, so ones added
   only in the dashboard get wiped.
4. **Create the Worker.** Workers & Pages > Create > Import a repository > pick this repo.
   No build command is needed; `wrangler.jsonc` describes everything.
5. **Add the secrets** (Worker > Settings > Variables and Secrets), type Secret:
   - `FAMILY_PASSWORD` the password family members type in
   - `SESSION_SECRET` any random text, 32+ characters (changing it signs everyone out)
6. **Redeploy** so the settings take effect.

If something is missing, the game's error message names it.

Optional: if songs sit in a folder inside the bucket, uncomment `SONGS_PREFIX` in `wrangler.jsonc`.

## NAS

Point your NAS's cloud sync (Synology Cloud Sync, QNAP HBS) at the R2 bucket as "S3 compatible" storage,
one-way upload. Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Create an R2 API token with
read and write access to the bucket for it (R2 > Manage API tokens). The game itself needs no token.

## Tests

```
node tests/core.test.js
node tests/api.test.mjs
```
