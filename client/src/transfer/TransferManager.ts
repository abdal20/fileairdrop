import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { PeerInfo } from "@dropflow/shared";
import type { DiscoveryClient } from "../core/discovery";
import { Store } from "../core/store";
import { randomId } from "../lib/random";
import { LinkError, type ConnectionRoute, type LinkCloseReason, type PeerLink } from "../rtc/PeerLink";
import { SignalingHub } from "../rtc/SignalingHub";
import { SpeedMeter } from "./format";
import {
  parseControl,
  sanitizeFileName,
  type CancelReason,
  type ControlMessage,
  type FileMeta,
  type RejectReason,
} from "./protocol";
import {
  canStreamToDisk,
  DiskSink,
  fileHandleIn,
  MemorySink,
  pickDiskTarget,
  type DiskTarget,
  type FileSink,
} from "./sinks";

export const CONNECT_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const STALL_TIMEOUT_MS = 30_000;
export const ACK_TIMEOUT_MS = 60_000;
const READ_BLOCK = 4 * 1024 * 1024;
const ACK_WINDOW = 48 * 1024 * 1024;
const PROGRESS_BYTES = 1024 * 1024;
const PROGRESS_MS = 200;
const DISK_THRESHOLD = 256 * 1024 * 1024;
const MEMORY_WARNING = 1024 * 1024 * 1024;
const IDLE_CLOSE_MS = 30_000;
const MAX_HISTORY = 30;
const MAX_UNSOLICITED_BYTES = 1024 * 1024;

export type BatchStatus =
  | "queued"
  | "connecting"
  | "waiting"
  | "transferring"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed";

export type Direction = "outgoing" | "incoming";

export interface FileView {
  transferId: string;
  name: string;
  size: number;
  mime: string;
  bytes: number;
  state: "pending" | "active" | "done" | "failed";
}

export interface BatchView {
  batchId: string;
  direction: Direction;
  peerId: string;
  peerName: string;
  files: FileView[];
  totalBytes: number;
  doneBytes: number;
  status: BatchStatus;
  message: string | null;
  speed: number;
  eta: number | null;
  createdAt: number;
  finishedAt: number | null;
  toDisk: boolean;
  route: ConnectionRoute | null;
}

export interface IncomingRequest {
  batchId: string;
  peerId: string;
  peerName: string;
  files: FileMeta[];
  totalBytes: number;
  expiresAt: number;
  diskMode: boolean;
  memoryWarning: boolean;
}

export interface ReceivedItem {
  id: string;
  batchId: string;
  name: string;
  size: number;
  mime: string;
  peerName: string;
  blob: Blob | null;
  url: string | null;
  savedToDisk: boolean;
  saved: boolean;
}

export interface TransferState {
  batches: BatchView[];
  incoming: IncomingRequest[];
  received: ReceivedItem[];
  support: { ok: boolean; reason: string | null };
}

type ErrorCode =
  | "cancelled"
  | "remote-cancelled"
  | "remote-closed"
  | "remote-save-failed"
  | "save-failed"
  | "integrity"
  | "connect-failed"
  | "connection-lost"
  | "peer-left"
  | "no-response"
  | "timeout"
  | "read-failed"
  | "protocol"
  | "rejected";

class TransferError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly rejectReason?: RejectReason,
  ) {
    super(code);
  }
}

interface Waiter {
  match: (m: ControlMessage) => boolean;
  resolve: (m: ControlMessage) => void;
  reject: (e: unknown) => void;
}

interface OutJob {
  view: BatchView;
  files: File[];
  metas: FileMeta[];
  abort: AbortController;
  waiters: Set<Waiter>;
  acked: Map<string, number>;
  completedBytes: number;
  meter: SpeedMeter;
  link: PeerLink | null;
}

interface InFile {
  meta: FileMeta;
  sink: FileSink | null;
  hasher: ReturnType<typeof sha256.create>;
  received: number;
  written: number;
  chain: Promise<void>;
  ended: boolean;
  lastProgressBytes: number;
  lastProgressAt: number;
}

