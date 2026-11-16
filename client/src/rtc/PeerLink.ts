import type { IncomingSignal, OutgoingSignal } from "@dropflow/shared";
import { randomId } from "../lib/random";

export const BUFFER_HIGH = 8 * 1024 * 1024;
export const BUFFER_LOW = 2 * 1024 * 1024;
const DEFAULT_CHUNK = 64 * 1024;
const MAX_CHUNK = 256 * 1024;
const ANSWER_TIMEOUT_MS = 25_000;
const DISCONNECT_GRACE_MS = 8_000;

export type ConnectionRoute = "local" | "internet" | "relay";

const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  return a.endsWith(".local") || PRIVATE_V4.test(a) || a.startsWith("fe80") || a.startsWith("fd") || a.startsWith("fc");
}

export type LinkCloseReason = "closed" | "failed" | "timeout" | "replaced";

export class LinkError extends Error {
  constructor(public readonly reason: LinkCloseReason | "aborted") {
    super(reason);
  }
}

export interface LinkEvents {
  onMessage: (peerId: string, data: string | ArrayBuffer) => void;
  onClose: (peerId: string, reason: LinkCloseReason) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private connId: string | null = null;
  private wasOpen = false;
  private makingOffer = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private waiters: Waiter[] = [];
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly polite: boolean;

  constructor(
    readonly peerId: string,
    selfId: string,
    private readonly iceServers: () => RTCIceServer[],
    private readonly sendSignal: (signal: OutgoingSignal) => void,
    private readonly events: LinkEvents,
  ) {
    this.polite = selfId > peerId;
  }

  get isOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  get isIdle(): boolean {
    return this.pc === null;
  }

