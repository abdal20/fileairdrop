import type { ConnectionStatus as Status } from "../core/discovery";

const styles: Record<Status, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-emerald-400", text: "text-emerald-300" },
  connecting: { label: "Connecting…", dot: "bg-amber-400 animate-pulse", text: "text-amber-300" },
  disconnected: { label: "Offline", dot: "bg-rose-400", text: "text-rose-300" },
};

export function ConnectionStatus({ status }: { status: Status }) {
  const { label, dot, text } = styles[status];
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="connection-status"
      data-status={status}
      className={`glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${text}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}
