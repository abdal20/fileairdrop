# DropFlow

Send files between your own devices straight from the browser. Open DropFlow on a Mac, PC, iPhone, Android phone or Linux box, pair the devices, then tap a device (or drop files on it) to send. Files go directly from browser to browser over an encrypted WebRTC connection. Nothing to install, no accounts, and the server never sees file contents.

Status: Steps 1–4 are done (project setup, device discovery, WebRTC transfers, and the full transfer UI), plus QR pairing, the "Visible on my network" switch, an iPhone save flow, and a connection route indicator.

## Quick start

You need Node.js 20.12 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173 in two different browsers (or one normal window and one private window). Click **Pair** on one, create a code, and enter it on the other. Each device then shows up as a card on the other one.

For a production-style run on a single port:

```bash
npm run build
npm start          # serves the built app + API on http://localhost:3001
```

## How discovery works

Devices are never visible to strangers by default. The server puts each browser session in zero or more **discovery groups**, and you only see devices that share a group with you.

| Group | How you join | Default |
| --- | --- | --- |
| Pairing room | Create a code, or enter one / open a pairing link | Always available, the secure default |
| Development group | Toggle in the Pair dialog | Available outside production, always opt-in |
| Pairing room | Scan the QR code | Same room, no typing |
| Network group | "Visible on my network" switch | Each device chooses. Suggested on for home/LAN servers, off in production |

**QR code.** The pairing card shows a QR code with the full pairing link. Point the phone camera at it and tap the link. If you opened DropFlow on the computer as `localhost`, the server tells that browser (and only browsers on the same machine) its own LAN address, so the QR code still points somewhere a phone can reach.

**Pairing rooms.** Creating a room gives you a random 256-bit room token and a 6-digit code. The code is a short-lived way to hand over that token: it works **once**, expires after **5 minutes**, and redeeming codes is rate-limited per connection and per IP. A fresh code is issued automatically after each use. "Copy link" shares the full token as `#join=…` in the URL fragment, which browsers never send to the server in HTTP requests. Room membership survives a page refresh.

**Development group.** A shared group for local testing. Anyone who toggles it on can see everyone else who did. It is enabled by default only when `NODE_ENV` is not `production`.

**Visible on my network.** A web page can't scan your Wi-Fi, so "same network" really means "same address as seen by the server". That's the same public IP for an internet server, and a private address (like 192.168.x.x) when the server runs on your own network. Devices that turn on the switch and share that address appear automatically. Be aware that **the same public IP does not always mean the same local network.** Offices, mobile carriers (CGNAT), VPNs, and campus or hotel Wi-Fi can put strangers behind one address. They could see your device and send you requests, but nothing arrives without your Accept. So the switch is per device and remembered in that browser:

- In development or on a LAN server, it starts on when you connect from a private address, so your Mac and iPhone find each other with no pairing.
- With `NODE_ENV=production`, it always starts off.

`NETWORK_DISCOVERY` sets the server mode: `opt-in` (the default, the switch), `auto` (everyone on the same address is grouped, PairDrop style), or `off`. IP addresses are salted and hashed on the server and never sent to clients. Behind a reverse proxy you must set `TRUST_PROXY=true`, or every visitor looks like they share the proxy's address.

**Identities.** Each browser tab gets a temporary random device ID and a friendly name such as "Swift Falcon". The device category (phone, tablet, desktop) comes from browser hints and the user agent, and the OS and browser labels are coarse ("Safari on iOS"). DropFlow never claims to identify exact hardware. A private resume token kept in `sessionStorage` lets a refreshed tab keep the same identity with no duplicate cards. If the same tab is duplicated, the older copy gets a new identity. Sessions are dropped 30 seconds after disconnecting.

## How transfers work

