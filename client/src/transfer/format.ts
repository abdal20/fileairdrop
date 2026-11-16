export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fileKind(mime: string, name: string): string {
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime === "application/pdf") return "PDF";
  if (/zip|compressed|tar|rar|7z/.test(mime)) return "Archive";
  if (mime.startsWith("text/")) return "Text";
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "";
  return ext && ext.length <= 5 ? `${ext} file` : "File";
}

export class SpeedMeter {
  private samples: { t: number; bytes: number }[] = [];

  add(bytes: number, t = performance.now()) {
    this.samples.push({ t, bytes });
    while (this.samples.length > 2 && t - this.samples[0].t > 3000) this.samples.shift();
  }

  get bytesPerSecond(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt > 0 ? Math.max(0, (last.bytes - first.bytes) / dt) : 0;
  }
}
