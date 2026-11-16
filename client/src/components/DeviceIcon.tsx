import { HelpCircle, Monitor, Smartphone, Tablet, type LucideProps } from "lucide-react";
import type { DeviceType } from "@dropflow/shared";

const ICONS = {
  desktop: Monitor,
  mobile: Smartphone,
  tablet: Tablet,
  unknown: HelpCircle,
} as const;

export function DeviceIcon({ type, ...props }: { type: DeviceType } & LucideProps) {
  const Icon = ICONS[type] ?? HelpCircle;
  return <Icon aria-hidden {...props} />;
}

export function deviceLabel(os: string | null, browser: string | null): string {
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Web browser";
}