1. The sender's browser opens an `RTCPeerConnection` to the receiver. Socket.IO is used **only** to relay the WebRTC offer/answer and ICE candidates, and the server relays them only between devices that currently share a group.
2. Over a reliable, ordered `RTCDataChannel`, the sender sends a request containing only file names, sizes and types.
3. The receiver sees an incoming-files dialog with the sender's name and each file's name, size and type. **No file bytes are sent until they tap Accept.** Requests time out after 55 seconds. A device that is already busy answers "busy", and too many requests from one device are rate-limited.
4. On Accept, files are sent one at a time:
   - The sender reads each file in 4 MB slices (`Blob.slice`, never the whole file) and sends chunks of up to 256 KB, depending on what the two browsers negotiate, without copying each chunk.
   - Backpressure uses `bufferedAmount` (pausing above 8 MB, resuming below 2 MB through `bufferedAmountLowThreshold`). The sender also never gets more than 48 MB ahead of what the receiver has confirmed writing.
   - Both sides compute SHA-256 as data flows. The receiver checks byte count and hash before keeping the file.
5. The sender shows "Delivered and verified" only after the receiver confirms each file arrived complete with a matching hash.

**Saving files.** In Chrome and Edge on desktop, transfers of 256 MB or more are written straight to disk through the File System Access API: you pick a file or folder when you accept. Everything else is collected as a Blob and then saved. Desktop browsers download it automatically.

iPhones and iPads don't allow automatic downloads, so when files arrive a **Files received** sheet opens with photo previews and a Save button for each file:

- **Over HTTPS,** Save opens the iOS share sheet, where you can choose Save Image (to Photos) or Save to Files. With several files, Save all shares them together.
- **Over plain http,** Save downloads to the Files app (Downloads folder). For photos you can also touch and hold the preview and choose Save to Photos.
- **If you close the sheet,** the files stay in the Transfers panel with Save buttons.

Storage and permission errors cancel the transfer and tell both sides why.

**Connection route.** Each transfer shows how the two devices are connected:

- **Direct · same network**: the best case.
- **Direct · via your router**: the devices couldn't reach each other inside the network, so traffic loops out through the router's public address. This is usually much slower.
- **Relayed through TURN.**

If transfers are slow, check this first.

**Failures handled.** Either side can cancel. Declining, timeouts, the other device closing or refreshing the page, lost connections, the peer going offline, hash mismatches, read errors and save errors all end the transfer with a clear message on both sides. Idle WebRTC connections are closed after 30 seconds. Closing the tab during a transfer asks for confirmation first.

**Queue.** Outgoing batches run one at a time. Extra sends wait as "Queued".

## Security notes

- **Encryption.** WebRTC DataChannels are always encrypted with DTLS (SCTP over DTLS). Only the two browsers have the keys.
- **TURN relays.** Some networks block direct connections, for example strict corporate firewalls or some mobile carriers. A TURN server then relays the traffic. The relay forwards encrypted DTLS packets and **cannot read file contents**, but it does see IP addresses, timing and the amount of data. Without TURN, those devices simply can't connect, and DropFlow says so.
- **What the server sees.** Device names, groups, and signaling messages (SDP and ICE candidates, which include network addresses the browser chooses to expose). The server never sees file names, file contents, or transfer metadata, which all travel inside the encrypted DataChannel. The server stores nothing on disk, and file contents are never logged.
- **Abuse limits.** Socket.IO payloads are capped at 64 KB, and every event is validated. There are token-bucket rate limits per connection (all events, signaling, room actions, code redemption) and per IP (new connections, room creation, code redemption). Connections that keep hitting limits are disconnected.
- **On the receiving side.** Requests and control messages are validated, file names are cleaned of path separators and control characters, unsolicited binary data is dropped (and the connection closed if it keeps coming), and anything beyond the announced file size aborts the transfer.

## Configuration

