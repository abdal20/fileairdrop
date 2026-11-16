import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { io as ioClient, type Socket } from "socket.io-client";
import type {
  AckResult,
  ClientToServerEvents,
  IncomingSignal,
  PeerInfo,
  RoomInfo,
  ServerToClientEvents,
  SessionReady,
} from "@dropflow/shared";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildIceServers } from "../src/rtc/iceServers.js";
import { createSocketServer } from "../src/socket/index.js";
import { parseSignal } from "../src/socket/validate.js";
import { isPrivateIp } from "../src/discovery/registry.js";
import { guessDeviceType, parseBrowser, parseOs } from "../src/discovery/device.js";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface TestClient {
  socket: ClientSocket;
  ready: SessionReady;
  peers: PeerInfo[];
  waitForPeers: (predicate: (peers: PeerInfo[]) => boolean, timeoutMs?: number) => Promise<PeerInfo[]>;
  signals: IncomingSignal[];
}

interface Harness {
  url: string;
  http: HttpServer;
  close: () => Promise<void>;
  clients: TestClient[];
}

async function startServer(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({ SESSION_GRACE_MS: "300", ...env } as NodeJS.ProcessEnv);
  const app = createApp(config.clientOrigins);
  const http = createServer(app);
  const { io } = createSocketServer(http, config);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const harness: Harness = {
    url: `http://127.0.0.1:${port}`,
    http,
    clients: [],
    close: async () => {
      for (const client of harness.clients) client.socket.disconnect();
      io.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  return harness;
}

function connect(harness: Harness, auth: Record<string, string> = {}): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket: ClientSocket = ioClient(harness.url, {
      transports: ["websocket"],
      auth,
      forceNew: true,
      reconnection: false,
    });
    const listeners = new Set<() => void>();
    const client: TestClient = {
      socket,
      ready: undefined as unknown as SessionReady,
      peers: [],
      signals: [],
      waitForPeers: (predicate, timeoutMs = 2000) =>
        new Promise((res, rej) => {
          if (predicate(client.peers)) return res(client.peers);
          const timer = setTimeout(() => {
            listeners.delete(check);
            rej(new Error(`timed out waiting for peers, have ${JSON.stringify(client.peers)}`));
          }, timeoutMs);
          const check = () => {
            if (predicate(client.peers)) {
              clearTimeout(timer);
              listeners.delete(check);
              res(client.peers);
            }
          };
          listeners.add(check);
        }),
    };
    socket.on("peers:update", ({ peers }) => {
      client.peers = peers;
      for (const listener of [...listeners]) listener();
    });
    socket.on("signal", (signal) => client.signals.push(signal));
    socket.once("session:ready", (ready) => {
      client.ready = ready;
      harness.clients.push(client);
      resolve(client);
    });
    socket.once("connect_error", reject);
  });
}

