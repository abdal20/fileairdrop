import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type {
  NetworkDiscoveryMode,
  DeviceInfo,
  DeviceType,
  GroupKind,
  MembershipState,
  PeerInfo,
  RoomInfo,
} from "@dropflow/shared";
import { friendlyName, parseBrowser, parseOs, resolveDeviceType } from "./device.js";

export const ROOM_CODE_TTL_MS = 5 * 60_000;
export const MAX_ROOMS_PER_SESSION = 5;
export const MAX_ROOM_MEMBERS = 20;
export const MAX_ROOMS = 10_000;

const DEV_GROUP = "dev";

interface Session {
  sessionId: string;
  resumeToken: string;
  device: DeviceInfo;
  socketId: string | null;
  groups: Set<string>;
  networkGroup: string | null;
  networkOptIn: boolean;
  ip: string;
  expiryTimer: NodeJS.Timeout | null;
}

interface Room {
  id: string;
  token: string;
  code: string | null;
  codeExpiresAt: number | null;
}

export interface ConnectInput {
  socketId: string;
  sessionId?: unknown;
  resumeToken?: unknown;
  deviceTypeHint?: unknown;
  userAgent: string;
  ip: string;
}

export interface ConnectResult {
  session: Readonly<Session>;
  resumed: boolean;
  replacedSocketId: string | null;
}

export type RegistryError =
  | "room-not-found"
  | "invalid-code"
  | "room-full"
  | "too-many-rooms"
  | "server-busy"
  | "not-a-member"
  | "dev-group-disabled"
  | "network-disabled"
  | "unknown-session";

export class RegistryFailure extends Error {
  constructor(public readonly code: RegistryError) {
    super(code);
  }
}

export interface RegistryOptions {
  graceMs: number;
  devGroupEnabled: boolean;
  networkDiscovery: NetworkDiscoveryMode;
  suggestNetworkOnPrivateIp?: boolean;
  onChange: (sessionIds: Set<string>) => void;
  onExpire?: (sessionId: string) => void;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
}