Copy `server/.env.example` to `server/.env` and edit as needed. Every value has a default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Backend port |
| `HOST` | `0.0.0.0` | Bind address |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Allowed CORS origins (comma separated). Only needed when the client is served from a different origin |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For`. Turn on only behind a reverse proxy you control |
| `DEV_GROUP_ENABLED` | on unless `NODE_ENV=production` | Allow the opt-in development group |
| `NETWORK_DISCOVERY` | `opt-in` | `opt-in` (per-device switch), `auto` (group everyone on the same address) or `off`. The old `PUBLIC_IP_DISCOVERY=true` still means `auto` |
| `SESSION_GRACE_MS` | `30000` | How long a disconnected identity can be resumed |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | STUN servers, comma separated |
| `TURN_URLS` | empty | TURN servers, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349` |
| `TURN_SECRET` | empty | coturn `use-auth-secret` secret. Gives each device short-lived credentials (preferred) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | empty | Static TURN login, if you can't use a secret |
| `TURN_TTL_SECONDS` | `3600` | Lifetime of generated TURN credentials |
| `STATIC_DIR` | `../client/dist` | Built frontend served by `npm start`. Set it empty to serve only the API |

`client/.env.example` has `CLIENT_PORT`, `DEV_SERVER_PROXY_TARGET` (where Vite forwards `/socket.io` in dev) and `VITE_SERVER_URL` (leave empty to use the same origin).

## Tests

```bash
npm run typecheck     # server, client and e2e TypeScript
npm test              # server tests: real Socket.IO clients against a real server
npm run build
npm run test:e2e      # browser tests, starts the dev servers automatically
PERF=1 npm run test:e2e -- -g throughput   # optional speed benchmark (3 × 40 MB)
```

The browser tests need a Chromium. Either run `npx playwright install chromium` once, or use an installed Chrome with `PW_CHANNEL=chrome npm run test:e2e`.

`server/test/server.test.ts` covers the health endpoint, identities, default isolation, room join and leave, single-use code rotation, invalid input, code rate limiting, disconnect removal, resume without duplicates, tab takeover, session expiry, the dev group, the network switch (opt-in, survives reconnects, auto and off modes), LAN address handout, signaling relay and authorization, malformed signals, signal flooding, and the TURN credential format.

`e2e/dropflow.spec.ts` drives two real Chrome browser contexts through the UI. It checks that no bytes are sent before Accept or after Decline (by counting real DataChannel bytes), that a 20 MB file arrives with an identical SHA-256, that progress only moves forward, cancelling from either side, three files including an empty one, queued batches, the receiver refreshing or going offline mid-transfer, automatic same-network discovery and the switch hiding a device, the QR link pairing a second browser, the iPhone save sheet (no automatic download, Save delivers the exact bytes), and the connection-route label.

### Manual checks

1. Open the app in two browsers and pair them with a code. Each appears on the other. Close one: its card disappears within a few seconds. Refresh one: no duplicate card shows up.
2. Open a third browser without pairing. It sees nothing.
3. Send a file. The receiver sees the dialog first, and nothing moves until Accept.
4. Send a large file (a few hundred MB) and watch percentage, bytes, speed and time left. Cancel from either side.
5. Send several files at once. Decline a transfer. Refresh the receiver mid-transfer.

## Testing between a Mac and an iPhone

1. Put both on the same Wi-Fi network.
2. On the Mac, run `npm install` and then `npm run dev:https`. This is HTTPS with a self-signed certificate, which the iPhone needs for the share sheet. Plain `npm run dev` works too, but the iPhone then saves to Files instead of offering Save Image. If macOS asks whether Node may accept incoming connections, allow it.
3. On the Mac, open `https://localhost:5173` and accept the certificate warning.
4. On the iPhone, open the **Network** address Vite printed (e.g. `https://192.168.1.23:5173`) in Safari. Tap **Show Details**, then **visit this website**.
5. With "Visible on my network" on (the default here), both devices should appear on each other's screen. If not, tap **Pair** on the Mac and scan the QR code with the iPhone camera.
6. Mac to iPhone: drop a file on the iPhone card, or click it to choose files. Tap **Accept** on the iPhone. When it finishes, the Files received sheet opens. Tap **Save**, then **Save Image** or **Save to Files**.
7. iPhone to Mac: tap the Mac card, pick photos or files, and accept on the Mac. The file downloads automatically.
8. Look at the route label on the transfer. If it says **via your router** instead of **same network**, that explains slow speeds (see below).

