import { FileIcon, HardDriveDownload, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { transfers } from "../core/app";
import { fileKind, formatBytes } from "../transfer/format";
import type { IncomingRequest } from "../transfer/TransferManager";
import { Dialog } from "./Dialog";

export function IncomingDialog({ request }: { request: IncomingRequest | null }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!request) return;
    setBusy(false);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [request]);

  if (!request) return null;
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const count = request.files.length;

  const accept = async () => {
    setBusy(true);
    await transfers.accept(request.batchId);
    setBusy(false);
  };

  return (
    <Dialog open title="Incoming files" testId="incoming-dialog">
      <p className="text-sm text-slate-300">
        <span className="font-semibold text-white" data-testid="incoming-sender">
          {request.peerName}
        </span>{" "}
        wants to send you {count === 1 ? "a file" : `${count} files`} ({formatBytes(request.totalBytes)}).
      </p>

      <ul className="mt-4 max-h-56 space-y-2 overflow-y-auto pr-1" data-testid="incoming-files">
        {request.files.map((file) => (
          <li key={file.transferId} className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-3 py-2.5 ring-1 ring-white/5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/25 to-teal-400/20">
              <FileIcon className="h-4 w-4 text-sky-200" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={file.name}>
                {file.name}
              </span>
              <span className="block text-xs text-slate-400">
                {formatBytes(file.size)} · {fileKind(file.mime, file.name)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {request.diskMode && (
        <p className="mt-4 flex gap-2 rounded-xl bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
          <HardDriveDownload className="h-4 w-4 shrink-0" aria-hidden />
          This is large, so you'll pick where to save it and it will be written straight to disk.
        </p>
      )}
      {request.memoryWarning && (
        <p className="mt-4 flex gap-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
          This is large. Your browser keeps it in memory until you save it, which can fail on devices with little free memory.
        </p>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5 text-teal-300/80" aria-hidden />
        Sent directly and encrypted. Nothing is sent until you accept · {remaining}s
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => transfers.reject(request.batchId)}
          data-testid="reject-transfer"
          className="rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10"
        >
          Decline
        </button>
        <button
          type="button"
          onClick={accept}
          disabled={busy}
          data-testid="accept-transfer"
          className="rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 px-4 py-3 text-sm font-semibold text-navy-950 shadow-lg shadow-sky-500/20 transition hover:brightness-110 disabled:opacity-60"
        >
          Accept
        </button>
      </div>
    </Dialog>
  );
}
