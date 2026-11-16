import type {
  AckResult,
  DeviceInfo,
  IceServerConfig,
  MembershipState,
  PeerInfo,
  RoomInfo,
  SessionReady,
} from "@dropflow/shared";
import { createSocket, type DropFlowSocket } from "../lib/socket";
import { detectDeviceType } from "./deviceType";
import {
  loadNetworkPreference,
  loadSession,
  saveNetworkPreference,
  saveSession,
  type StoredSession,
} from "./storage";
import { Store } from "./store";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface DiscoveryState {
  status: ConnectionStatus;
  self: DeviceInfo | null;
  peers: PeerInfo[];
  membership: MembershipState;
  features: SessionReady["features"];
  iceServers: IceServerConfig[];
  lanAddresses: string[];
  notice: string | null;
}

const ERROR_TEXT: Record<string, string> = {
  "invalid-code": "That code didn't work. Codes expire after 5 minutes and work once.",
  "room-not-found": "That pairing link has expired.",
  "room-full": "That room is full.",
  "too-many-rooms": "You're already in the maximum number of rooms.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  "dev-group-disabled": "The development group is turned off on this server.",
  "network-disabled": "Finding devices on your network is turned off on this server.",
  timeout: "The server didn't respond. Check your connection.",
};

export function describeError(code: string): string {
  return ERROR_TEXT[code] ?? "Something went wrong. Please try again.";
}

type AckEvent =
  | "room:create"
  | "room:join"
  | "room:redeem"
  | "room:code"
  | "room:leave"
  | "dev:join"
  | "dev:leave"
  | "network:join"
  | "network:leave";

export class DiscoveryClient {
  readonly store = new Store<DiscoveryState>({
    status: "connecting",
    self: null,
    peers: [],
    membership: { dev: false, network: false, rooms: [] },
    features: { devGroup: false, network: "off", networkSuggested: false },
    iceServers: [],
    lanAddresses: [],
    notice: null,
  });

  readonly socket: DropFlowSocket;
  private stored: StoredSession = loadSession();
  private readonly deviceType = detectDeviceType();

  constructor() {
    this.socket = createSocket(() => ({
      sessionId: this.stored.sessionId,
      resumeToken: this.stored.resumeToken,
      deviceType: this.deviceType,
    }));
    this.bind();
  }

  start() {
    window.addEventListener("hashchange", () => void this.joinFromHash());
    this.socket.connect();
  }

  private bind() {
    const s = this.socket;
    s.on("connect", () => this.store.set({ status: "connected" }));
    s.on("disconnect", () => this.store.set({ status: "disconnected", peers: [] }));
    s.on("connect_error", () => this.store.set({ status: "disconnected" }));
    s.io.on("reconnect_attempt", () => this.store.set({ status: "connecting" }));

    s.on("session:ready", (ready) => void this.onReady(ready));
    s.on("session:replaced", () => {
      this.stored = { ...this.stored, sessionId: undefined, resumeToken: undefined };
      saveSession(this.stored);
      this.store.set({ notice: "DropFlow was opened in another tab, so this tab got a new identity." });
      setTimeout(() => s.connect(), 500);
    });
    s.on("peers:update", ({ peers }) => this.store.set({ peers }));
    s.on("membership:update", (membership) => {
      this.store.set({ membership });
      this.persistMembership(membership);
    });
    s.on("rate:limited", () => this.store.set({ notice: describeError("rate-limited") }));
  }

  private async onReady(ready: SessionReady) {
    this.stored = { ...this.stored, sessionId: ready.sessionId, resumeToken: ready.resumeToken };
    saveSession(this.stored);
    this.store.set({
      self: ready.self,
      features: ready.features,
      iceServers: ready.iceServers,
      membership: ready.membership,
      lanAddresses: ready.lanAddresses ?? [],
    });

    if (!ready.resumed) {
      const tokens = [...this.stored.roomTokens];
      this.stored.roomTokens = [];
      for (const token of tokens) await this.call("room:join", { token });
      if (this.stored.dev && ready.features.devGroup) await this.call("dev:join", {});
    }

    if (ready.features.network === "opt-in") {
      const wanted = loadNetworkPreference() ?? ready.features.networkSuggested;
      if (wanted && !ready.membership.network) await this.call("network:join", {});
      if (!wanted && ready.membership.network) await this.call("network:leave", {});
    }

    await this.joinFromHash();
  }

  private async joinFromHash() {
    const token = new URLSearchParams(location.hash.slice(1)).get("join");
    if (!token || !this.socket.connected || !this.store.get().self) return;
    history.replaceState(null, "", location.pathname + location.search);
    const result = await this.call<{ room: RoomInfo }>("room:join", { token });
    this.store.set({ notice: result.ok ? "Paired! Devices in this room can now see you." : describeError(result.error) });
  }

  private persistMembership(membership: MembershipState) {
    this.stored = {
      ...this.stored,
      roomTokens: membership.rooms.map((room) => room.token),
      dev: membership.dev,
    };
    saveSession(this.stored);
  }

  private call<T extends object = Record<string, never>>(
    event: AckEvent,
    payload: object,
  ): Promise<AckResult<T>> {
    return new Promise((resolve) => {
      if (!this.socket.connected) return resolve({ ok: false, error: "timeout" });
      (this.socket.timeout(8000).emit as unknown as (
        e: string,
        p: object,
        cb: (err: Error | null, res: AckResult<T>) => void,
      ) => void)(event, payload, (err, res) => resolve(err ? { ok: false, error: "timeout" } : res));
    });
  }

  clearNotice() {
    this.store.set({ notice: null });
  }

  createRoom() {
    return this.call<{ room: RoomInfo }>("room:create", {});
  }

  redeemCode(code: string) {
    return this.call<{ room: RoomInfo }>("room:redeem", { code });
  }

  refreshCode(roomId: string) {
    return this.call<{ room: RoomInfo }>("room:code", { roomId });
  }

  leaveRoom(roomId: string) {
    return this.call("room:leave", { roomId });
  }

  async setNetworkVisible(on: boolean) {
    const result = await this.call(on ? "network:join" : "network:leave", {});
    if (result.ok) saveNetworkPreference(on);
    return result;
  }

  joinDev() {
    return this.call("dev:join", {});
  }

  leaveDev() {
    return this.call("dev:leave", {});
  }
}
