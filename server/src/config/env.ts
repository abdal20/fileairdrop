import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NetworkDiscoveryMode } from "@dropflow/shared";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath) && !process.env.DROPFLOW_SKIP_ENV_FILE) {
  process.loadEnvFile(envPath);
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function parseList(value: string | undefined, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseNetworkMode(value: string | undefined, legacy: string | undefined): NetworkDiscoveryMode {
  const v = value?.trim().toLowerCase();
  if (v === "off" || v === "opt-in" || v === "auto") return v;
  if (parseBool(legacy, false)) return "auto";
  return "opt-in";
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  clientOrigins: string[];
  trustProxy: boolean;
  devGroupEnabled: boolean;
  networkDiscovery: NetworkDiscoveryMode;
  suggestNetworkOnPrivateIp: boolean;
  stunUrls: string[];
  turnUrls: string[];
  turnUsername: string | null;
  turnCredential: string | null;
  turnSecret: string | null;
  turnTtlSeconds: number;
  sessionGraceMs: number;
  staticDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT, 3001),
    host: env.HOST || "0.0.0.0",
    nodeEnv,
    clientOrigins: parseList(env.CLIENT_ORIGIN, ["http://localhost:5173"]),
    trustProxy: parseBool(env.TRUST_PROXY, false),
    devGroupEnabled: parseBool(env.DEV_GROUP_ENABLED, !isProduction),
    networkDiscovery: parseNetworkMode(env.NETWORK_DISCOVERY, env.PUBLIC_IP_DISCOVERY),
    suggestNetworkOnPrivateIp: !isProduction,
    stunUrls: parseList(env.STUN_URLS, ["stun:stun.l.google.com:19302"]),
    turnUrls: parseList(env.TURN_URLS),
    turnUsername: env.TURN_USERNAME || null,
    turnCredential: env.TURN_CREDENTIAL || null,
    turnSecret: env.TURN_SECRET || null,
    turnTtlSeconds: parsePositiveInt(env.TURN_TTL_SECONDS, 3600),
    sessionGraceMs: parsePositiveInt(env.SESSION_GRACE_MS, 30_000),
    staticDir: env.STATIC_DIR === "" ? null : resolve(env.STATIC_DIR || resolve(process.cwd(), "../client/dist")),
  };
}

export const config = loadConfig();
