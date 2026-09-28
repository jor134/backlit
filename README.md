# SLOT 64

A Nintendo 64 player for Pier Nine. Cartridges are stored on the user's own device
in IndexedDB. Nothing copyrighted is committed to this repo or served from it.

## Deploy (Cloudflare Workers)

This is a **Worker with static assets**, not a Pages project. A Worker that has
only assets and no script can't take bindings at all — that's what the
"Bindings cannot be added" error means. Adding `src/index.js` plus `main` in
`wrangler.jsonc` is what makes bindings available.

```
wrangler.jsonc          name, main, assets, R2 binding
src/index.js            the Worker: /api/* routes, everything else -> ASSETS
src/auth.js             session signing and password check
public/                 index.html, layout.js, sw.js, manifest, icons, _headers
test-worker.mjs         node test-worker.mjs — routing and auth against fakes
test-layout.js          node test-layout.js — touch overlay geometry
```

Connect the repo under Workers → Builds. No build command; Wrangler bundles the
two source files itself.

### Bindings

**With Workers Builds, `wrangler.jsonc` is the source of truth.** Bindings added
in the dashboard are wiped on the next deploy unless they're also declared in
the file. Secrets are the exception — they live only in the dashboard.

| Name | Where | Notes |
| --- | --- | --- |
| `ROMS` | `wrangler.jsonc` | set `bucket_name` to your real bucket |
| `ASSETS` | `wrangler.jsonc` | already declared |
| `FAMILY_PASSWORD` | dashboard secret | the shared password |
| `SESSION_SECRET` | dashboard secret | long random string; rotating it logs everyone out |

Add the secrets under Settings → Variables and Secrets *after* the first deploy
succeeds, since the Worker needs a script before it will accept them.

Upload cartridges by dragging them into the bucket in the R2 dashboard.
`.z64 .n64 .v64 .rom .zip` are listed; anything else is ignored, so cover art
in the same bucket is harmless.

### Access model

The bucket has no public URL. `run_worker_first` sends every `/api/*` request
to the Worker before any asset is served, and the ROM routes reject anything
without a valid session. The cookie is `"<expiry>.<HMAC of expiry>"` signed
with `SESSION_SECRET` — nothing secret is in it and it can't be extended
without the secret. 30 day expiry, HttpOnly, Secure, SameSite=Lax.

Password and signature comparisons both run in constant time, so response
timing can't be used to guess either. A failed login sleeps ~900ms; that is the
only brute-force defence, as there's no attempt counter (that would need KV or
a Durable Object). Rotate `FAMILY_PASSWORD` if it leaks; rotate
`SESSION_SECRET` to force everyone to sign in again.

Loading files off your own phone still works while locked. The password only
gates the shared bucket.

### ROM caching

A cartridge downloads once and is kept in IndexedDB, so it plays offline and
never re-downloads. Range requests are supported, so an interrupted download
resumes. The service worker skips `/api/*` entirely — session checks must hit
the network, and ROM bodies are far too large for the cache API.

## VR (Quest 3)

An **Enter VR** button appears on the shelf page only where WebXR exists, so
the phone build is untouched. It puts the emulator's picture on a floating
panel, flat or curved, carried by holding both grips.

Built on the **WebXR Layers API**: the panel is an `XRQuadLayer` or
`XRCylinderLayer` composited by the headset at its own resolution. That is
sharper than drawing a textured quad in a normal WebXR session, and much less
code — no projection matrices, no stereo maths, no depth buffer.

### What VR here can't be

Not stereo 3D, not head-aiming, no gun in your hand. Projects like the
GoldenEye and Perfect Dark VR ports achieve that by building from a *game
decompilation*: they have the source, so they can hook the camera matrix and
render the world twice. An emulator exposes a framebuffer and a controller
port and nothing else — there is no camera to hook. This is structural, not a
missing feature, and it holds for every game.

### The preserveDrawingBuffer patch

`vr.js` patches `HTMLCanvasElement.prototype.getContext` to force
`preserveDrawingBuffer: true` on WebGL contexts, and **must load before the
main script** for that to land before EmulatorJS creates its canvas. Without
it a WebGL canvas is undefined as a texture source after compositing and the
panel renders black. EmulatorJS gives no way to pass context attributes, so
there's no cleaner route. If the panel is black, check the script order first.

### Controls

Both Quest controllers and a Bluetooth gamepad map through the same binding
table the touch overlay uses, so indices verified against a running game apply
everywhere. A Bluetooth pad also works outside VR, on the phone.

| Input | N64 |
| --- | --- |
| Left thumbstick | analog stick |
| Right thumbstick | C buttons |
| Right trigger / grip | A / B |
| Left trigger / grip | Z / L |
| Right A / B | R / Start |
| Left X / Y | D-pad up / down |
| Both grips + move | carry the panel |

The d-pad is poorly served by Quest controllers — a Bluetooth pad covers it
properly. Run `node test-vr.mjs` to exercise the mapping without a headset.

### What stayed on Render

The netplay signaling server. EmulatorJS speaks socket.io, which needs a
persistent connection; Workers can't hold one, and Durable Objects do
WebSockets but not the socket.io protocol. Porting it means reimplementing
that protocol, which isn't worth it.

## Decisions you'd otherwise have to reverse-engineer

**ROMs are never bundled.** Committing them would be distribution to anyone who
finds the URL, regardless of who owns the cartridges. IndexedDB gets the same
result for a single user: load once, persists offline. If you ever change this,
make the repo private *and* turn on Vercel Authentication — a private repo alone
still deploys to a public URL.

