export interface FileMeta {
  transferId: string;
  name: string;
  size: number;
  mime: string;
}

export type RejectReason = "declined" | "busy" | "timeout" | "rate-limited" | "invalid";

export type CancelReason =
  | "cancelled"
  | "save-failed"
  | "integrity"
  | "timeout"
  | "protocol"
  | "page-closed"
  | "read-failed";

export type ControlMessage =
  | { t: "request"; batchId: string; files: FileMeta[]; totalSize: number }
  | { t: "accept"; batchId: string }
  | { t: "reject"; batchId: string; reason: RejectReason }
  | { t: "file-start"; batchId: string; transferId: string }
  | { t: "file-end"; batchId: string; transferId: string; size: number; sha256: string }
  | { t: "progress"; batchId: string; transferId: string; bytes: number }
  | { t: "file-ack"; batchId: string; transferId: string; ok: boolean; error?: CancelReason }
  | { t: "cancel"; batchId: string; reason: CancelReason };

export const MAX_FILES_PER_BATCH = 500;
export const MAX_CONTROL_LENGTH = 256 * 1024;

const ID_RE = /^[a-f0-9]{16,64}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const REJECT_REASONS: readonly RejectReason[] = ["declined", "busy", "timeout", "rate-limited", "invalid"];
const CANCEL_REASONS: readonly CancelReason[] = [
  "cancelled",
  "save-failed",
  "integrity",
  "timeout",
  "protocol",
  "page-closed",
  "read-failed",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const isSize = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "file";
}

function parseFileMeta(v: unknown): FileMeta | null {
  if (!isRecord(v) || !isId(v.transferId) || !isSize(v.size)) return null;
  if (typeof v.name !== "string" || v.name.length > 1024) return null;
  const mime = typeof v.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(v.mime) && v.mime.length <= 127
    ? v.mime
    : "application/octet-stream";
  return { transferId: v.transferId, name: sanitizeFileName(v.name), size: v.size, mime };
}

export function parseControl(raw: string): ControlMessage | null {
  if (raw.length > MAX_CONTROL_LENGTH) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.t !== "string" || !isId(v.batchId)) return null;
  const batchId = v.batchId;

  switch (v.t) {
    case "request": {
      if (!Array.isArray(v.files) || v.files.length === 0 || v.files.length > MAX_FILES_PER_BATCH) return null;
      const files: FileMeta[] = [];
      const seen = new Set<string>();
      for (const f of v.files) {
        const meta = parseFileMeta(f);
        if (!meta || seen.has(meta.transferId)) return null;
        seen.add(meta.transferId);
        files.push(meta);
      }
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (!isSize(totalSize) || v.totalSize !== totalSize) return null;
      return { t: "request", batchId, files, totalSize };
    }
    case "accept":
      return { t: "accept", batchId };
    case "reject":
      return {
        t: "reject",
        batchId,
        reason: (REJECT_REASONS as readonly unknown[]).includes(v.reason) ? (v.reason as RejectReason) : "declined",
      };
    case "file-start":
      return isId(v.transferId) ? { t: "file-start", batchId, transferId: v.transferId } : null;
    case "file-end":
      if (!isId(v.transferId) || !isSize(v.size) || typeof v.sha256 !== "string" || !HASH_RE.test(v.sha256)) return null;
      return { t: "file-end", batchId, transferId: v.transferId, size: v.size, sha256: v.sha256 };
    case "progress":
      if (!isId(v.transferId) || !isSize(v.bytes)) return null;
      return { t: "progress", batchId, transferId: v.transferId, bytes: v.bytes };
    case "file-ack":
      if (!isId(v.transferId) || typeof v.ok !== "boolean") return null;
      return {
        t: "file-ack",
        batchId,
        transferId: v.transferId,
        ok: v.ok,
        error: (CANCEL_REASONS as readonly unknown[]).includes(v.error) ? (v.error as CancelReason) : undefined,
      };
    case "cancel":
      return {
        t: "cancel",
        batchId,
        reason: (CANCEL_REASONS as readonly unknown[]).includes(v.reason) ? (v.reason as CancelReason) : "cancelled",
      };
    default:
      return null;
  }
}
