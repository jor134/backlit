# BACKLIT

Rock Band style rhythm game. Hosted on Cloudflare Pages, deployed from GitHub.

## What goes where

```
public/                 the game itself (everything players download)
  index.html
  sw.js
  manifest.webmanifest
  icon-192.png
  icon-512.png
functions/api/          server code Cloudflare runs (players never see it)
  family.js             family song server: sign-in + songs from R2
  scores.js             leaderboards, stored in D1
tests/                  checks you can run with Node (not deployed)
README.md
```

## Cloudflare setup (one time)

1. **R2 bucket for songs.** R2 > Create bucket (e.g. `backlit-songs`). Upload song zips named `Artist - Title.zip`.
   Optional: put them in a folder like `songs/` and set `SONGS_PREFIX` below.
2. **D1 database for leaderboards.** Storage & Databases > D1 > Create (e.g. `backlit`). No tables to make; the game creates them.
3. **Pages project.** Workers & Pages > Create > Pages > Connect to Git > pick this repo.
   - Framework preset: None
   - Build command: leave empty
   - Build output directory: `public`
4. **Bindings** (Pages project > Settings > Bindings), for Production:
   - R2 bucket, variable name `SONGS`, bucket `backlit-songs`
   - D1 database, variable name `DB`, database `backlit`
5. **Variables and secrets** (Pages project > Settings > Variables and secrets), for Production, type Secret:
   - `FAMILY_PASSWORD` the password family members type in
   - `SESSION_SECRET` any random text, 32+ characters (changing it signs everyone out)
   - `SONGS_PREFIX` optional, e.g. `songs/`
6. **Redeploy** (Deployments > latest > Retry deployment) so the settings take effect.

If something is missing, the game's error message names it.

## NAS

Point your NAS's cloud sync (Synology Cloud Sync, QNAP HBS) at the R2 bucket as "S3 compatible" storage,
one-way upload. Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Create an R2 API token with
read and write access to the bucket for it (R2 > Manage API tokens).

## Tests

```
node tests/core.test.js
node tests/functions.test.mjs
```
