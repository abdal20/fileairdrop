import { Heart, Link2, Radio, Send, ShieldCheck, TriangleAlert, Wifi, X, Zap } from "lucide-react";
import type { PeerInfo } from "@dropflow/shared";
import { useEffect, useState } from "react";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { DeviceCard, type CardActivity } from "./components/DeviceCard";
import { deviceLabel } from "./components/DeviceIcon";
import { IncomingDialog } from "./components/IncomingDialog";
import { PairingDialog } from "./components/PairingDialog";
import { Radar } from "./components/Radar";
import { ReceivedSheet } from "./components/ReceivedSheet";
import { SupportDialog } from "./components/SupportDialog";
import { TransferPanel } from "./components/TransferPanel";
import { discovery, transfers } from "./core/app";
import { useStore } from "./core/store";
import type { BatchView } from "./transfer/TransferManager";

const STEPS = [
  { title: "Open AirFileDrop on both devices", text: "any browser, nothing to install" },
  { title: "Pair them", text: "scan the QR code or enter the 6-digit code" },
  { title: "Tap a device to send", text: "files go directly and encrypted" },
];

const STATUS_DOT = {
  connected: "bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153)]",
  connecting: "bg-amber-400 animate-pulse",
  disconnected: "bg-rose-400",
} as const;

function activityFor(peer: PeerInfo, batches: BatchView[], now: number): CardActivity | null {
  const batch = batches.find((b) => b.peerId === peer.id);
  if (!batch) return null;
  const pct = batch.totalBytes > 0 ? batch.doneBytes / batch.totalBytes : 0;
  switch (batch.status) {
    case "queued":
      return { label: "Queued", progress: null, tone: "active" };
    case "connecting":
      return { label: "Connecting…", progress: null, tone: "active" };
    case "waiting":
      return { label: "Waiting for approval…", progress: null, tone: "active" };
    case "transferring":
      return {
        label: `${batch.direction === "outgoing" ? "Sending" : "Receiving"} ${Math.floor(pct * 100)}%`,
        progress: pct,
        tone: "active",
      };
  }
  if (!batch.finishedAt || now - batch.finishedAt > 6000) return null;
  if (batch.status === "completed") {
    return { label: batch.direction === "outgoing" ? "Delivered" : "Received", progress: null, tone: "success" };
  }
  if (batch.status === "cancelled") return { label: "Cancelled", progress: null, tone: "error" };
  return { label: batch.status === "rejected" ? "Declined" : "Failed", progress: null, tone: "error" };
}

