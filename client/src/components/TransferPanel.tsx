import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  CircleX,
  Download,
  HardDrive,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { transfers } from "../core/app";
import { formatBytes, formatDuration } from "../transfer/format";
import type { BatchStatus, BatchView, ReceivedItem } from "../transfer/TransferManager";

const ROUTES = {
  local: { label: "Direct · same network", className: "bg-teal-400/10 text-teal-200" },
  internet: { label: "Direct · via your router", className: "bg-amber-400/10 text-amber-200" },
  relay: { label: "Relayed through TURN", className: "bg-slate-400/10 text-slate-300" },
} as const;

const ACTIVE: BatchStatus[] = ["queued", "connecting", "waiting", "transferring"];

function statusLabel(batch: BatchView): string {
  switch (batch.status) {
    case "queued":
      return "Queued";
    case "connecting":
      return "Connecting…";
    case "waiting":
      return "Waiting for approval…";
    case "transferring":
      return batch.direction === "outgoing" ? "Sending" : "Receiving";
    case "completed":
      return "Done";
    case "rejected":
      return "Declined";
    case "cancelled":
      return "Cancelled";
    default:
      return "Failed";
  }
}

function BatchRow({ batch }: { batch: BatchView }) {
  const active = ACTIVE.includes(batch.status);
  const pct = batch.totalBytes > 0 ? batch.doneBytes / batch.totalBytes : batch.status === "completed" ? 1 : 0;
  const current = batch.files.findIndex((f) => f.state === "active");
  const currentFile = current >= 0 ? batch.files[current] : batch.files[0];
  const Arrow = batch.direction === "outgoing" ? ArrowUpRight : ArrowDownLeft;
  const tone =
    batch.status === "completed"
      ? "text-emerald-300"
      : batch.status === "failed" || batch.status === "rejected"
        ? "text-rose-300"
        : batch.status === "cancelled"
          ? "text-slate-400"
          : "text-teal-200";

  return (
    <li
      className="animate-card-in rounded-2xl bg-white/[0.04] p-3.5 ring-1 ring-white/5"
      data-testid="transfer-row"
      data-direction={batch.direction}
      data-status={batch.status}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
            batch.direction === "outgoing" ? "bg-blue-500/15 text-sky-300" : "bg-teal-400/15 text-teal-300"
          }`}
        >
          <Arrow className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-medium">
              {batch.direction === "outgoing" ? "To" : "From"} {batch.peerName}
            </p>
            <span className={`shrink-0 text-xs font-medium ${tone}`} data-testid="transfer-status">
              {statusLabel(batch)}
            </span>
          </div>
          <p className="truncate text-xs text-slate-400" title={currentFile?.name}>
            {batch.files.length > 1 && current >= 0 ? `${current + 1} of ${batch.files.length} · ` : ""}
            {batch.files.length > 1 && current < 0 ? `${batch.files.length} files · ` : ""}
            {currentFile?.name}
          </p>

          {batch.route && (active || batch.status === "completed") && (
            <span
              className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${ROUTES[batch.route].className}`}
              data-testid="transfer-route"
              data-route={batch.route}
              title={
                batch.route === "internet"
                  ? "The devices could not reach each other directly on the local network, so traffic loops through your router. This is usually slower."
                  : undefined
              }
            >
              {ROUTES[batch.route].label}
            </span>
          )}

          {(active || batch.status === "completed") && (
            <div className="mt-2.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                    batch.status === "completed"
                      ? "bg-emerald-400"
                      : "bg-gradient-to-r from-blue-400 to-teal-300"
                  } ${batch.status === "connecting" || batch.status === "waiting" ? "animate-pulse" : ""}`}
                  style={{ width: `${Math.max(pct * 100, batch.status === "transferring" ? 2 : 0)}%` }}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-slate-400">
                <span data-testid="transfer-bytes" className="whitespace-nowrap">
                  {Math.floor(pct * 100)}% · {formatBytes(batch.doneBytes)} of {formatBytes(batch.totalBytes)}
                </span>
                {batch.status === "transferring" && batch.speed > 0 && (
                  <span className="whitespace-nowrap">
                    {formatBytes(batch.speed)}/s
                    {batch.eta !== null ? ` · ${formatDuration(batch.eta)} left` : ""}
                  </span>
                )}
              </div>
            </div>
          )}

          {batch.message && (
            <p className={`mt-2 flex items-start gap-1.5 text-xs ${tone}`} data-testid="transfer-message">
              {batch.status === "completed" ? (
                <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <CircleX className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {batch.message}
            </p>
          )}
        </div>
        {active ? (
          <button
            type="button"
            onClick={() => transfers.cancel(batch.batchId)}
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-white/10 hover:text-white"
            data-testid="cancel-transfer"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => transfers.dismiss(batch.batchId)}
            aria-label="Dismiss"
            className="shrink-0 rounded-lg p-1 text-slate-500 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function ReceivedRow({ item }: { item: ReceivedItem }) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-2" data-testid="received-item">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={item.name}>
          {item.name}
        </p>
        <p className="text-[11px] text-slate-500">
          {formatBytes(item.size)} · from {item.peerName}
        </p>
      </div>
      {item.savedToDisk ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
          <HardDrive className="h-3.5 w-3.5" aria-hidden />
          Saved
        </span>
      ) : (
        <button
          type="button"
          onClick={() => transfers.save(item.id)}
          data-testid="save-received"
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-medium transition hover:bg-white/15"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          {item.saved ? "Save again" : "Save"}
        </button>
      )}
      <button
        type="button"
        onClick={() => transfers.clearReceived(item.id)}
        aria-label={`Remove ${item.name}`}
        className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/10 hover:text-white"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

export function TransferPanel({ batches, received }: { batches: BatchView[]; received: ReceivedItem[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const activeCount = batches.filter((b) => ACTIVE.includes(b.status)).length;

  useEffect(() => {
    if (activeCount > 0) {
      setCollapsed(false);
      return;
    }
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    const id = setTimeout(() => setCollapsed(true), 5000);
    return () => clearTimeout(id);
  }, [activeCount]);

  if (batches.length === 0 && received.length === 0) return null;

  return (
    <aside
      className="fixed inset-x-0 bottom-0 z-30 animate-sheet-in sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[380px]"
      data-testid="transfer-panel"
    >
      <div className="rounded-t-3xl border border-white/10 bg-navy-900/[0.97] shadow-2xl shadow-black/40 backdrop-blur-xl sm:rounded-3xl">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center justify-between px-5 py-3.5"
        >
          <span className="text-sm font-semibold">
            Transfers
            {activeCount === 0 && collapsed && received.length > 0 && (
              <span className="ml-2 text-xs font-normal text-slate-400">{received.length} received</span>
            )}
            {activeCount > 0 && (
              <span className="ml-2 rounded-full bg-teal-400/15 px-2 py-0.5 text-xs text-teal-200">{activeCount} active</span>
            )}
          </span>
          <ChevronDown className={`h-4 w-4 text-slate-400 transition ${collapsed ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {!collapsed && (
          <div className="max-h-[55vh] overflow-y-auto px-3 pb-3">
            {batches.length > 0 && (
              <ul className="space-y-2">
                {batches.map((batch) => (
                  <BatchRow key={batch.batchId} batch={batch} />
                ))}
              </ul>
            )}
            {received.length > 0 && (
              <div className="mt-3 border-t border-white/5 pt-2">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Received</span>
                  <button
                    type="button"
                    onClick={() => transfers.clearReceived()}
                    className="text-xs text-slate-500 transition hover:text-white"
                  >
                    Clear
                  </button>
                </div>
                <ul>
                  {received.map((item) => (
                    <ReceivedRow key={item.id} item={item} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
