import { Link2, TriangleAlert, X, Heart } from "lucide-react";
import { SupportDialog } from "./components/SupportDialog";
import type { PeerInfo } from "@dropflow/shared";
import { useEffect, useState } from "react";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { DeviceCard, type CardActivity } from "./components/DeviceCard";
import { deviceLabel } from "./components/DeviceIcon";
import { IncomingDialog } from "./components/IncomingDialog";
import { PairingDialog } from "./components/PairingDialog";
import { Radar } from "./components/Radar";
import { ReceivedSheet } from "./components/ReceivedSheet";
import { TransferPanel } from "./components/TransferPanel";
import { discovery, transfers } from "./core/app";
import { useStore } from "./core/store";
import type { BatchView } from "./transfer/TransferManager";
import { Send, Radio } from "lucide-react";

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
  const connected = state.status === "connected";
  const grouped = state.membership.dev || state.membership.network || state.membership.rooms.length > 0;
  const [supportOpen, setSupportOpen] = useState(false);

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

  return (
    <div className="flex min-h-screen flex-col">

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-5 sm:px-8">
        {/* Logo and Brand */}
        <div className="flex items-center gap-2.5">
    <span className="group relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-blue-600 via-sky-500 to-teal-400 shadow-lg shadow-sky-500/30 transition-all duration-300 hover:scale-105 hover:shadow-sky-500/50">
      {/* Subtle wireless signal */}
      <Radio
          className="absolute h-8 w-8 text-white/20"
          strokeWidth={1.5}
          aria-hidden="true"
      />

      {/* Send icon */}
      <Send
          className="relative z-10 h-5 w-5 -rotate-12 text-white drop-shadow-md transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
          strokeWidth={2.5}
          aria-hidden="true"
      />

      {/* Subtle highlight */}
      <span className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-tr from-transparent via-white/10 to-white/20" />
    </span>

          <span className="text-lg font-bold tracking-tight">
      Air<span className="text-sky-400">File</span>Drop
    </span>
        </div>

        {/* Connection Status and Pair Button */}
        <div className="flex items-center gap-2">
          <ConnectionStatus status={state.status} />
          <button
              type="button"
              onClick={() => setSupportOpen(true)}
              aria-label="Support AirFileDrop"
              className="glass inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium text-slate-100 transition hover:bg-white/10"
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


      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-28 sm:px-8">
        <section className="flex flex-col items-center pt-4 text-center sm:pt-8">
          <Radar self={state.self} peers={state.peers} active={connected} />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight sm:text-3xl">
            {state.peers.length > 0
              ? "Pick a device to send files"
              : connected
                ? "Ready to connect"
                : "Waiting for server…"}
          </h1>
          {state.self && (
            <p className="mt-2 text-sm text-slate-400" data-testid="self-name">
              You appear as <span className="font-medium text-slate-200">{state.self.name}</span>
              <span className="text-slate-500"> · {deviceLabel(state.self.os, state.self.browser)}</span>
            </p>
          )}
        </section>

        {!transferState.support.ok && (
          <p
            role="alert"
            className="mx-auto mt-8 flex max-w-md items-start gap-2 rounded-2xl bg-amber-400/10 px-4 py-3 text-sm text-amber-200"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {transferState.support.reason}
          </p>
        )}

        <section className="mt-10" aria-label="Nearby devices">
          {state.peers.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-3 sm:gap-4" data-testid="device-grid">
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
            <div className="glass mx-auto max-w-md rounded-3xl px-6 py-8 text-center" data-testid="empty-state">
              <p className="font-medium text-slate-200">
                {state.membership.network ? "Looking for devices on your network…" : grouped ? "No other devices here yet" : "No devices visible yet"}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                {state.membership.network
                  ? "Open AirFileDrop on another device on the same Wi-Fi and it will show up here. Not appearing? Pair with a QR code instead."
                  : grouped
                    ? "Open AirFileDrop on another device and pair it with the same code. It will show up here right away."
                    : "For privacy, devices only see each other after pairing. Scan a QR code or enter a code on your other device."}
              </p>
              <button
                type="button"
                onClick={() => setPairingOpen(true)}
                className="mt-5 rounded-full bg-gradient-to-r from-blue-500 to-teal-400 px-5 py-2.5 text-sm font-semibold text-navy-950 shadow-lg shadow-sky-500/20 transition hover:brightness-110"
              >
                Pair a device
              </button>
            </div>
          )}
        </section>
      </main>

      {state.notice && (
        <div className="fixed inset-x-0 top-4 z-40 flex justify-center px-4">
          <div
            role="status"
            className="glass flex animate-sheet-in items-center gap-3 rounded-2xl bg-navy-800/80 px-4 py-3 text-sm shadow-xl"
          >
            {state.notice}
            <button type="button" onClick={() => discovery.clearNotice()} aria-label="Dismiss" className="text-slate-400 hover:text-white">
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
