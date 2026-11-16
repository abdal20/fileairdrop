import type { DeviceInfo, PeerInfo } from "@dropflow/shared";
import { DeviceIcon } from "./DeviceIcon";

interface RadarProps {
  self: DeviceInfo | null;
  peers: PeerInfo[];
  active: boolean;
}

function angleFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return (hash % 360) * (Math.PI / 180);
}

export function Radar({ self, peers, active }: RadarProps) {
  return (
    <div className="relative mx-auto aspect-square w-56 sm:w-72" aria-hidden>
      {[1, 0.72, 0.44].map((scale) => (
        <div
          key={scale}
          className="absolute inset-0 m-auto rounded-full border border-sky-400/10"
          style={{ width: `${scale * 100}%`, height: `${scale * 100}%` }}
        />
      ))}

      {active && (
        <>
          <div
            className="absolute inset-0 animate-radar-sweep rounded-full"
            style={{
              background:
                "conic-gradient(from 0deg, rgb(45 212 191 / 0.28), rgb(56 189 248 / 0.08) 50deg, transparent 90deg)",
              maskImage: "radial-gradient(circle, black 0%, black 69%, transparent 70%)",
            }}
          />
          <div className="absolute inset-0 animate-radar-pulse rounded-full border border-teal-300/30" />
        </>
      )}

      {peers.slice(0, 12).map((peer) => {
        const angle = angleFor(peer.id);
        const r = 38;
        return (
          <span
            key={peer.id}
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 animate-blip rounded-full bg-teal-300 shadow-[0_0_12px_rgb(94_234_212)]"
            style={{ left: `${50 + r * Math.cos(angle)}%`, top: `${50 + r * Math.sin(angle)}%` }}
          />
        );
      })}

      <div className="absolute inset-0 m-auto flex h-24 w-24 flex-col items-center justify-center rounded-full bg-gradient-to-br from-blue-500/30 to-teal-400/20 ring-1 ring-white/15 shadow-[0_0_60px_rgb(56_189_248/0.25)] sm:h-28 sm:w-28">
        <DeviceIcon type={self?.deviceType ?? "unknown"} className="h-8 w-8 text-sky-200 sm:h-9 sm:w-9" />
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-200/70">You</span>
      </div>
    </div>
  );
}