  get chunkSize(): number {
    const max = this.pc?.sctp?.maxMessageSize;
    return max && max > 0 ? Math.min(MAX_CHUNK, max) : DEFAULT_CHUNK;
  }

  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  open(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (!this.isOpen) this.teardown("timeout");
        reject(new LinkError("timeout"));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(new LinkError("aborted"));
      };
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((w) => w !== waiter);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      if (!this.pc) void this.startAsOfferer();
    });
  }

  send(text: string) {
    if (!this.channel || this.channel.readyState !== "open") throw new LinkError("closed");
    this.channel.send(text);
  }

  async route(): Promise<ConnectionRoute | null> {
    const pc = this.pc;
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let pair: Record<string, unknown> | undefined;
      stats.forEach((report: Record<string, unknown>) => {
        if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") {
          pair = stats.get(report.selectedCandidatePairId) as Record<string, unknown> | undefined;
        }
      });
      if (!pair) {
        stats.forEach((report: Record<string, unknown>) => {
          if (report.type === "candidate-pair" && report.state === "succeeded" && (report.selected || report.nominated)) {
            pair ??= report;
          }
        });
      }
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId as string) as Record<string, unknown> | undefined;
      const remote = stats.get(pair.remoteCandidateId as string) as Record<string, unknown> | undefined;
      if (local?.candidateType === "relay" || remote?.candidateType === "relay") return "relay";
      const addr = (c?: Record<string, unknown>) => (c?.address ?? c?.ip) as string | undefined;
      const localSide = local?.candidateType === "host" || isLocalAddress(addr(local));
      const remoteSide = remote?.candidateType === "host" || isLocalAddress(addr(remote));
      return localSide && remoteSide ? "local" : "internet";
    } catch {
      return null;
    }
  }

  sendBinary(data: ArrayBuffer | Uint8Array<ArrayBuffer>) {
    if (!this.channel || this.channel.readyState !== "open") throw new LinkError("closed");
    this.channel.send(data as ArrayBuffer);
  }

  waitForDrain(signal?: AbortSignal): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") return Promise.reject(new LinkError("closed"));
    if (channel.bufferedAmount <= BUFFER_HIGH) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onLow = () => done(resolve);
      const onClose = () => done(() => reject(new LinkError("closed")));
      const onAbort = () => done(() => reject(new LinkError("aborted")));
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose);
      signal?.addEventListener("abort", onAbort);
    });
  }

  close() {
    this.teardown("closed");
  }

  async handleSignal(signal: IncomingSignal) {
    if (signal.kind === "offer") return this.handleOffer(signal);

    if (signal.connId !== this.connId || !this.pc) return;
    const pc = this.pc;

    if (signal.kind === "answer") {
      if (pc.signalingState !== "have-local-offer" || !signal.sdp) return;
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        await this.flushCandidates(pc);
      } catch {
        if (this.pc === pc) this.teardown("failed");
      }
      return;
    }

    if (!signal.candidate) return;
    if (!pc.remoteDescription) {
      if (this.pendingCandidates.length < 200) this.pendingCandidates.push(signal.candidate);
      return;
    }
    try {
      await pc.addIceCandidate(signal.candidate);
    } catch {
      return;
    }
  }

  private async handleOffer(signal: IncomingSignal) {
    if (!signal.sdp) return;
    if (this.pc && this.connId === signal.connId) return;

    const collision = this.pc !== null && !this.isOpen && (this.makingOffer || this.pc.signalingState === "have-local-offer");
    if (collision && !this.polite) return;

    if (this.pc) this.replaceConnection();

    this.connId = signal.connId;
    const pc = this.createPeerConnection(signal.connId);
    this.pc = pc;
    this.armSetupTimer();
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await this.flushCandidates(pc);
      const answer = await pc.createAnswer();
      if (this.pc !== pc) return;
      await pc.setLocalDescription(answer);
      this.sendSignal({ to: this.peerId, connId: signal.connId, kind: "answer", sdp: pc.localDescription!.sdp });
    } catch {
      if (this.pc === pc) this.teardown("failed");
    }
  }

  private async startAsOfferer() {
    const connId = randomId();
    this.connId = connId;
    const pc = this.createPeerConnection(connId);
    this.pc = pc;
    this.attachChannel(pc.createDataChannel("dropflow", { ordered: true }));
    this.armSetupTimer();
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer();
      if (this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (this.pc !== pc) return;
      this.sendSignal({ to: this.peerId, connId, kind: "offer", sdp: pc.localDescription!.sdp });
    } catch {
      if (this.pc === pc) this.teardown("failed");
    } finally {
      this.makingOffer = false;
    }
  }

  private createPeerConnection(connId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    this.pendingCandidates = [];

    pc.onicecandidate = (event) => {
      if (this.pc !== pc) return;
      this.sendSignal({
        to: this.peerId,
        connId,
        kind: "candidate",
        candidate: event.candidate ? (event.candidate.toJSON() as OutgoingSignal["candidate"]) : null,
      });
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const state = pc.connectionState;
      if (state === "failed") this.teardown("failed");
      else if (state === "disconnected") {
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (this.pc === pc && pc.connectionState !== "connected") this.teardown("failed");
          }, DISCONNECT_GRACE_MS);
        }
      } else if (state === "connected" && this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
    };

    pc.ondatachannel = (event) => {
      if (this.pc !== pc || event.channel.label !== "dropflow") return;
      this.attachChannel(event.channel);
    };

    return pc;
  }

  private attachChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LOW;

    const onOpen = () => {
      if (this.channel !== channel) return;
      this.wasOpen = true;
      this.clearSetupTimer();
      for (const waiter of [...this.waiters]) waiter.resolve();
    };
    channel.onopen = onOpen;
    channel.onclose = () => {
      if (this.channel === channel) this.teardown("closed");
    };
    channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.channel === channel) this.events.onMessage(this.peerId, event.data);
    };
    if (channel.readyState === "open") onOpen();
  }

  private async flushCandidates(pc: RTCPeerConnection) {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        continue;
      }
    }
  }

  private armSetupTimer() {
    this.clearSetupTimer();
    this.setupTimer = setTimeout(() => {
      if (!this.isOpen) this.teardown("timeout");
    }, ANSWER_TIMEOUT_MS);
  }

  private clearSetupTimer() {
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = null;
  }

  private release() {
    this.clearSetupTimer();
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    const { channel, pc } = this;
    this.channel = null;
    this.pc = null;
    this.connId = null;
    this.pendingCandidates = [];
    if (channel) {
      channel.onopen = channel.onclose = channel.onmessage = null;
      try {
        channel.close();
      } catch {
        void 0;
      }
    }
    if (pc) {
      pc.onicecandidate = pc.onconnectionstatechange = pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        void 0;
      }
    }
  }

  private replaceConnection() {
    const wasOpen = this.wasOpen;
    this.wasOpen = false;
    this.release();
    if (wasOpen) this.events.onClose(this.peerId, "replaced");
  }

  private teardown(reason: LinkCloseReason) {
    if (!this.pc && !this.channel) return;
    const wasOpen = this.wasOpen;
    this.wasOpen = false;
    this.release();
    for (const waiter of [...this.waiters]) waiter.reject(new LinkError(reason));
    if (wasOpen) this.events.onClose(this.peerId, reason);
  }
}
