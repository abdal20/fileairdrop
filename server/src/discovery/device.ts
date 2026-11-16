import { randomInt } from "node:crypto";
import type { DeviceType } from "@dropflow/shared";

const ADJECTIVES = [
  "Amber", "Bright", "Calm", "Clever", "Cosmic", "Crimson", "Daring", "Electric",
  "Gentle", "Golden", "Happy", "Jolly", "Lucky", "Lunar", "Mellow", "Misty",
  "Noble", "Polar", "Quick", "Quiet", "Rapid", "Silver", "Solar", "Swift",
  "Teal", "Velvet", "Vivid", "Wild", "Witty", "Zen",
];

const ANIMALS = [
  "Badger", "Falcon", "Fox", "Gecko", "Heron", "Koala", "Lemur", "Lynx",
  "Marten", "Narwhal", "Orca", "Otter", "Owl", "Panda", "Penguin", "Puffin",
  "Quokka", "Raven", "Salmon", "Seal", "Sparrow", "Tiger", "Toucan", "Turtle",
  "Walrus", "Wombat", "Yak", "Zebra",
];

export function friendlyName(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${ANIMALS[randomInt(ANIMALS.length)]}`;
}

export function parseOs(ua: string): string | null {
  if (/iPhone|iPod/.test(ua)) return "iOS";
  if (/iPad/.test(ua)) return "iPadOS";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

export function parseBrowser(ua: string): string | null {
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS/.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS/.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return null;
}

export function guessDeviceType(ua: string): DeviceType {
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod|Android/.test(ua)) return "mobile";
  if (/Windows|Macintosh|Mac OS X|Linux|CrOS/.test(ua)) return "desktop";
  return "unknown";
}

const DEVICE_TYPES: readonly DeviceType[] = ["desktop", "mobile", "tablet", "unknown"];

export function resolveDeviceType(hint: unknown, ua: string): DeviceType {
  if (typeof hint === "string" && (DEVICE_TYPES as readonly string[]).includes(hint)) {
    return hint as DeviceType;
  }
  return guessDeviceType(ua);
}
