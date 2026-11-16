import { Download, FileIcon, Share } from "lucide-react";
import { transfers } from "../core/app";
import { fileKind, formatBytes } from "../transfer/format";
import type { ReceivedItem } from "../transfer/TransferManager";
import { Dialog } from "./Dialog";

interface ReceivedSheetProps {
  items: ReceivedItem[];
  onClose: () => void;
}

export function ReceivedSheet({ items, onClose }: ReceivedSheetProps) {
  if (items.length === 0) return null;
  const canShare = transfers.canShareFiles;
  const from = items[0].peerName;
  const hasImage = items.some((item) => item.mime.startsWith("image/"));

  return (
    <Dialog open onClose={onClose} title={items.length === 1 ? "File received" : `${items.length} files received`} testId="received-sheet">
      <p className="text-sm text-slate-300">
        From <span className="font-semibold text-white">{from}</span>. Checked and complete. Save{" "}
        {items.length === 1 ? "it" : "them"} to keep {items.length === 1 ? "it" : "them"} on this device.
      </p>

      <ul className="mt-4 space-y-3">
        {items.map((item) => {
          const isImage = item.mime.startsWith("image/") && item.url;
          return (
            <li key={item.id} className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/5" data-testid="received-sheet-item">
              {isImage && (
                <img
                  src={item.url!}
                  alt={item.name}
                  className="mb-3 max-h-56 w-full rounded-xl bg-navy-950 object-contain"
                  style={{ WebkitTouchCallout: "default" }}
                />
              )}
              <div className="flex items-center gap-3">
                {!isImage && (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/25 to-teal-400/20">
                    <FileIcon className="h-5 w-5 text-sky-200" aria-hidden />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={item.name}>
                    {item.name}
                  </span>
                  <span className="block text-xs text-slate-400">
                    {formatBytes(item.size)} · {fileKind(item.mime, item.name)}
                    {item.saved ? " · Saved" : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => transfers.save(item.id)}
                  data-testid="sheet-save"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 px-3.5 py-2 text-sm font-semibold text-navy-950 transition hover:brightness-110"
                >
                  {canShare ? <Share className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                  Save
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        {canShare
          ? "Save opens the share sheet. Choose Save Image to put photos in your library, or Save to Files."
          : "Save downloads to your Files app (Downloads folder)."}
        {!canShare && hasImage && " For photos, you can also touch and hold the picture and choose Save to Photos."}
      </p>

      <div className={`mt-5 grid gap-3 ${canShare && items.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        <button
          type="button"
          onClick={onClose}
          data-testid="sheet-done"
          className="rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10"
        >
          Done
        </button>
        {canShare && items.length > 1 && (
          <button
            type="button"
            onClick={() => transfers.saveAll(items.map((i) => i.id))}
            className="rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 px-4 py-3 text-sm font-semibold text-navy-950 transition hover:brightness-110"
          >
            Save all
          </button>
        )}
      </div>
    </Dialog>
  );
}