interface InJob {
  view: BatchView;
  metas: FileMeta[];
  index: number;
  current: InFile | null;
  target: DiskTarget | null;
  completedBytes: number;
  meter: SpeedMeter;
  failed: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
}

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function errorMessage(err: TransferError, direction: Direction, peer: string): { status: BatchStatus; text: string } {
  if (err.code === "rejected") {
    const texts: Record<RejectReason, string> = {
      declined: `${peer} declined the files`,
      busy: `${peer} is busy with another transfer. Try again in a moment.`,
      timeout: `${peer} didn't respond in time`,
      "rate-limited": `${peer} is receiving too many requests. Try again in a minute.`,
      invalid: `${peer} couldn't read the request`,
    };
    return { status: "rejected", text: texts[err.rejectReason ?? "declined"] };
  }
  const texts: Record<Exclude<ErrorCode, "rejected">, string> = {
    cancelled: direction === "outgoing" ? "You cancelled the transfer" : "You cancelled the transfer",
    "remote-cancelled": `${peer} cancelled the transfer`,
    "remote-closed": `${peer} closed DropFlow`,
    "remote-save-failed": `${peer} couldn't save the file. Their device may be out of storage.`,
    "save-failed": "Couldn't save the file. This device may be out of storage, or permission was denied.",
    integrity:
      direction === "outgoing"
        ? "The file check failed on the other device, so it was not delivered."
        : "The file check failed, so the file was discarded.",
    "connect-failed": `Couldn't connect to ${peer}. Your networks may block direct connections; a TURN server fixes this.`,
    "connection-lost": `The connection to ${peer} was lost`,
    "peer-left": `${peer} went offline`,
    "no-response": `${peer} didn't respond in time`,
    timeout: "The transfer stalled and timed out",
    "read-failed": "Couldn't read the file on this device",
    protocol: "The other device sent unexpected data, so the transfer was stopped.",
  };
  const status: BatchStatus = err.code === "cancelled" || err.code === "remote-cancelled" ? "cancelled" : "failed";
  return { status, text: texts[err.code] };
}

function remoteCancelCode(reason: CancelReason): ErrorCode {
  switch (reason) {
    case "save-failed":
      return "remote-save-failed";
    case "integrity":
      return "integrity";
    case "page-closed":
      return "remote-closed";
    case "timeout":
      return "timeout";
    case "protocol":
      return "protocol";
    default:
      return "remote-cancelled";
  }
}

function localCancelReason(code: ErrorCode): CancelReason | null {
  switch (code) {
    case "cancelled":
      return "cancelled";
    case "read-failed":
      return "read-failed";
    case "timeout":
    case "no-response":
      return "timeout";
    case "save-failed":
      return "save-failed";
    case "integrity":
      return "integrity";
    case "protocol":
      return "protocol";
    default:
      return null;
  }
}

export class TransferManager {
  readonly store: Store<TransferState>;
  readonly hub: SignalingHub;