**Page reloads to switch games.** EmulatorJS does not unload cleanly. Launching
writes the cart id to `sessionStorage` under `boot` and reloads; the boot path is
read on startup. Deliberate, not a bug.

**Netplay game IDs come from the ROM header, not the cart record.** See the
Netplay section below.

**Threads are off.** `EJS_threads` needs `SharedArrayBuffer`, which needs COOP +
COEP headers. Turning those on makes the page cross-origin isolated, which then
blocks the EmulatorJS CDN unless every asset returns `Cross-Origin-Resource-Policy`.
To use threads you must self-host the `data/` folder from the EmulatorJS release
and add both headers to `vercel.json`. Untested on iOS; Safari's SharedArrayBuffer
support is the weak link.

**Core version is pinned to `stable`.** `https://cdn.emulatorjs.org/stable/data/`.
Swap `stable` for a fixed version number (e.g. `4.2.3`) if a CDN update ever
breaks playback — that pin is the first thing to try when something regresses.

**Rotation is a CSS transform, not the Fullscreen API.** iPhone Safari does not
support fullscreen on `<video>`-less elements, and iOS ignores the manifest's
`orientation` field. The `rotated` class rotates the stage 90° instead.
`screen.orientation.lock()` is called anyway for Android, wrapped in try/catch.

**`navigator.storage.persist()` is requested on load.** Without it, iOS Safari
clears site data after ~7 days idle, taking the cartridges with it. Installing to
the home screen is the more reliable protection — hence the prompt on iOS.

## Netplay

Off by default. Paste a server address into the Netplay field on the shelf page
and it turns on for every game; clear the field to turn it off. The setting lives
in `localStorage`, so each device sets its own.

### Standing up a server (Render, browser only — no CLI)

1. Open `https://github.com/EmulatorJS/EmulatorJS-Netplay` and fork it to your
   own account with the Fork button.
2. On Render, create a new **Web Service** and connect that fork.
3. Runtime Node. Build command `npm install`, start command `npm start` — check
   the repo's README, since these are the repo's defaults and may change.
4. Deploy. Render gives you a `https://something.onrender.com` address.
5. Paste that address into the Netplay field in SLOT 64, on both phones.

Render's free tier spins a service down when idle. The first person to open a
room waits roughly a minute for cold start; once a socket is connected it stays
up. If that's annoying, a paid instance removes it.

### Why not Upstash

The other games in this portfolio use Upstash as WebRTC signaling because they
own their netcode. EmulatorJS doesn't work that way — it expects a persistent
socket.io connection at `EJS_netplayServer`. Upstash is REST-accessed KV and
can't hold a socket, and neither can a Vercel function. Nothing to fix here;
it's the wrong shape of service.

### Game matching

`EJS_gameID` is what pairs two players into a room, so it must be identical on
both devices. It's computed from the N64 cartridge header — the internal game
name, cart id, region and version at offsets `0x20`–`0x3F` — normalised across
the `.z64`, `.n64` and `.v64` byte orders, then hashed. A `.z64` and a `.v64` of
the same game produce the same id. Different games and different regions don't.

An earlier build derived this from a random per-device uuid, which meant two
players could never match. If netplay silently fails to find a room, this is the
first thing to check.

### Button mapping

Verified by testing each index against a running game, not inferred from the
RetroPad table. For `mupen64plus_next`:

| N64 control | RetroPad index | Note |
| --- | --- | --- |
| A | 0 | RetroPad B — *not* 8 |
| B | 1 | RetroPad Y |
| Z | 12 | |
| L / R | 10 / 11 | |
| Start | 3 | |
| D-pad U/D/L/R | 4 / 5 / 6 / 7 | |
| Analog stick | 16–19 | X+, X−, Y+, Y− |
| C buttons | 20–23 | the core reads these as the right stick |

The face buttons follow the SNES-style arrangement. Index 8 (RetroPad A) is
accepted by the core but produces nothing on this system — an early build used
it for A, which looked like a dead button rather than a wrong mapping.

Indices 24–29 are EmulatorJS hotkeys (quick save, quick load, slot) and never
reach the game.

Turn on **Button debug** on the shelf page and a **Remap** button appears in the
in-game toolbar: every control's index is adjustable, with a Test button that
fires it at the running game, and duplicates highlighted in red.

### TURN

The ICE list includes Google STUN plus the OpenRelay public TURN servers. STUN
alone usually covers two phones on the same wifi. Across cellular carriers,
peer-to-peer often fails and the connection falls back to TURN — OpenRelay is
free, rate-limited and not something to rely on. If cross-country play matters,
get your own TURN credentials (Metered, Twilio, or coturn on the same host) and
replace the entries in `boot()`.

### Expect problems

EmulatorJS's netplay was rewritten because the previous version was unreliable,
and there's no evidence the rewrite has been validated against the N64 core
specifically — lighter cores are the common case. Emulator netplay is lockstep:
both machines run the same frame together, so one phone stalling stalls both.
This may simply not work well, and that isn't fixable from this end.

## Save data

Save states and battery saves are handled by EmulatorJS's own menu (the icon in
the corner during play) and stored in its own IndexedDB. They are not in the
`slot64` database and survive ejecting a cartridge. There is no export/import
wired up; if you want save files portable across devices, that's a separate build.

## Known limits

- `.zip` support is unreliable when the ROM arrives as a blob URL without a
  filename. Use uncompressed `.z64` where possible.
- No per-game settings, cheats, or controller remapping beyond the EmulatorJS
  defaults.
