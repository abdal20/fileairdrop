import type { Server as HttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { Server, type Socket } from "socket.io";
import type {
  AckResult,
  ClientToServerEvents,
  HandshakeAuth,
  ServerToClientEvents,
} from "@dropflow/shared";
import type { AppConfig } from "../config/env.js";
import { Registry, RegistryFailure } from "../discovery/registry.js";
import { buildIceServers } from "../rtc/iceServers.js";
import { KeyedLimiter, TokenBucket } from "./rateLimit.js";
import { log } from "../log.js";
import { parseCode, parseRoomId, parseSignal, parseToken } from "./validate.js";

interface SocketData {
  sessionId: string;
  ip: string;
}

type DropFlowSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export type DropFlowServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_STRIKES = 20;

function clientIp(socket: DropFlowSocket, trustProxy: boolean): string {
  if (trustProxy) {
    const header = socket.handshake.headers["x-forwarded-for"];
    const value = Array.isArray(header) ? header[0] : header;
    const first = value?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address || "unknown";
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === "IPv4" && !nic.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(nic.address)) {
        out.push(nic.address);
      }
    }
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof RegistryFailure ? error.code : "internal-error";
}

export function createSocketServer(httpServer: HttpServer, config: AppConfig) {
  const io: DropFlowServer = new Server(httpServer, {
    cors: { origin: config.clientOrigins },
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  const connectionsPerIp = new KeyedLimiter(30, 0.5);
  const redeemPerIp = new KeyedLimiter(20, 20 / 60);
  const createPerIp = new KeyedLimiter(10, 10 / 60);

  const registry = new Registry({
    graceMs: config.sessionGraceMs,
    devGroupEnabled: config.devGroupEnabled,
    networkDiscovery: config.networkDiscovery,
    suggestNetworkOnPrivateIp: config.suggestNetworkOnPrivateIp,
    onChange: (sessionIds) => {
      for (const sessionId of sessionIds) pushState(sessionId);
    },
  });

  function pushState(sessionId: string) {
    const session = registry.getSession(sessionId);
    if (!session?.socketId) return;
    const target = io.sockets.sockets.get(session.socketId);
    if (!target) return;
    target.emit("peers:update", { peers: registry.peersOf(sessionId) });
    target.emit("membership:update", registry.membershipOf(sessionId));
  }

  io.use((socket, next) => {
    const ip = clientIp(socket, config.trustProxy);
    if (!connectionsPerIp.take(ip)) return next(new Error("rate-limited"));
    socket.data.ip = ip;
    next();
  });

  io.on("connection", (socket) => {
    const auth = (socket.handshake.auth ?? {}) as HandshakeAuth;
    const userAgent = String(socket.handshake.headers["user-agent"] ?? "").slice(0, 512);

    const { session, resumed, replacedSocketId } = registry.connect({
      socketId: socket.id,
      sessionId: auth.sessionId,
      resumeToken: auth.resumeToken,
      deviceTypeHint: auth.deviceType,
      userAgent,
      ip: socket.data.ip,
    });
    socket.data.sessionId = session.sessionId;

    if (replacedSocketId && replacedSocketId !== socket.id) {
      const old = io.sockets.sockets.get(replacedSocketId);
      old?.emit("session:replaced");
      old?.disconnect(true);
    }

    const deviceId = session.device.id;
    log.info(`[socket] ${resumed ? "resumed" : "connected"} device=${deviceId.slice(0, 8)}`);

    socket.emit("session:ready", {
      self: session.device,
      sessionId: session.sessionId,
      resumeToken: session.resumeToken,
      resumed,
      iceServers: buildIceServers(config, deviceId),
      features: registry.featuresFor(session.sessionId),
      membership: registry.membershipOf(session.sessionId),
      lanAddresses: isLoopback(socket.handshake.address) ? lanAddresses() : [],
    });
    pushState(session.sessionId);

    const general = new TokenBucket(120, 40);
    const signalBucket = new TokenBucket(200, 50);
    const roomBucket = new TokenBucket(10, 10 / 60);
    const redeemBucket = new TokenBucket(5, 5 / 60);
    let strikes = 0;

    function limited(event: string): boolean {
      strikes++;
      socket.emit("rate:limited", { event });
      if (strikes >= MAX_STRIKES) {
        log.warn(`[socket] disconnecting abusive device=${deviceId.slice(0, 8)}`);
        socket.disconnect(true);
      }
      return true;
    }

    socket.use(([event], next) => {
      if (!general.take()) {
        limited(String(event));
        return;
      }
      next();
    });

    function respond<T extends object>(ack: unknown, result: AckResult<T>) {
      if (typeof ack === "function") ack(result);
    }

    function handle<T extends object>(ack: unknown, work: () => AckResult<T>) {
      try {
        respond(ack, work());
      } catch (error) {
        if (!(error instanceof RegistryFailure)) log.error("[socket] handler error", error);
        respond(ack, { ok: false, error: errorMessage(error) });
      }
    }

    const sid = session.sessionId;

    socket.on("room:create", (_payload: unknown, ack: unknown) => {
      if (!roomBucket.take() || !createPerIp.take(socket.data.ip)) {
        limited("room:create");
        return respond(ack, { ok: false, error: "rate-limited" });
      }
      handle(ack, () => ({ ok: true, room: registry.createRoom(sid) }));
    });

    socket.on("room:join", (payload: unknown, ack: unknown) => {
      const token = parseToken(payload);
      if (!token) return respond(ack, { ok: false, error: "invalid-payload" });
      if (!roomBucket.take()) {
        limited("room:join");
        return respond(ack, { ok: false, error: "rate-limited" });
      }
      handle(ack, () => ({ ok: true, room: registry.joinRoomByToken(sid, token) }));
    });

    socket.on("room:redeem", (payload: unknown, ack: unknown) => {
      if (!redeemBucket.take() || !redeemPerIp.take(socket.data.ip)) {
        limited("room:redeem");
        return respond(ack, { ok: false, error: "rate-limited" });
      }
      const code = parseCode(payload);
      if (!code) return respond(ack, { ok: false, error: "invalid-code" });
      handle(ack, () => ({ ok: true, room: registry.redeemCode(sid, code) }));
    });

    socket.on("room:code", (payload: unknown, ack: unknown) => {
      const roomId = parseRoomId(payload);
      if (!roomId) return respond(ack, { ok: false, error: "invalid-payload" });
      if (!roomBucket.take()) {
        limited("room:code");
        return respond(ack, { ok: false, error: "rate-limited" });
      }
      handle(ack, () => ({ ok: true, room: registry.refreshCode(sid, roomId) }));
    });

    socket.on("room:leave", (payload: unknown, ack: unknown) => {
      const roomId = parseRoomId(payload);
      if (!roomId) return respond(ack, { ok: false, error: "invalid-payload" });
      handle(ack, () => {
        registry.leaveRoom(sid, roomId);
        return { ok: true };
      });
    });

    socket.on("dev:join", (_payload: unknown, ack: unknown) => {
      handle(ack, () => {
        registry.joinDev(sid);
        return { ok: true };
      });
    });

    socket.on("network:join", (_payload: unknown, ack: unknown) => {
      if (!roomBucket.take()) {
        limited("network:join");
        return respond(ack, { ok: false, error: "rate-limited" });
      }
      handle(ack, () => {
        registry.joinNetwork(sid);
        return { ok: true };
      });
    });

    socket.on("network:leave", (_payload: unknown, ack: unknown) => {
      handle(ack, () => {
        registry.leaveNetwork(sid);
        return { ok: true };
      });
    });

    socket.on("dev:leave", (_payload: unknown, ack: unknown) => {
      handle(ack, () => {
        registry.leaveDev(sid);
        return { ok: true };
      });
    });

    socket.on("signal", (payload: unknown) => {
      if (!signalBucket.take()) {
        limited("signal");
        return;
      }
      const signal = parseSignal(payload);
      if (!signal) return;
      const targetSocketId = registry.canSignal(sid, signal.to);
      if (!targetSocketId) return;
      const { to: _to, ...rest } = signal;
      io.to(targetSocketId).emit("signal", { ...rest, from: deviceId });
    });

    socket.on("disconnect", (reason) => {
      log.info(`[socket] disconnected device=${deviceId.slice(0, 8)} (${reason})`);
      registry.disconnect(sid, socket.id);
    });
  });

  return { io, registry };
}
