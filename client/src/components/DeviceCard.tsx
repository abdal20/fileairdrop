import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import type { PeerInfo } from "@dropflow/shared";
import { DeviceIcon, deviceLabel } from "./DeviceIcon";

export interface CardActivity {
  label: string;
  progress: number | null;
  tone: "active" | "success" | "error";
}

interface DeviceCardProps {
  peer: PeerInfo;
  index: number;
  disabled: boolean;
  activity: CardActivity | null;
  onFiles: (files: File[]) => void;
}

const VIA_LABEL = { room: "Paired", dev: "Dev group", network: "Same network" } as const;

export function DeviceCard({ peer, index, disabled, activity, onFiles }: DeviceCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  const ring =
    activity?.tone === "error"
      ? "ring-rose-400/50"
      : activity?.tone === "success"
        ? "ring-emerald-400/50"
        : dragging
          ? "ring-teal-300/70"
          : "ring-white/10 hover:ring-sky-300/40";

  return (
    <div
      className="w-[calc(50%-0.375rem)] max-w-[220px] animate-card-in sm:w-52"
      style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        data-testid="device-card"
        data-peer-id={peer.id}
        data-peer-name={peer.name}
        className={`group relative flex w-full flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-b from-white/[0.07] to-white/[0.02] px-4 pb-5 pt-6 text-center ring-1 backdrop-blur-xl transition duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 ${ring} ${dragging ? "scale-[1.03] bg-teal-400/10" : ""}`}
      >
        <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/25 to-teal-400/20 ring-1 ring-white/10 transition group-hover:from-blue-500/35 group-hover:to-teal-400/30">
          <DeviceIcon type={peer.deviceType} className="h-8 w-8 text-sky-100" />
          <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-navy-900" />
        </span>
        <span className="mt-4 block max-w-full truncate font-semibold">{peer.name}</span>
        <span className="mt-0.5 block max-w-full truncate text-xs text-slate-400">
          {deviceLabel(peer.os, peer.browser)}
        </span>
        <span className="mt-3 flex flex-wrap justify-center gap-1">
          {peer.via.map((via) => (
            <span key={via} className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
              {VIA_LABEL[via]}
            </span>
          ))}
        </span>

        <span className="mt-4 flex h-5 items-center gap-1.5 text-xs" data-testid="card-activity">
          {activity ? (
            <span
              className={
                activity.tone === "error"
                  ? "text-rose-300"
                  : activity.tone === "success"
                    ? "text-emerald-300"
                    : "text-teal-200"
              }
            >
              {activity.label}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-slate-500 transition group-hover:text-sky-200">
              <Upload className="h-3.5 w-3.5" aria-hidden />
              Tap or drop files
            </span>
          )}
        </span>

        {activity?.progress !== null && activity?.progress !== undefined && (
          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/5">
            <span
              className="block h-full bg-gradient-to-r from-blue-400 to-teal-300 transition-[width] duration-300 ease-out"
              style={{ width: `${Math.round(activity.progress * 100)}%` }}
            />
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}
