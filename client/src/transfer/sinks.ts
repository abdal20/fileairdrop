export type SinkResult = { kind: "blob"; blob: Blob } | { kind: "disk" };

export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<SinkResult>;
  abort(): Promise<void>;
}

const CONSOLIDATE_BYTES = 32 * 1024 * 1024;

export class MemorySink implements FileSink {
  private parts: BlobPart[] = [];
  private pendingBytes = 0;
  private blobs: Blob[] = [];

  constructor(private readonly mime: string) {}

  async write(chunk: Uint8Array) {
    this.parts.push(chunk as Uint8Array<ArrayBuffer>);
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes >= CONSOLIDATE_BYTES) this.consolidate();
  }

  async close(): Promise<SinkResult> {
    this.consolidate();
    const blob = new Blob(this.blobs, { type: this.mime });
    this.blobs = [];
    return { kind: "blob", blob };
  }

  async abort() {
    this.parts = [];
    this.blobs = [];
    this.pendingBytes = 0;
  }

  private consolidate() {
    if (this.parts.length === 0) return;
    this.blobs.push(new Blob(this.parts));
    this.parts = [];
    this.pendingBytes = 0;
  }
}

interface WritableLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}

interface DirectoryHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<DirectoryHandleLike>;
};

export class DiskSink implements FileSink {
  private constructor(private readonly writable: WritableLike) {}

  static async create(handle: FileHandleLike) {
    return new DiskSink(await handle.createWritable());
  }

  async write(chunk: Uint8Array) {
    await this.writable.write(chunk as Uint8Array<ArrayBuffer>);
  }

  async close(): Promise<SinkResult> {
    await this.writable.close();
    return { kind: "disk" };
  }

  async abort() {
    try {
      await this.writable.abort();
    } catch {
      return;
    }
  }
}

export function canStreamToDisk(): boolean {
  const w = window as PickerWindow;
  return typeof w.showSaveFilePicker === "function" && typeof w.showDirectoryPicker === "function";
}

export type DiskTarget =
  | { kind: "file"; handle: FileHandleLike }
  | { kind: "directory"; handle: DirectoryHandleLike };

export async function pickDiskTarget(files: { name: string }[]): Promise<DiskTarget> {
  const w = window as PickerWindow;
  if (files.length === 1) {
    return { kind: "file", handle: await w.showSaveFilePicker!({ suggestedName: files[0].name }) };
  }
  return { kind: "directory", handle: await w.showDirectoryPicker!({ mode: "readwrite", id: "dropflow" }) };
}

async function exists(dir: DirectoryHandleLike, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function fileHandleIn(dir: DirectoryHandleLike, name: string): Promise<FileHandleLike> {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 1; i < 1000 && (await exists(dir, candidate)); i++) candidate = `${base} (${i})${ext}`;
  return dir.getFileHandle(candidate, { create: true });
}

export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NotReadableError" || error.name === "InvalidStateError")
  );
}