export function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export class Registry {
  private readonly sessions = new Map<string, Session>();
  private readonly byDeviceId = new Map<string, string>();
  private readonly groups = new Map<string, Set<string>>();
  private readonly rooms = new Map<string, Room>();
  private readonly roomsByToken = new Map<string, string>();
  private readonly roomsByCode = new Map<string, string>();
  private readonly ipSalt = randomBytes(16).toString("hex");

  constructor(private readonly options: RegistryOptions) {}

  featuresFor(sessionId: string) {
    const ip = this.sessions.get(sessionId)?.ip ?? "";
    const mode = this.options.networkDiscovery;
    return {
      devGroup: this.options.devGroupEnabled,
      network: mode,
      networkSuggested: mode !== "off" && (this.options.suggestNetworkOnPrivateIp ?? true) && isPrivateIp(ip),
    };
  }

  connect(input: ConnectInput): ConnectResult {
    const existing =
      typeof input.sessionId === "string" ? this.sessions.get(input.sessionId) : undefined;
    const canResume =
      existing !== undefined &&
      typeof input.resumeToken === "string" &&
      safeEqual(existing.resumeToken, input.resumeToken);

    if (existing && canResume) {
      const replacedSocketId = existing.socketId;
      if (existing.expiryTimer) clearTimeout(existing.expiryTimer);
      existing.expiryTimer = null;
      existing.socketId = input.socketId;
      this.updateNetworkGroup(existing, input.ip);
      for (const key of existing.groups) this.groupSet(key).add(existing.sessionId);
      this.notifyGroupsOf(existing);
      return { session: existing, resumed: true, replacedSocketId };
    }

    const session: Session = {
      sessionId: randomUUID(),
      resumeToken: randomBytes(32).toString("base64url"),
      device: this.describeDevice(input),
      socketId: input.socketId,
      groups: new Set(),
      networkGroup: null,
      networkOptIn: false,
      ip: input.ip,
      expiryTimer: null,
    };
    this.sessions.set(session.sessionId, session);
    this.byDeviceId.set(session.device.id, session.sessionId);
    this.updateNetworkGroup(session, input.ip);
    this.notifyGroupsOf(session);
    return { session, resumed: false, replacedSocketId: null };
  }

  disconnect(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.socketId !== socketId) return;
    session.socketId = null;
    for (const key of session.groups) this.groups.get(key)?.delete(sessionId);
    this.notifyGroupsOf(session);
    session.expiryTimer = setTimeout(() => this.expire(sessionId), this.options.graceMs);
    session.expiryTimer.unref?.();
  }

  expire(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.socketId !== null) return;
    for (const key of [...session.groups]) this.leaveGroup(session, key);
    this.sessions.delete(sessionId);
    this.byDeviceId.delete(session.device.id);
    this.options.onExpire?.(sessionId);
  }

  getSession(sessionId: string): Readonly<Session> | undefined {
    return this.sessions.get(sessionId);
  }

  sessionIdForDevice(deviceId: string): string | undefined {
    return this.byDeviceId.get(deviceId);
  }

  isOnline(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.socketId != null;
  }

  peersOf(sessionId: string): PeerInfo[] {
    const session = this.sessions.get(sessionId);
    if (!session || session.socketId === null) return [];
    const via = new Map<string, Set<GroupKind>>();
    for (const key of session.groups) {
      const members = this.groups.get(key);
      if (!members) continue;
      for (const other of members) {
        if (other === sessionId) continue;
        let kinds = via.get(other);
        if (!kinds) via.set(other, (kinds = new Set()));
        kinds.add(this.kindOf(key));
      }
    }
    const peers: PeerInfo[] = [];
    for (const [otherId, kinds] of via) {
      const other = this.sessions.get(otherId);
      if (!other || other.socketId === null) continue;
      peers.push({ ...other.device, via: [...kinds] });
    }
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  canSignal(fromSessionId: string, toDeviceId: string): string | null {
    const toSessionId = this.byDeviceId.get(toDeviceId);
    if (!toSessionId || toSessionId === fromSessionId) return null;
    const from = this.sessions.get(fromSessionId);
    const to = this.sessions.get(toSessionId);
    if (!from || !to || from.socketId === null || to.socketId === null) return null;
    for (const key of from.groups) {
      if (to.groups.has(key) && this.groups.get(key)?.has(toSessionId)) return to.socketId;
    }
    return null;
  }

  membershipOf(sessionId: string): MembershipState {
    const session = this.sessions.get(sessionId);
    const rooms: RoomInfo[] = [];
    if (session) {
      for (const key of session.groups) {
        if (!key.startsWith("room:")) continue;
        const room = this.rooms.get(key.slice(5));
        if (room) rooms.push(this.roomInfo(room));
      }
    }
    return {
      dev: session?.groups.has(DEV_GROUP) ?? false,
      network: session?.networkGroup !== null && session?.networkGroup !== undefined,
      rooms,
    };
  }

  createRoom(sessionId: string): RoomInfo {
    const session = this.requireSession(sessionId);
    if (this.roomCount(session) >= MAX_ROOMS_PER_SESSION) throw new RegistryFailure("too-many-rooms");
    if (this.rooms.size >= MAX_ROOMS) throw new RegistryFailure("server-busy");
    const room: Room = {
      id: randomUUID(),
      token: randomBytes(32).toString("base64url"),
      code: null,
      codeExpiresAt: null,
    };
    this.rooms.set(room.id, room);
    this.roomsByToken.set(room.token, room.id);
    this.issueCode(room);
    this.joinGroup(session, `room:${room.id}`);
    return this.roomInfo(room);
  }

  joinRoomByToken(sessionId: string, token: string): RoomInfo {
    const session = this.requireSession(sessionId);
    const roomId = this.roomsByToken.get(token);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) throw new RegistryFailure("room-not-found");
    return this.addToRoom(session, room);
  }

  redeemCode(sessionId: string, code: string): RoomInfo {
    const session = this.requireSession(sessionId);
    this.sweepCodes();
    const roomId = this.roomsByCode.get(code);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) throw new RegistryFailure("invalid-code");
    const info = this.addToRoom(session, room);
    this.issueCode(room);
    this.notifyGroup(`room:${room.id}`);
    return { ...info, code: room.code, codeExpiresAt: room.codeExpiresAt };
  }

  refreshCode(sessionId: string, roomId: string): RoomInfo {
    const session = this.requireSession(sessionId);
    const room = this.rooms.get(roomId);
    if (!room || !session.groups.has(`room:${roomId}`)) throw new RegistryFailure("not-a-member");
    this.issueCode(room);
    this.notifyGroup(`room:${room.id}`);
    return this.roomInfo(room);
  }

  leaveRoom(sessionId: string, roomId: string): void {
    const session = this.requireSession(sessionId);
    const key = `room:${roomId}`;
    if (!session.groups.has(key)) throw new RegistryFailure("not-a-member");
    this.leaveGroup(session, key);
  }

  joinNetwork(sessionId: string): void {
    if (this.options.networkDiscovery === "off") throw new RegistryFailure("network-disabled");
    const session = this.requireSession(sessionId);
    session.networkOptIn = true;
    this.updateNetworkGroup(session, session.ip);
  }

  leaveNetwork(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.networkOptIn = false;
    if (this.options.networkDiscovery === "auto" || !session.networkGroup) return;
    const key = session.networkGroup;
    session.networkGroup = null;
    this.leaveGroup(session, key);
  }

  joinDev(sessionId: string): void {
    if (!this.options.devGroupEnabled) throw new RegistryFailure("dev-group-disabled");
    this.joinGroup(this.requireSession(sessionId), DEV_GROUP);
  }

  leaveDev(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (session.groups.has(DEV_GROUP)) this.leaveGroup(session, DEV_GROUP);
  }

  private describeDevice(input: ConnectInput): DeviceInfo {
    const deviceType: DeviceType = resolveDeviceType(input.deviceTypeHint, input.userAgent);
    let os = parseOs(input.userAgent);
    if (deviceType === "tablet" && os === "macOS") os = "iPadOS";
    return {
      id: randomUUID(),
      name: friendlyName(),
      deviceType,
      os,
      browser: parseBrowser(input.userAgent),
    };
  }

  private addToRoom(session: Session, room: Room): RoomInfo {
    const key = `room:${room.id}`;
    if (!session.groups.has(key)) {
      if (this.roomCount(session) >= MAX_ROOMS_PER_SESSION) throw new RegistryFailure("too-many-rooms");
      if (this.memberCount(room) >= MAX_ROOM_MEMBERS) throw new RegistryFailure("room-full");
      this.joinGroup(session, key);
    }
    return this.roomInfo(room);
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RegistryFailure("unknown-session");
    return session;
  }

  private roomCount(session: Session): number {
    let count = 0;
    for (const key of session.groups) if (key.startsWith("room:")) count++;
    return count;
  }

  private memberCount(room: Room): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.groups.has(`room:${room.id}`)) count++;
    }
    return count;
  }

  private roomInfo(room: Room): RoomInfo {
    const live = room.codeExpiresAt !== null && room.codeExpiresAt > Date.now();
    return {
      roomId: room.id,
      token: room.token,
      code: live ? room.code : null,
      codeExpiresAt: live ? room.codeExpiresAt : null,
      memberCount: this.memberCount(room),
    };
  }

  private issueCode(room: Room) {
    if (room.code) this.roomsByCode.delete(room.code);
    this.sweepCodes();
    let code: string;
    do {
      code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    } while (this.roomsByCode.has(code));
    room.code = code;
    room.codeExpiresAt = Date.now() + ROOM_CODE_TTL_MS;
    this.roomsByCode.set(code, room.id);
  }

  private sweepCodes() {
    const now = Date.now();
    for (const [code, roomId] of this.roomsByCode) {
      const room = this.rooms.get(roomId);
      if (!room || room.codeExpiresAt === null || room.codeExpiresAt <= now) {
        this.roomsByCode.delete(code);
        if (room) {
          room.code = null;
          room.codeExpiresAt = null;
        }
      }
    }
  }

  private kindOf(key: string): GroupKind {
    if (key === DEV_GROUP) return "dev";
    if (key.startsWith("net:")) return "network";
    return "room";
  }

  private groupSet(key: string): Set<string> {
    let set = this.groups.get(key);
    if (!set) this.groups.set(key, (set = new Set()));
    return set;
  }

  private joinGroup(session: Session, key: string) {
    session.groups.add(key);
    if (session.socketId !== null) this.groupSet(key).add(session.sessionId);
    this.notifyGroup(key, session.sessionId);
  }

  private leaveGroup(session: Session, key: string) {
    const affected = new Set(this.groups.get(key) ?? []);
    affected.add(session.sessionId);
    session.groups.delete(key);
    const members = this.groups.get(key);
    members?.delete(session.sessionId);
    if (members && members.size === 0) this.groups.delete(key);
    if (key.startsWith("room:")) this.maybeDeleteRoom(key.slice(5));
    this.options.onChange(affected);
  }

  private maybeDeleteRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || this.memberCount(room) > 0) return;
    this.rooms.delete(roomId);
    this.roomsByToken.delete(room.token);
    if (room.code) this.roomsByCode.delete(room.code);
  }

  private updateNetworkGroup(session: Session, ip: string) {
    session.ip = ip;
    const mode = this.options.networkDiscovery;
    if (mode === "off" || (mode === "opt-in" && !session.networkOptIn)) return;
    const normalized = normalizeIp(ip);
    const key = isPrivateIp(normalized)
      ? "net:private"
      : `net:${createHash("sha256").update(this.ipSalt + normalized).digest("hex").slice(0, 32)}`;
    if (session.networkGroup === key) return;
    if (session.networkGroup) this.leaveGroup(session, session.networkGroup);
    session.networkGroup = key;
    this.joinGroup(session, key);
  }

  private notifyGroup(key: string, extra?: string) {
    const affected = new Set(this.groups.get(key) ?? []);
    if (extra) affected.add(extra);
    this.options.onChange(affected);
  }

  private notifyGroupsOf(session: Session) {
    const affected = new Set<string>([session.sessionId]);
    for (const key of session.groups) {
      for (const member of this.groups.get(key) ?? []) affected.add(member);
    }
    this.options.onChange(affected);
  }
}
