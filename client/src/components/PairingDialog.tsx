import { Check, Copy, Wifi, KeyRound, LogOut, QrCode as QrIcon, RefreshCw, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MembershipState, RoomInfo, SessionReady } from "@dropflow/shared";
import { discovery } from "../core/app";
import { describeError } from "../core/discovery";
import { Dialog } from "./Dialog";
import { QrCode } from "./QrCode";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function shareBase(lanAddresses: string[]): { base: string; unreachable: boolean } {
  const path = location.pathname;
  if (!LOCAL_HOSTS.includes(location.hostname)) return { base: location.origin + path, unreachable: false };
  if (lanAddresses.length === 0) return { base: location.origin + path, unreachable: true };
  const port = location.port ? `:${location.port}` : "";
  return { base: `${location.protocol}//${lanAddresses[0]}${port}${path}`, unreachable: false };
}

interface PairingDialogProps {
  lanAddresses: string[];
  open: boolean;
  onClose: () => void;
  membership: MembershipState;
  features: SessionReady["features"];
}

function useCountdown(expiresAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function RoomCard({ room, lanAddresses }: { room: RoomInfo; lanAddresses: string[] }) {
  const remaining = useCountdown(room.codeExpiresAt);
  const [copied, setCopied] = useState(false);
  const live = room.code !== null && remaining > 0;
  const { base, unreachable } = shareBase(lanAddresses);
  const link = `${base}#join=${room.token}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this pairing link", link);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4" data-testid="room-card">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" aria-hidden />
          {room.memberCount} {room.memberCount === 1 ? "device" : "devices"} in this room
        </span>
        <button
          type="button"
          onClick={() => discovery.leaveRoom(room.roomId)}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 transition hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden />
          Leave
        </button>
      </div>

      <div className="mt-4 flex flex-col items-center">
        <QrCode value={link} />
        <p className="mt-2 text-xs text-slate-400">Scan with your phone's camera to pair instantly</p>
        {unreachable && (
          <p className="mt-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            This page is open as localhost, which other devices can't reach. Open AirFileDrop using this
            computer's network address instead.
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-white/5 pt-4 text-center">
        <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Or type this code</p>
        {live ? (
          <>
            <div
              className="font-mono text-4xl font-semibold tracking-[0.3em] text-white tabular-nums"
              data-testid="room-code"
            >
              {room.code!.slice(0, 3)} {room.code!.slice(3)}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Enter this on the other device. Works once, expires in {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, "0")}
            </p>
          </>
        ) : (
          <p className="py-3 text-sm text-slate-400">The code expired.</p>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => discovery.refreshCode(room.roomId)}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          New code
        </button>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10"
        >
          {copied ? <Check className="h-4 w-4 text-teal-300" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

export function PairingDialog({ open, onClose, membership, features, lanAddresses }: PairingDialogProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCode("");
      setError(null);
    }
  }, [open]);

  const createRoom = async () => {
    setBusy(true);
    const result = await discovery.createRoom();
    setBusy(false);
    setError(result.ok ? null : describeError(result.error));
  };

  const redeem = async (event: FormEvent) => {
    event.preventDefault();
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) return setError("Enter the 6-digit code shown on the other device.");
    setBusy(true);
    const result = await discovery.redeemCode(clean);
    setBusy(false);
    if (result.ok) {
      setCode("");
      setError(null);
      onClose();
    } else {
      setError(describeError(result.error));
    }
  };

  const toggleNetwork = async () => {
    const result = await discovery.setNetworkVisible(!membership.network);
    if (!result.ok) setError(describeError(result.error));
  };


  return (
    <Dialog open={open} onClose={onClose} title="Pair devices" testId="pairing-dialog">
      <div className="space-y-5">
        {features.network === "opt-in" && (
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <span className="flex items-start gap-3">
              <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-teal-300" aria-hidden />
              <span>
                <span className="block text-sm font-medium text-slate-100">Visible on my network</span>
                <span className="block text-xs leading-relaxed text-slate-400">
                  Devices on the same Wi-Fi that also turn this on will appear automatically. Turn it off
                  on shared networks like offices, cafés or hotels.
                </span>
              </span>
            </span>
            <input
              type="checkbox"
              checked={membership.network}
              onChange={toggleNetwork}
              data-testid="network-toggle"
              className="h-5 w-5 shrink-0 accent-teal-400"
            />
          </label>
        )}

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
            <QrIcon className="h-4 w-4 text-sky-300" aria-hidden />
            Show a code on this device
          </h3>
          {membership.rooms.length > 0 ? (
            <div className="space-y-3">
              {membership.rooms.map((room) => (
                <RoomCard key={room.roomId} room={room} lanAddresses={lanAddresses} />
              ))}
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={createRoom}
              data-testid="create-room"
              className="w-full rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 px-4 py-3 text-sm font-semibold text-navy-950 shadow-lg shadow-sky-500/20 transition hover:brightness-110 disabled:opacity-60"
            >
              Create pairing code
            </button>
          )}
        </section>

        <form onSubmit={redeem}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
            <KeyRound className="h-4 w-4 text-teal-300" aria-hidden />
            Enter a code from another device
          </h3>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123 456"
              aria-label="Pairing code"
              data-testid="code-input"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-navy-950/60 px-4 py-3 text-center font-mono text-lg tracking-[0.25em] text-white placeholder:text-slate-600 focus:border-sky-400/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              data-testid="code-submit"
              className="rounded-xl border border-white/10 bg-white/10 px-4 text-sm font-semibold transition hover:bg-white/15 disabled:opacity-60"
            >
              Join
            </button>
          </div>
        </form>

        {error && (
          <p role="alert" className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}


        {features.network === "auto" && (
          <p className="text-xs leading-relaxed text-slate-500">
            This server also groups devices that share a public IP address. That usually means the
            same network, but not always: carrier NAT, VPNs and shared office or campus networks can put
            strangers behind one address.
          </p>
        )}
      </div>
    </Dialog>
  );
}
