import type { IceServerConfig, IncomingSignal } from "@dropflow/shared";
import type { DropFlowSocket } from "../lib/socket";
import { PeerLink, type LinkEvents } from "./PeerLink";

export class SignalingHub {
  private readonly links = new Map<string, PeerLink>();
  private authorized = new Set<string>();
  private selfId: string | null = null;
  private iceServers: RTCIceServer[] = [];

  constructor(
    private readonly socket: DropFlowSocket,
    private readonly events: LinkEvents,
  ) {
    socket.on("signal", (signal) => this.onSignal(signal));
  }

  setIdentity(selfId: string | null, iceServers: IceServerConfig[]) {
    this.iceServers = iceServers as RTCIceServer[];
    if (selfId !== this.selfId) {
      this.closeAll();
      this.selfId = selfId;
    }
  }

  setPeers(peerIds: string[]) {
    this.authorized = new Set(peerIds);
    for (const [peerId, link] of this.links) {
      if (!this.authorized.has(peerId)) {
        link.close();
        this.links.delete(peerId);
      }
    }
  }

  isAuthorized(peerId: string) {
    return this.authorized.has(peerId);
  }

  get(peerId: string): PeerLink | undefined {
    return this.links.get(peerId);
  }

  link(peerId: string): PeerLink {
    if (!this.selfId || !this.authorized.has(peerId)) throw new Error("peer-not-authorized");
    let link = this.links.get(peerId);
    if (!link) {
      link = new PeerLink(
        peerId,
        this.selfId,
        () => this.iceServers,
        (signal) => this.socket.emit("signal", signal),
        this.events,
      );
      this.links.set(peerId, link);
    }
    return link;
  }

  closeLink(peerId: string) {
    this.links.get(peerId)?.close();
  }

  closeAll() {
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }

  private onSignal(signal: IncomingSignal) {
    if (!this.authorized.has(signal.from)) return;
    const existing = this.links.get(signal.from);
    if (!existing && signal.kind !== "offer") return;
    const link = existing ?? this.link(signal.from);
    void link.handleSignal(signal);
  }
}
