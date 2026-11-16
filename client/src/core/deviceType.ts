import type { DeviceType } from "@dropflow/shared";

interface NavigatorUAData {
  mobile?: boolean;
}

export function detectDeviceType(): DeviceType {
  const nav = navigator as Navigator & { userAgentData?: NavigatorUAData };
  const ua = nav.userAgent;
  const touch = nav.maxTouchPoints > 1;

  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return "tablet";
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return "tablet";
  if (nav.userAgentData?.mobile || /iPhone|iPod|Mobi/.test(ua)) return "mobile";

  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (coarse && touch) {
    return Math.min(screen.width, screen.height) >= 600 ? "tablet" : "mobile";
  }
  return "desktop";
}