Keep Safari in front and the iPhone screen on during big transfers. iOS slows down or pauses background pages.

If the devices pair but the transfer stays on "Connecting…" and then fails, the network is blocking direct peer-to-peer traffic. Guest Wi-Fi with client isolation does this, for example. Try another network or set up TURN (`TURN_URLS` + `TURN_SECRET`).

Over plain `http://` on a LAN IP, the iPhone isn't in a "secure context". Transfers still work, but Save uses a normal download instead of the share sheet, and Copy link falls back to a copy prompt. `npm run dev:https` (or real HTTPS in production) removes these limits.

## Browser support

Chrome and Edge get everything, including streaming large files straight to disk. Firefox and Safari (macOS and iOS) get everything except direct-to-disk saving, so large files are held in memory until saved, and the accept dialog warns about it for files over 1 GB. Browsers without WebRTC get a clear message, and their send controls are disabled. Only Chrome was tested automatically here. Firefox, Safari and iOS need the manual checks above.

## Known limitations

- Files are sent one after another rather than in parallel, and one device receives one batch at a time (others get "busy").
- Without File System Access (Firefox, Safari, iOS), received files live in memory until saved. Very large files can fail on low-memory phones.
- An interrupted transfer starts over. There is no resume yet.
- Without a TURN server, devices behind strict NATs or firewalls can't connect.
- Rooms, sessions and rate-limit counters live in one server process's memory. A server restart clears them, so devices have to pair again, and you can't run several server instances yet.
- Transfers use one WebRTC connection. If the route label shows "same network" and speed is still low on good Wi-Fi, the next step would be splitting large files across several connections in parallel.
- The iOS share-sheet path hasn't been tested on a real iPhone yet. The automated iPhone test runs in Chrome pretending to be an iPhone, which has no share sheet, so it covers the download fallback.

## What production needs

- **HTTPS** in front of the app, e.g. a reverse proxy such as Caddy or nginx with TLS. Browsers need it for the share sheet, clipboard and file pickers. Proxy WebSocket upgrades for `/socket.io/` and set `TRUST_PROXY=true`.
- **A TURN server** such as coturn on UDP/TCP 3478 plus TLS on 5349 (`turns:`), with `use-auth-secret`, and the same secret in `TURN_SECRET`. Budget bandwidth for relayed transfers.
- **`NODE_ENV=production`**, so the dev group is off unless you explicitly enable it.
- For more than one server instance, a shared store such as Redis for sessions, rooms and rate limits, plus the Socket.IO Redis adapter. Until then, run one instance.
- Basic monitoring of `/health`, and log retention that keeps connection logs short-lived.

## Project structure

```
dropflow/
├── shared/protocol.d.ts          Socket.IO event and payload types used by both sides
├── server/src/
│   ├── index.ts, app.ts          HTTP server, Express app, static hosting
│   ├── config/env.ts             environment parsing
│   ├── discovery/registry.ts     sessions, groups, rooms, codes, visibility
│   ├── discovery/device.ts       friendly names, coarse UA parsing
│   ├── socket/index.ts           Socket.IO handlers, rate limits, signaling relay
│   ├── socket/validate.ts        payload validation
│   ├── socket/rateLimit.ts       token buckets
│   └── rtc/iceServers.ts         STUN/TURN config and TURN REST credentials
├── server/test/server.test.ts
├── client/src/
│   ├── core/                     discovery client, session storage, store
│   ├── rtc/PeerLink.ts           one RTCPeerConnection + DataChannel per peer
│   ├── rtc/SignalingHub.ts       routes signals to authorized peers only
│   ├── transfer/                 protocol, TransferManager, sinks, formatting
│   └── components/               radar, device cards, dialogs, transfer panel
└── e2e/dropflow.spec.ts
```
# fileairdrop