export default function App() {
  const state = useStore(discovery.store);
  const transferState = useStore(transfers.store);
  const [now, setNow] = useState(Date.now());
  const [sheetDismissed, setSheetDismissed] = useState<Set<string>>(new Set());
  const [sheetIds, setSheetIds] = useState<string[]>([]);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const connected = state.status === "connected";
  const hasPeers = state.peers.length > 0;
  const canFindOnWifi = state.features.network === "opt-in" && !state.membership.network;

  useEffect(() => {
    if (!transfers.mustSaveManually) return;
    const busy = new Set(
        transferState.batches
            .filter((b) => b.direction === "incoming" && (b.status === "transferring" || b.status === "waiting"))
            .map((b) => b.batchId),
    );
    const fresh = transferState.received
        .filter((r) => r.blob && !r.saved && !busy.has(r.batchId) && !sheetDismissed.has(r.id))
        .map((r) => r.id);
    setSheetIds((current) => {
      const merged = [...current.filter((id) => transferState.received.some((r) => r.id === id)), ...fresh];
      const unique = [...new Set(merged)];
      return unique.length === current.length && unique.every((id, i) => id === current[i]) ? current : unique;
    });
  }, [transferState.received, transferState.batches, sheetDismissed]);

  const closeSheet = () => {
    setSheetDismissed((prev) => new Set([...prev, ...sheetIds]));
    setSheetIds([]);
  };

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!state.notice) return;
    const id = setTimeout(() => discovery.clearNotice(), 5000);
    return () => clearTimeout(id);
  }, [state.notice]);

  const subline = hasPeers
      ? "Tap a device to pick files, or drag files right onto it."
      : state.membership.network
          ? "Devices on the same Wi-Fi will show up here automatically. You can also pair any device with a QR code."
          : "Pair your devices with a QR code or a 6-digit code, or find devices on your Wi-Fi.";

  return (
      <div className="flex min-h-[100dvh] flex-col">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-4 sm:px-8 sm:py-5">
          <div className="flex items-center gap-2.5">
          <span className="group relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-blue-600 via-sky-500 to-teal-400 shadow-lg shadow-sky-500/30 transition-all duration-300 hover:scale-105 hover:shadow-sky-500/50">
            <Radio className="absolute h-8 w-8 text-white/20" strokeWidth={1.5} aria-hidden="true" />
            <Send
                className="relative z-10 h-5 w-5 -rotate-12 text-white drop-shadow-md transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                strokeWidth={2.5}
                aria-hidden="true"
            />
            <span className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-tr from-transparent via-white/10 to-white/20" />
          </span>
            <span className="text-lg font-bold tracking-tight">
            Air<span className="text-sky-400">File</span>Drop
          </span>
          </div>

          <div className="flex items-center gap-2">
          <span className="hidden sm:block">
            <ConnectionStatus status={state.status} />
          </span>
            <button
                type="button"
                onClick={() => setSupportOpen(true)}
                aria-label="Support AirFileDrop"
                className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-slate-100 transition hover:bg-white/10 sm:px-3.5"
            >
              <Heart className="h-4 w-4 text-rose-300" aria-hidden />
              <span className="hidden sm:inline">Support</span>
            </button>
            <button
                type="button"
                onClick={() => setPairingOpen(true)}
                data-testid="open-pairing"
                className="glass inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium text-slate-100 transition hover:bg-white/10"
            >
              <Link2 className="h-4 w-4 text-teal-300" aria-hidden="true" />
              Pair
            </button>
          </div>
        </header>

        <main className="mx-auto grid w-full max-w-6xl flex-1 content-start items-center gap-6 px-5 pb-28 sm:px-8 lg:grid-cols-2 lg:content-center lg:gap-12 lg:pb-16">
          <section className="flex flex-col items-center">
            <div className={`radar-stage ${hasPeers ? "is-compact" : ""}`}>
              <Radar self={state.self} peers={state.peers} active={connected} />
            </div>
            {state.self && (
                <p
                    className="glass mt-3 inline-flex max-w-full items-center gap-2 rounded-full px-4 py-1.5 text-sm text-slate-400"
                    data-testid="self-name"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[state.status]}`} aria-hidden />
                  You appear as <span className="truncate font-medium text-slate-100">{state.self.name}</span>
                  <span className="hidden text-slate-500 min-[400px]:inline">
                {" "}
                    · {deviceLabel(state.self.os, state.self.browser)}
              </span>
                </p>
            )}
          </section>

          <section className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <p className="glass hidden items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-slate-300 sm:inline-flex">
              <ShieldCheck className="h-3.5 w-3.5 text-teal-300" aria-hidden />
              Private · Peer-to-peer · No sign-up
            </p>

            <h1 className="mt-0 text-balance text-[1.7rem] font-semibold leading-tight tracking-tight sm:mt-4 sm:text-4xl lg:text-[2.75rem]">
              {!connected ? (
                  "Connecting…"
              ) : hasPeers ? (
                  <>
                    Tap a device to <span className="text-gradient">send files</span>
                  </>
              ) : (
                  <>
                    Open AirFileDrop on your other devices to <span className="text-gradient">send files</span>
                  </>
              )}
            </h1>
            <p className="mt-3 max-w-md text-balance text-sm leading-relaxed text-slate-400 sm:text-base">{subline}</p>

            {!transferState.support.ok && (
                <p
                    role="alert"
                    className="mt-4 flex max-w-md items-start gap-2 rounded-2xl bg-amber-400/10 px-4 py-3 text-left text-sm text-amber-200"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {transferState.support.reason}
                </p>
            )}

            {hasPeers ? (
                <div
                    className="mt-6 flex w-full flex-wrap justify-center gap-3 sm:gap-4 lg:justify-start"
                    data-testid="device-grid"
                    aria-label="Nearby devices"
                >
                  {state.peers.map((peer, index) => (
                      <DeviceCard
                          key={peer.id}
                          peer={peer}
                          index={index}
                          disabled={!connected || !transferState.support.ok}
                          activity={activityFor(peer, transferState.batches, now)}
                          onFiles={(files) => transfers.send(peer, files)}
                      />
                  ))}
                </div>
            ) : (
                <div className="w-full" data-testid="empty-state">
                  <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
                    <button
                        type="button"
                        onClick={() => setPairingOpen(true)}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-blue-500 to-teal-400 px-6 py-3 text-sm font-semibold text-navy-950 shadow-lg shadow-sky-500/25 transition hover:-translate-y-0.5 hover:brightness-110 sm:w-auto"
                    >
                      <Link2 className="h-4 w-4" aria-hidden />
                      Pair a device
                    </button>
                    {canFindOnWifi && (
                        <button
                            type="button"
                            onClick={() => discovery.setNetworkVisible(true)}
                            className="glass inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-medium text-slate-100 transition hover:bg-white/10 sm:w-auto"
                        >
                          <Wifi className="h-4 w-4 text-teal-300" aria-hidden />
                          Find devices on my Wi-Fi
                        </button>
                    )}
                  </div>

                  <ol className="mx-auto mt-7 max-w-md space-y-3 text-left lg:mx-0">
                    {STEPS.map((step, i) => (
                        <li key={step.title} className="flex animate-card-in items-start gap-3" style={{ animationDelay: `${i * 90}ms` }}>
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/30 to-teal-400/25 text-xs font-semibold text-sky-100 ring-1 ring-white/10">
                      {i + 1}
                    </span>
                          <p className="text-sm leading-relaxed">
                            <span className="font-medium text-slate-200">{step.title}</span>
                            <span className="text-slate-500"> · {step.text}</span>
                          </p>
                        </li>
                    ))}
                  </ol>
                </div>
            )}

            <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-slate-500 lg:justify-start">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-teal-300/80" aria-hidden />
              Direct and encrypted
            </span>
              <span className="inline-flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-sky-300/80" aria-hidden />
              No uploads, no accounts
            </span>
              <button
                  type="button"
                  onClick={() => setSupportOpen(true)}
                  className="inline-flex items-center gap-1.5 transition hover:text-slate-200"
              >
                <Heart className="h-3.5 w-3.5 text-rose-300/80" aria-hidden />
                Support the project
              </button>
            </footer>
          </section>
        </main>

        {state.notice && (
            <div className="fixed inset-x-0 top-4 z-40 flex justify-center px-4">
              <div
                  role="status"
                  className="glass flex animate-sheet-in items-center gap-3 rounded-2xl bg-navy-800/80 px-4 py-3 text-sm shadow-xl"
              >
                {state.notice}
                <button
                    type="button"
                    onClick={() => discovery.clearNotice()}
                    aria-label="Dismiss"
                    className="text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
        )}

        <TransferPanel batches={transferState.batches} received={transferState.received} />
        <IncomingDialog request={transferState.incoming[0] ?? null} />
        {transferState.incoming.length === 0 && (
            <ReceivedSheet
                items={transferState.received.filter((r) => sheetIds.includes(r.id)).reverse()}
                onClose={closeSheet}
            />
        )}
        <SupportDialog open={supportOpen} onClose={() => setSupportOpen(false)} />
        <PairingDialog
            open={pairingOpen}
            onClose={() => setPairingOpen(false)}
            membership={state.membership}
            features={state.features}
            lanAddresses={state.lanAddresses}
        />
      </div>
  );
}