function emitAck<T>(client: TestClient, event: string, payload: unknown): Promise<AckResult<T>> {
  return new Promise((resolve) => {
    (client.socket.emit as (e: string, p: unknown, ack: (r: AckResult<T>) => void) => void)(
      event,
      payload,
      resolve,
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ids = (peers: PeerInfo[]) => peers.map((p) => p.id).sort();

async function pairInRoom(harness: Harness) {
  const a = await connect(harness);
  const b = await connect(harness);
  const created = await emitAck<{ room: RoomInfo }>(a, "room:create", {});
  assert.ok(created.ok);
  const joined = await emitAck<{ room: RoomInfo }>(b, "room:join", { token: created.room.token });
  assert.ok(joined.ok);
  await a.waitForPeers((p) => p.length === 1);
  await b.waitForPeers((p) => p.length === 1);
  return { a, b, room: created.room };
}

describe("health endpoint", () => {
  let harness: Harness;
  before(async () => (harness = await startServer()));
  after(() => harness.close());

  test("GET /health returns ok JSON", async () => {
    const res = await fetch(`${harness.url}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
  });
});

describe("discovery", () => {
  let harness: Harness;
  before(async () => (harness = await startServer()));
  after(() => harness.close());

  test("session:ready gives a temporary identity and friendly name", async () => {
    const a = await connect(harness, { deviceType: "mobile" });
    assert.match(a.ready.self.id, /^[0-9a-f-]{36}$/);
    assert.match(a.ready.self.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.equal(a.ready.self.deviceType, "mobile");
    assert.equal(a.ready.resumed, false);
    assert.equal(a.ready.features.network, "opt-in");
    assert.equal(a.ready.features.networkSuggested, true);
    assert.equal(a.ready.membership.network, false);
  });

  test("devices are not visible to each other by default", async () => {
    const a = await connect(harness);
    const b = await connect(harness);
    await sleep(150);
    assert.equal(a.peers.length, 0);
    assert.equal(b.peers.length, 0);
  });

  test("room members see each other, outsiders do not", async () => {
    const { a, b } = await pairInRoom(harness);
    const outsider = await connect(harness);
    await sleep(150);
    assert.deepEqual(ids(a.peers), [b.ready.self.id]);
    assert.deepEqual(ids(b.peers), [a.ready.self.id]);
    assert.equal(outsider.peers.length, 0);
    assert.deepEqual(a.peers[0].via, ["room"]);
  });

  test("peer payloads never include IP addresses", async () => {
    const { a } = await pairInRoom(harness);
    const json = JSON.stringify(a.peers);
    assert.ok(!json.includes("127.0.0.1"));
    assert.ok(!/"ip"/i.test(json));
  });

  test("room code redeems once and then rotates", async () => {
    const a = await connect(harness);
    const b = await connect(harness);
    const c = await connect(harness);
    const created = await emitAck<{ room: RoomInfo }>(a, "room:create", {});
    assert.ok(created.ok && created.room.code);
    const code = created.room.code;

    const first = await emitAck<{ room: RoomInfo }>(b, "room:redeem", { code });
    assert.ok(first.ok);
    assert.notEqual(first.room.code, code);

    const second = await emitAck<{ room: RoomInfo }>(c, "room:redeem", { code });
    assert.deepEqual(second, { ok: false, error: "invalid-code" });

    await a.waitForPeers((p) => p.length === 1);
    assert.equal(c.peers.length, 0);
  });

  test("invalid tokens and codes are rejected", async () => {
    const a = await connect(harness);
    assert.deepEqual(await emitAck(a, "room:join", { token: "short" }), {
      ok: false,
      error: "invalid-payload",
    });
    assert.deepEqual(await emitAck(a, "room:join", { token: "x".repeat(43) }), {
      ok: false,
      error: "room-not-found",
    });
    assert.deepEqual(await emitAck(a, "room:redeem", { code: "abc" }), {
      ok: false,
      error: "invalid-code",
    });
  });

  test("code redemption is rate limited", async () => {
    const a = await connect(harness);
    const results: AckResult[] = [];
    for (let i = 0; i < 8; i++) results.push(await emitAck(a, "room:redeem", { code: "000000" }));
    const limited = results.filter((r) => !r.ok && r.error === "rate-limited");
    assert.ok(limited.length >= 3, `expected rate limiting, got ${JSON.stringify(results)}`);
  });

  test("devices disappear when they disconnect", async () => {
    const { a, b } = await pairInRoom(harness);
    b.socket.disconnect();
    await a.waitForPeers((p) => p.length === 0);
  });

  test("reconnecting with resume credentials keeps identity without duplicates", async () => {
    const { a, b } = await pairInRoom(harness);
    const auth = { sessionId: b.ready.sessionId, resumeToken: b.ready.resumeToken };
    b.socket.disconnect();
    await a.waitForPeers((p) => p.length === 0);

    const b2 = await connect(harness, auth);
    assert.equal(b2.ready.resumed, true);
    assert.equal(b2.ready.self.id, b.ready.self.id);
    assert.equal(b2.ready.self.name, b.ready.self.name);
    const peers = await a.waitForPeers((p) => p.length === 1);
    assert.deepEqual(ids(peers), [b.ready.self.id]);
    assert.equal(b2.ready.membership.rooms.length, 1);
  });

  test("a second socket with the same session replaces the first", async () => {
    const { a, b } = await pairInRoom(harness);
    let replaced = false;
    b.socket.on("session:replaced", () => (replaced = true));
    const b2 = await connect(harness, {
      sessionId: b.ready.sessionId,
      resumeToken: b.ready.resumeToken,
    });
    await sleep(150);
    assert.equal(replaced, true);
    assert.equal(b2.ready.self.id, b.ready.self.id);
    assert.equal(a.peers.length, 1);
  });

  test("a wrong resume token creates a fresh identity", async () => {
    const a = await connect(harness);
    const b = await connect(harness, { sessionId: a.ready.sessionId, resumeToken: "nope" });
    assert.equal(b.ready.resumed, false);
    assert.notEqual(b.ready.self.id, a.ready.self.id);
  });

  test("sessions expire after the grace period", async () => {
    const a = await connect(harness);
    const auth = { sessionId: a.ready.sessionId, resumeToken: a.ready.resumeToken };
    a.socket.disconnect();
    await sleep(500);
    const again = await connect(harness, auth);
    assert.equal(again.ready.resumed, false);
  });

  test("leaving a room hides peers", async () => {
    const { a, b, room } = await pairInRoom(harness);
    assert.deepEqual(await emitAck(b, "room:leave", { roomId: room.roomId }), { ok: true });
    await a.waitForPeers((p) => p.length === 0);
  });

  test("dev group is explicit opt-in", async () => {
    const a = await connect(harness);
    const b = await connect(harness);
    await sleep(100);
    assert.equal(a.peers.length, 0);
    assert.deepEqual(await emitAck(a, "dev:join", {}), { ok: true });
    assert.deepEqual(await emitAck(b, "dev:join", {}), { ok: true });
    const peers = await a.waitForPeers((p) => p.some((x) => x.id === b.ready.self.id));
    assert.ok(peers.find((x) => x.id === b.ready.self.id)?.via.includes("dev"));
    await emitAck(a, "dev:leave", {});
    await emitAck(b, "dev:leave", {});
  });
});

describe("signaling", () => {
  let harness: Harness;
  before(async () => (harness = await startServer()));
  after(() => harness.close());

  test("signals are relayed between peers in the same group", async () => {
    const { a, b } = await pairInRoom(harness);
    a.socket.emit("signal", {
      to: b.ready.self.id,
      connId: "conn_12345678",
      kind: "offer",
      sdp: "v=0\r\n",
    });
    await sleep(150);
    assert.equal(b.signals.length, 1);
    assert.equal(b.signals[0].from, a.ready.self.id);
    assert.equal(b.signals[0].kind, "offer");
  });

  test("signals to devices outside your groups are dropped", async () => {
    const a = await connect(harness);
    const stranger = await connect(harness);
    a.socket.emit("signal", {
      to: stranger.ready.self.id,
      connId: "conn_12345678",
      kind: "offer",
      sdp: "v=0\r\n",
    });
    await sleep(150);
    assert.equal(stranger.signals.length, 0);
  });

  test("malformed signals are dropped", async () => {
    const { a, b } = await pairInRoom(harness);
    const bad: unknown[] = [
      null,
      "hello",
      { to: b.ready.self.id, connId: "x", kind: "offer", sdp: "v=0" },
      { to: b.ready.self.id, connId: "conn_12345678", kind: "evil", sdp: "v=0" },
      { to: b.ready.self.id, connId: "conn_12345678", kind: "offer", sdp: "a".repeat(40_000) },
      { to: b.ready.self.id, connId: "conn_12345678", kind: "candidate", candidate: { candidate: 5 } },
    ];
    for (const payload of bad) (a.socket.emit as (e: string, p: unknown) => void)("signal", payload);
    await sleep(150);
    assert.equal(b.signals.length, 0);
  });

  test("signal flooding is rate limited", async () => {
    const { a, b } = await pairInRoom(harness);
    let limited = false;
    a.socket.on("rate:limited", () => (limited = true));
    for (let i = 0; i < 400; i++) {
      a.socket.emit("signal", {
        to: b.ready.self.id,
        connId: "conn_12345678",
        kind: "candidate",
        candidate: null,
      });
    }
    await sleep(300);
    assert.equal(limited, true);
    assert.ok(b.signals.length < 400);
  });
});

describe("optional features", () => {
  test("dev group can be disabled", async () => {
    const harness = await startServer({ DEV_GROUP_ENABLED: "false" });
    try {
      const a = await connect(harness);
      assert.equal(a.ready.features.devGroup, false);
      assert.deepEqual(await emitAck(a, "dev:join", {}), { ok: false, error: "dev-group-disabled" });
    } finally {
      await harness.close();
    }
  });

  test("network discovery in auto mode groups everyone on the network", async () => {
    const harness = await startServer({ NETWORK_DISCOVERY: "auto" });
    try {
      const a = await connect(harness);
      const b = await connect(harness);
      const peers = await a.waitForPeers((p) => p.length === 1);
      assert.deepEqual(peers[0].via, ["network"]);
      assert.equal(b.ready.membership.network, true);
    } finally {
      await harness.close();
    }
  });
});

describe("network discovery switch", () => {
  test("opt-in: devices on the same network see each other only after both turn it on", async () => {
    const harness = await startServer();
    try {
      const a = await connect(harness);
      const b = await connect(harness);
      await sleep(150);
      assert.equal(a.peers.length, 0);

      assert.deepEqual(await emitAck(a, "network:join", {}), { ok: true });
      await sleep(150);
      assert.equal(a.peers.length, 0);

      assert.deepEqual(await emitAck(b, "network:join", {}), { ok: true });
      const peers = await a.waitForPeers((p) => p.length === 1);
      assert.deepEqual(peers[0].via, ["network"]);

      assert.deepEqual(await emitAck(b, "network:leave", {}), { ok: true });
      await a.waitForPeers((p) => p.length === 0);
    } finally {
      await harness.close();
    }
  });

  test("opt-in choice survives a reconnect", async () => {
    const harness = await startServer();
    try {
      const a = await connect(harness);
      const b = await connect(harness);
      await emitAck(a, "network:join", {});
      await emitAck(b, "network:join", {});
      await a.waitForPeers((p) => p.length === 1);
      const auth = { sessionId: b.ready.sessionId, resumeToken: b.ready.resumeToken };
      b.socket.disconnect();
      await a.waitForPeers((p) => p.length === 0);
      const b2 = await connect(harness, auth);
      assert.equal(b2.ready.membership.network, true);
      await a.waitForPeers((p) => p.length === 1);
    } finally {
      await harness.close();
    }
  });

  test("off: the switch is refused", async () => {
    const harness = await startServer({ NETWORK_DISCOVERY: "off" });
    try {
      const a = await connect(harness);
      assert.equal(a.ready.features.network, "off");
      assert.equal(a.ready.features.networkSuggested, false);
      assert.deepEqual(await emitAck(a, "network:join", {}), { ok: false, error: "network-disabled" });
    } finally {
      await harness.close();
    }
  });

  test("local browsers get the server's LAN addresses, remote ones would not", async () => {
    const harness = await startServer();
    try {
      const a = await connect(harness);
      assert.ok(Array.isArray(a.ready.lanAddresses));
      for (const ip of a.ready.lanAddresses) assert.match(ip, /^(10|172|192)\./);
    } finally {
      await harness.close();
    }
  });
});

describe("helpers", () => {
  test("parseSignal accepts valid candidates and end-of-candidates", () => {
    const to = "0b3c0d40-2f69-4d0e-9a4c-1f0f8d1f0a11";
    assert.ok(
      parseSignal({
        to,
        connId: "conn_12345678",
        kind: "candidate",
        candidate: { candidate: "candidate:1 1 udp 1 x.local 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      }),
    );
    assert.ok(parseSignal({ to, connId: "conn_12345678", kind: "candidate", candidate: null }));
  });

  test("private IP detection", () => {
    for (const ip of ["10.0.0.4", "192.168.1.20", "172.20.1.1", "127.0.0.1", "::1", "::ffff:192.168.0.2", "fd00::1"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2001:4860::8888"]) assert.equal(isPrivateIp(ip), false, ip);
  });

  test("user agent parsing gives coarse labels", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0";
    assert.equal(parseOs(iphone), "iOS");
    assert.equal(parseBrowser(iphone), "Safari");
    assert.equal(guessDeviceType(iphone), "mobile");
    assert.equal(parseOs(edge), "Windows");
    assert.equal(parseBrowser(edge), "Edge");
    assert.equal(guessDeviceType(edge), "desktop");
  });

  test("TURN REST credentials are generated from a shared secret", () => {
    const config = loadConfig({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_SECRET: "s3cret",
    } as NodeJS.ProcessEnv);
    const servers = buildIceServers(config, "device-1");
    const turn = servers.find((s) => s.username);
    assert.ok(turn);
    assert.match(turn.username!, /^\d+:device-1$/);
    assert.ok(turn.credential && turn.credential.length > 10);
  });
});