  private queue: OutJob[] = [];
  private activeOut: OutJob | null = null;
  private activeIn: InJob | null = null;
  private pending = new Map<string, { request: IncomingRequest; timer: ReturnType<typeof setTimeout> }>();
  private history: BatchView[] = [];
  private received: ReceivedItem[] = [];
  private peers = new Map<string, PeerInfo>();
  private requestTimes = new Map<string, number[]>();
  private unsolicited = new Map<string, number>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(discovery: DiscoveryClient) {
    const supported = typeof RTCPeerConnection === "function";
    this.store = new Store<TransferState>({
      batches: [],
      incoming: [],
      received: [],
      support: {
        ok: supported,
        reason: supported ? null : "This browser doesn't support WebRTC, so it can't send or receive files.",
      },
    });

    this.hub = new SignalingHub(discovery.socket, {
      onMessage: (peerId, data) => this.onMessage(peerId, data),
      onClose: (peerId, reason) => this.onLinkClose(peerId, reason),
    });

    const sync = () => {
      const state = discovery.store.get();
      this.hub.setIdentity(state.self?.id ?? null, state.iceServers);
      this.peers = new Map(state.peers.map((p) => [p.id, p]));
      this.hub.setPeers(state.peers.map((p) => p.id));
      this.dropVanishedPeers();
    };
    discovery.store.subscribe(sync);
    sync();

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", (event) => {
        if (this.hasActiveWork()) {
          event.preventDefault();
          event.returnValue = "";
        }
      });
      window.addEventListener("pagehide", () => this.shutdown());
    }
  }

  send(peer: PeerInfo, files: File[]) {
    if (!this.store.get().support.ok || files.length === 0) return;
    const metas: FileMeta[] = files.map((file) => ({
      transferId: randomId(),
      name: sanitizeFileName(file.name),
      size: file.size,
      mime: file.type || "application/octet-stream",
    }));
    const job: OutJob = {
      view: {
        batchId: randomId(),
        direction: "outgoing",
        peerId: peer.id,
        peerName: peer.name,
        files: metas.map((m) => ({ ...m, bytes: 0, state: "pending" })),
        totalBytes: metas.reduce((s, m) => s + m.size, 0),
        doneBytes: 0,
        status: "queued",
        message: null,
        speed: 0,
        eta: null,
        createdAt: Date.now(),
        finishedAt: null,
        toDisk: false,
        route: null,
      },
      files,
      metas,
      abort: new AbortController(),
      waiters: new Set(),
      acked: new Map(),
      completedBytes: 0,
      meter: new SpeedMeter(),
      link: null,
    };
    this.queue.push(job);
    this.emitNow();
    this.pump();
  }

  async accept(batchId: string) {
    const entry = this.pending.get(batchId);
    if (!entry) return;
    const { request } = entry;

    let target: DiskTarget | null = null;
    if (request.diskMode) {
      try {
        target = await pickDiskTarget(request.files);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        target = null;
      }
    }

    if (!this.pending.has(batchId)) return;
    this.removePending(batchId);

    const link = this.hub.get(request.peerId);
    const job: InJob = {
      view: {
        batchId,
        direction: "incoming",
        peerId: request.peerId,
        peerName: request.peerName,
        files: request.files.map((m) => ({ ...m, bytes: 0, state: "pending" })),
        totalBytes: request.totalBytes,
        doneBytes: 0,
        status: "transferring",
        message: null,
        speed: 0,
        eta: null,
        createdAt: Date.now(),
        finishedAt: null,
        toDisk: target !== null,
        route: null,
      },
      metas: request.files,
      index: -1,
      current: null,
      target,
      completedBytes: 0,
      meter: new SpeedMeter(),
      failed: false,
      stallTimer: null,
    };
    this.activeIn = job;
    this.touchIn(job);

    try {
      if (!link) throw new LinkError("closed");
      link.send(JSON.stringify({ t: "accept", batchId }));
      void this.detectRoute(link, job.view);
    } catch {
      this.failIn(job, new TransferError("connection-lost"), false);
      return;
    }
    this.emitNow();
  }

  reject(batchId: string) {
    const entry = this.pending.get(batchId);
    if (!entry) return;
    this.removePending(batchId);
    this.sendControl(entry.request.peerId, { t: "reject", batchId, reason: "declined" });
    this.emitNow();
  }

  cancel(batchId: string) {
    const queued = this.queue.find((j) => j.view.batchId === batchId);
    if (queued) {
      this.queue = this.queue.filter((j) => j !== queued);
      this.finishOut(queued, new TransferError("cancelled"));
      return;
    }
    if (this.activeOut?.view.batchId === batchId) {
      this.activeOut.abort.abort(new TransferError("cancelled"));
      return;
    }
    if (this.activeIn?.view.batchId === batchId) {
      this.failIn(this.activeIn, new TransferError("cancelled"), true);
    }
  }

  dismiss(batchId: string) {
    this.history = this.history.filter((b) => b.batchId !== batchId);
    this.emitNow();
  }

  get mustSaveManually(): boolean {
    return isIOS();
  }

  get canShareFiles(): boolean {
    try {
      return (
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [new File([""], "check.txt", { type: "text/plain" })] })
      );
    } catch {
      return false;
    }
  }

  async save(itemId: string, how: "best" | "download" = "best") {
    const item = this.received.find((r) => r.id === itemId);
    if (!item?.blob) return;
    if (how === "best" && this.canShareFiles) {
      const shared = await this.share([item]);
      if (shared !== "unsupported") return;
    }
    this.download(item);
  }

  async saveAll(itemIds: string[]) {
    const items = this.received.filter((r) => itemIds.includes(r.id) && r.blob);
    if (items.length === 0) return;
    if (this.canShareFiles && (await this.share(items)) !== "unsupported") return;
    for (const item of items) this.download(item);
  }

  private async share(items: ReceivedItem[]): Promise<"shared" | "cancelled" | "unsupported"> {
    const files = items.map((item) => new File([item.blob!], item.name, { type: item.mime }));
    if (!navigator.canShare?.({ files })) return "unsupported";
    try {
      await navigator.share({ files });
      for (const item of items) item.saved = true;
      this.emitNow();
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      return "unsupported";
    }
  }

  clearReceived(itemId?: string) {
    const remove = itemId ? this.received.filter((r) => r.id === itemId) : this.received;
    for (const item of remove) if (item.url) URL.revokeObjectURL(item.url);
    this.received = itemId ? this.received.filter((r) => r.id !== itemId) : [];
    this.emitNow();
  }

  private download(item: ReceivedItem) {
    if (!item.url) return;
    const a = document.createElement("a");
    a.href = item.url;
    a.download = item.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.markSaved(item);
  }

  private markSaved(item: ReceivedItem) {
    item.saved = true;
    this.emitNow();
  }

  private pump() {
    if (this.activeOut) return;
    const job = this.queue.shift();
    if (!job) return;
    this.activeOut = job;
    void this.runOutgoing(job);
  }

  private async runOutgoing(job: OutJob) {
    const signal = job.abort.signal;
    let phase: "connecting" | "transfer" = "connecting";
    try {
      this.cancelIdle(job.view.peerId);
      this.setOut(job, { status: "connecting" });
      let link: PeerLink;
      try {
        link = this.hub.link(job.view.peerId);
      } catch {
        throw new TransferError("peer-left");
      }
      job.link = link;
      await link.open(CONNECT_TIMEOUT_MS, signal);
      phase = "transfer";

      void this.detectRoute(link, job.view);
      this.setOut(job, { status: "waiting" });
      link.send(
        JSON.stringify({
          t: "request",
          batchId: job.view.batchId,
          files: job.metas,
          totalSize: job.view.totalBytes,
        } satisfies ControlMessage),
      );

      const answer = await this.waitFor(
        job,
        (m) => m.t === "accept" || m.t === "reject",
        REQUEST_TIMEOUT_MS,
        "no-response",
      );
      if (answer.t === "reject") throw new TransferError("rejected", answer.reason);

      this.setOut(job, { status: "transferring" });
      for (let i = 0; i < job.files.length; i++) {
        await this.sendFile(job, link, job.files[i], job.metas[i]);
      }
      this.finishOut(job, null);
    } catch (error) {
      let err: TransferError;
      if (signal.aborted && signal.reason instanceof TransferError) err = signal.reason;
      else if (error instanceof TransferError) err = error;
      else if (error instanceof LinkError) {
        const gone = !this.hub.isAuthorized(job.view.peerId);
        err = new TransferError(gone ? "peer-left" : phase === "connecting" ? "connect-failed" : "connection-lost");
      } else err = new TransferError("connection-lost");

      const reason = localCancelReason(err.code);
      if (reason && phase === "transfer") {
        this.sendControl(job.view.peerId, { t: "cancel", batchId: job.view.batchId, reason });
      }
      this.finishOut(job, err);
    } finally {
      for (const w of job.waiters) w.reject(new TransferError("cancelled"));
      job.waiters.clear();
      this.activeOut = null;
      this.scheduleIdle(job.view.peerId);
      this.pump();
    }
  }

  private async sendFile(job: OutJob, link: PeerLink, file: File, meta: FileMeta) {
    const id = meta.transferId;
    const signal = job.abort.signal;
    const fileView = job.view.files.find((f) => f.transferId === id)!;
    fileView.state = "active";
    this.emitNow();

    link.send(JSON.stringify({ t: "file-start", batchId: job.view.batchId, transferId: id }));
    const hasher = sha256.create();
    const chunkSize = link.chunkSize;
    let offset = 0;

    while (offset < file.size) {
      this.throwIfAborted(job);
      const end = Math.min(offset + READ_BLOCK, file.size);
      let block: ArrayBuffer;
      try {
        block = await file.slice(offset, end).arrayBuffer();
      } catch {
        throw new TransferError("read-failed");
      }
      if (block.byteLength !== end - offset) throw new TransferError("read-failed");
      hasher.update(new Uint8Array(block));

      for (let p = 0; p < block.byteLength; p += chunkSize) {
        this.throwIfAborted(job);
        await this.waitForWindow(job, id, offset + p);
        await link.waitForDrain(signal);
        this.throwIfAborted(job);
        link.sendBinary(new Uint8Array(block, p, Math.min(chunkSize, block.byteLength - p)));
      }
      offset = end;
    }

    link.send(
      JSON.stringify({
        t: "file-end",
        batchId: job.view.batchId,
        transferId: id,
        size: file.size,
        sha256: bytesToHex(hasher.digest()),
      } satisfies ControlMessage),
    );

    const ack = await this.waitFor(
      job,
      (m) => m.t === "file-ack" && m.transferId === id,
      ACK_TIMEOUT_MS,
      "timeout",
    );
    if (ack.t !== "file-ack" || !ack.ok) {
      fileView.state = "failed";
      throw new TransferError(ack.t === "file-ack" && ack.error === "integrity" ? "integrity" : "remote-save-failed");
    }
    fileView.state = "done";
    fileView.bytes = meta.size;
    job.completedBytes += meta.size;
    this.updateOutProgress(job);
  }

  private async waitForWindow(job: OutJob, transferId: string, offset: number) {
    while (offset - (job.acked.get(transferId) ?? 0) >= ACK_WINDOW) {
      await this.waitFor(job, (m) => m.t === "progress" && m.transferId === transferId, STALL_TIMEOUT_MS, "timeout");
    }
  }

  private waitFor(job: OutJob, match: (m: ControlMessage) => boolean, timeoutMs: number, code: ErrorCode) {
    return new Promise<ControlMessage>((resolve, reject) => {
      const signal = job.abort.signal;
      if (signal.aborted) return reject(signal.reason);
      const waiter: Waiter = {
        match,
        resolve: (m) => {
          done();
          resolve(m);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      };
      const timer = setTimeout(() => waiter.reject(new TransferError(code)), timeoutMs);
      const onAbort = () => waiter.reject(signal.reason);
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        job.waiters.delete(waiter);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      job.waiters.add(waiter);
    });
  }

  private async detectRoute(link: PeerLink, view: BatchView) {
    for (let attempt = 0; attempt < 5 && !view.route; attempt++) {
      view.route = await link.route();
      if (view.route) {
        this.emitNow();
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private throwIfAborted(job: OutJob) {
    if (job.abort.signal.aborted) throw job.abort.signal.reason;
  }

  private setOut(job: OutJob, patch: Partial<BatchView>) {
    Object.assign(job.view, patch);
    this.emitNow();
  }

  private updateOutProgress(job: OutJob) {
    const current = job.view.files.find((f) => f.state === "active");
    if (current) current.bytes = job.acked.get(current.transferId) ?? 0;
    job.view.doneBytes = job.completedBytes + (current?.bytes ?? 0);
    job.meter.add(job.view.doneBytes);
    job.view.speed = job.meter.bytesPerSecond;
    job.view.eta = job.view.speed > 0 ? (job.view.totalBytes - job.view.doneBytes) / job.view.speed : null;
    this.emitSoon();
  }

  private finishOut(job: OutJob, err: TransferError | null) {
    if (err) {
      const { status, text } = errorMessage(err, "outgoing", job.view.peerName);
      job.view.status = status;
      job.view.message = text;
      for (const f of job.view.files) if (f.state === "active") f.state = "failed";
    } else {
      job.view.status = "completed";
      job.view.doneBytes = job.view.totalBytes;
      job.view.message =
        job.files.length === 1 ? "Delivered and verified" : `${job.files.length} files delivered and verified`;
    }
    job.view.speed = 0;
    job.view.eta = null;
    job.view.finishedAt = Date.now();
    this.archive(job.view);
  }

  private handleOutgoingMessage(peerId: string, msg: ControlMessage): boolean {
    const job = this.activeOut;
    if (!job || job.view.batchId !== msg.batchId || job.view.peerId !== peerId) return false;
    if (msg.t === "progress") {
      const meta = job.metas.find((m) => m.transferId === msg.transferId);
      if (!meta || msg.bytes > meta.size) return true;
      job.acked.set(msg.transferId, Math.max(job.acked.get(msg.transferId) ?? 0, msg.bytes));
      this.updateOutProgress(job);
    }
    if (msg.t === "cancel") {
      job.abort.abort(new TransferError(remoteCancelCode(msg.reason)));
      return true;
    }
    for (const waiter of [...job.waiters]) if (waiter.match(msg)) waiter.resolve(msg);
    return true;
  }

  private handleRequest(peerId: string, msg: Extract<ControlMessage, { t: "request" }>) {
    const peer = this.peers.get(peerId);
    if (!peer || !this.hub.isAuthorized(peerId)) return;

    const now = Date.now();
    const times = (this.requestTimes.get(peerId) ?? []).filter((t) => now - t < 60_000);
    times.push(now);
    this.requestTimes.set(peerId, times);
    if (times.length > 8) {
      this.sendControl(peerId, { t: "reject", batchId: msg.batchId, reason: "rate-limited" });
      return;
    }
    if (this.pending.size > 0 || this.activeIn) {
      this.sendControl(peerId, { t: "reject", batchId: msg.batchId, reason: "busy" });
      return;
    }

    const diskMode = canStreamToDisk() && msg.totalSize >= DISK_THRESHOLD;
    const request: IncomingRequest = {
      batchId: msg.batchId,
      peerId,
      peerName: peer.name,
      files: msg.files,
      totalBytes: msg.totalSize,
      expiresAt: now + REQUEST_TIMEOUT_MS - 5_000,
      diskMode,
      memoryWarning: !diskMode && msg.totalSize >= MEMORY_WARNING,
    };
    const timer = setTimeout(() => {
      if (!this.pending.has(msg.batchId)) return;
      this.removePending(msg.batchId);
      this.sendControl(peerId, { t: "reject", batchId: msg.batchId, reason: "timeout" });
      this.emitNow();
    }, REQUEST_TIMEOUT_MS - 5_000);
    this.pending.set(msg.batchId, { request, timer });
    this.cancelIdle(peerId);
    this.emitNow();
  }

  private removePending(batchId: string) {
    const entry = this.pending.get(batchId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(batchId);
  }

  private handleIncomingMessage(peerId: string, msg: ControlMessage) {
    if (msg.t === "cancel" && this.pending.has(msg.batchId)) {
      if (this.pending.get(msg.batchId)!.request.peerId === peerId) {
        this.removePending(msg.batchId);
        this.emitNow();
      }
      return;
    }

    const job = this.activeIn;
    if (!job || job.view.batchId !== msg.batchId || job.view.peerId !== peerId || job.failed) return;
    this.touchIn(job);

    if (msg.t === "cancel") {
      this.failIn(job, new TransferError(remoteCancelCode(msg.reason)), false);
    } else if (msg.t === "file-start") {
      this.startIncomingFile(job, msg.transferId);
    } else if (msg.t === "file-end") {
      this.endIncomingFile(job, msg);
    }
  }

  private startIncomingFile(job: InJob, transferId: string) {
    if (job.current && !job.current.ended) return this.failIn(job, new TransferError("protocol"), true);
    const meta = job.metas[job.index + 1];
    if (!meta || meta.transferId !== transferId) return this.failIn(job, new TransferError("protocol"), true);
    job.index++;

    const file: InFile = {
      meta,
      sink: null,
      hasher: sha256.create(),
      received: 0,
      written: 0,
      chain: Promise.resolve(),
      ended: false,
      lastProgressBytes: 0,
      lastProgressAt: 0,
    };
    job.current = file;
    job.view.files[job.index].state = "active";
    file.chain = file.chain
      .then(async () => {
        file.sink = await this.createSink(job, meta);
      })
      .catch(() => this.failIn(job, new TransferError("save-failed"), true));
    this.emitNow();
  }

  private async createSink(job: InJob, meta: FileMeta): Promise<FileSink> {
    if (job.target?.kind === "file") return DiskSink.create(job.target.handle);
    if (job.target?.kind === "directory") return DiskSink.create(await fileHandleIn(job.target.handle, meta.name));
    return new MemorySink(meta.mime);
  }

  private handleBinary(peerId: string, data: ArrayBuffer) {
    const job = this.activeIn;
    const file = job?.current;
    if (!job || job.view.peerId !== peerId || job.failed || !file || file.ended) {
      const total = (this.unsolicited.get(peerId) ?? 0) + data.byteLength;
      this.unsolicited.set(peerId, total);
      if (total > MAX_UNSOLICITED_BYTES) {
        this.unsolicited.delete(peerId);
        this.hub.closeLink(peerId);
      }
      return;
    }
    if (file.received + data.byteLength > file.meta.size) {
      return this.failIn(job, new TransferError("protocol"), true);
    }
    this.touchIn(job);
    const chunk = new Uint8Array(data);
    file.received += chunk.byteLength;
    file.hasher.update(chunk);

    file.chain = file.chain
      .then(async () => {
        if (job.failed || !file.sink) return;
        await file.sink.write(chunk);
        file.written += chunk.byteLength;
        this.reportIncomingProgress(job, file, false);
      })
      .catch(() => this.failIn(job, new TransferError("save-failed"), true));
  }

  private reportIncomingProgress(job: InJob, file: InFile, force: boolean) {
    const fileView = job.view.files[job.index];
    fileView.bytes = file.written;
    job.view.doneBytes = job.completedBytes + file.written;
    job.meter.add(job.view.doneBytes);
    job.view.speed = job.meter.bytesPerSecond;
    job.view.eta = job.view.speed > 0 ? (job.view.totalBytes - job.view.doneBytes) / job.view.speed : null;
    this.emitSoon();

    const now = performance.now();
    if (force || file.written - file.lastProgressBytes >= PROGRESS_BYTES || now - file.lastProgressAt >= PROGRESS_MS) {
      file.lastProgressBytes = file.written;
      file.lastProgressAt = now;
      this.sendControl(job.view.peerId, {
        t: "progress",
        batchId: job.view.batchId,
        transferId: file.meta.transferId,
        bytes: file.written,
      });
    }
  }

  private endIncomingFile(job: InJob, msg: Extract<ControlMessage, { t: "file-end" }>) {
    const file = job.current;
    if (!file || file.meta.transferId !== msg.transferId || file.ended) {
      return this.failIn(job, new TransferError("protocol"), true);
    }
    file.ended = true;
    const digest = bytesToHex(file.hasher.digest());
    const batchId = job.view.batchId;
    const transferId = file.meta.transferId;

    file.chain = file.chain.then(async () => {
      if (job.failed) return;
      if (file.received !== file.meta.size || msg.size !== file.meta.size || digest !== msg.sha256 || !file.sink) {
        await file.sink?.abort();
        this.sendControl(job.view.peerId, { t: "file-ack", batchId, transferId, ok: false, error: "integrity" });
        this.failIn(job, new TransferError("integrity"), false);
        return;
      }

      let result;
      try {
        result = await file.sink.close();
      } catch {
        this.sendControl(job.view.peerId, { t: "file-ack", batchId, transferId, ok: false, error: "save-failed" });
        this.failIn(job, new TransferError("save-failed"), false);
        return;
      }

      this.received.unshift({
        id: randomId(),
        batchId,
        name: file.meta.name,
        size: file.meta.size,
        mime: file.meta.mime,
        peerName: job.view.peerName,
        blob: result.kind === "blob" ? result.blob : null,
        url: result.kind === "blob" ? URL.createObjectURL(result.blob) : null,
        savedToDisk: result.kind === "disk",
        saved: result.kind === "disk",
      });

      this.reportIncomingProgress(job, file, true);
      job.completedBytes += file.meta.size;
      job.view.files[job.index].state = "done";
      job.current = null;
      this.sendControl(job.view.peerId, { t: "file-ack", batchId, transferId, ok: true });

      if (job.index === job.metas.length - 1) this.completeIn(job);
      else this.emitNow();
    });
  }

  private completeIn(job: InJob) {
    this.clearStall(job);
    job.view.status = "completed";
    job.view.doneBytes = job.view.totalBytes;
    job.view.speed = 0;
    job.view.eta = null;
    job.view.finishedAt = Date.now();
    const count = job.metas.length;
    job.view.message = job.view.toDisk
      ? `${count === 1 ? "File" : `${count} files`} saved and verified`
      : `${count === 1 ? "File" : `${count} files`} received and verified`;
    if (this.activeIn === job) this.activeIn = null;
    this.archive(job.view);

    if (!job.view.toDisk && !isIOS()) {
      for (const item of this.received.filter((r) => r.batchId === job.view.batchId)) this.download(item);
    }
  }

  private failIn(job: InJob, err: TransferError, notify: boolean) {
    if (job.failed) return;
    job.failed = true;
    this.clearStall(job);
    void job.current?.sink?.abort();
    if (notify) {
      const reason = localCancelReason(err.code);
      if (reason) this.sendControl(job.view.peerId, { t: "cancel", batchId: job.view.batchId, reason });
    }
    const { status, text } = errorMessage(err, "incoming", job.view.peerName);
    job.view.status = status;
    job.view.message = text;
    job.view.speed = 0;
    job.view.eta = null;
    job.view.finishedAt = Date.now();
    for (const f of job.view.files) if (f.state === "active" || f.state === "pending") f.state = "failed";
    if (this.activeIn === job) this.activeIn = null;
    this.archive(job.view);
  }

  private touchIn(job: InJob) {
    this.clearStall(job);
    job.stallTimer = setTimeout(() => this.failIn(job, new TransferError("timeout"), true), STALL_TIMEOUT_MS);
  }

  private clearStall(job: InJob) {
    if (job.stallTimer) clearTimeout(job.stallTimer);
    job.stallTimer = null;
  }

  private onMessage(peerId: string, data: string | ArrayBuffer) {
    if (typeof data !== "string") return this.handleBinary(peerId, data);
    const msg = parseControl(data);
    if (!msg) return;
    if (msg.t === "request") return this.handleRequest(peerId, msg);
    if (msg.t === "accept" || msg.t === "reject" || msg.t === "progress" || msg.t === "file-ack") {
      this.handleOutgoingMessage(peerId, msg);
      return;
    }
    if (msg.t === "cancel" && this.handleOutgoingMessage(peerId, msg)) return;
    this.handleIncomingMessage(peerId, msg);
  }

  private onLinkClose(peerId: string, _reason: LinkCloseReason) {
    const gone = !this.hub.isAuthorized(peerId);
    const code: ErrorCode = gone ? "peer-left" : "connection-lost";
    if (this.activeOut?.view.peerId === peerId) this.activeOut.abort.abort(new TransferError(code));
    if (this.activeIn?.view.peerId === peerId) this.failIn(this.activeIn, new TransferError(code), false);
    let changed = false;
    for (const [batchId, entry] of this.pending) {
      if (entry.request.peerId === peerId) {
        this.removePending(batchId);
        changed = true;
      }
    }
    if (changed) this.emitNow();
  }

  private dropVanishedPeers() {
    const vanished = this.queue.filter((j) => !this.peers.has(j.view.peerId));
    if (vanished.length > 0) {
      this.queue = this.queue.filter((j) => this.peers.has(j.view.peerId));
      for (const job of vanished) this.finishOut(job, new TransferError("peer-left"));
    }
    if (this.activeOut && !this.peers.has(this.activeOut.view.peerId)) {
      this.activeOut.abort.abort(new TransferError("peer-left"));
    }
    if (this.activeIn && !this.peers.has(this.activeIn.view.peerId)) {
      this.failIn(this.activeIn, new TransferError("peer-left"), false);
    }
    for (const [batchId, entry] of this.pending) {
      if (!this.peers.has(entry.request.peerId)) this.removePending(batchId);
    }
    this.emitSoon();
  }

  private sendControl(peerId: string, msg: ControlMessage) {
    try {
      this.hub.get(peerId)?.send(JSON.stringify(msg));
    } catch {
      return;
    }
  }

  private hasActiveWork() {
    return this.activeOut !== null || this.activeIn !== null || this.queue.length > 0;
  }

  private peerBusy(peerId: string) {
    if (this.activeOut?.view.peerId === peerId || this.activeIn?.view.peerId === peerId) return true;
    if (this.queue.some((j) => j.view.peerId === peerId)) return true;
    for (const entry of this.pending.values()) if (entry.request.peerId === peerId) return true;
    return false;
  }

  private scheduleIdle(peerId: string) {
    this.cancelIdle(peerId);
    this.idleTimers.set(
      peerId,
      setTimeout(() => {
        this.idleTimers.delete(peerId);
        if (!this.peerBusy(peerId)) this.hub.closeLink(peerId);
      }, IDLE_CLOSE_MS),
    );
  }

  private cancelIdle(peerId: string) {
    const timer = this.idleTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(peerId);
  }

  private shutdown() {
    if (this.activeOut) {
      this.sendControl(this.activeOut.view.peerId, { t: "cancel", batchId: this.activeOut.view.batchId, reason: "page-closed" });
    }
    if (this.activeIn) {
      this.sendControl(this.activeIn.view.peerId, { t: "cancel", batchId: this.activeIn.view.batchId, reason: "page-closed" });
    }
    for (const [batchId, entry] of this.pending) {
      this.sendControl(entry.request.peerId, { t: "reject", batchId, reason: "declined" });
    }
    this.hub.closeAll();
  }

  private archive(view: BatchView) {
    this.history = [view, ...this.history.filter((b) => b.batchId !== view.batchId)].slice(0, MAX_HISTORY);
    this.emitNow();
  }

  private emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, 100);
  }

  private emitNow() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    const copy = (v: BatchView): BatchView => ({ ...v, files: v.files.map((f) => ({ ...f })) });
    const live: BatchView[] = [];
    if (this.activeIn) live.push(copy(this.activeIn.view));
    if (this.activeOut) live.push(copy(this.activeOut.view));
    for (const job of this.queue) live.push(copy(job.view));
    const liveIds = new Set(live.map((b) => b.batchId));
    this.store.set({
      batches: [...live, ...this.history.filter((b) => !liveIds.has(b.batchId)).map(copy)],
      incoming: [...this.pending.values()].map((e) => e.request),
      received: this.received.map((r) => ({ ...r })),
    });
  }
}
