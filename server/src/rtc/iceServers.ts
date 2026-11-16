import { createHmac } from "node:crypto";
import type { IceServerConfig } from "@dropflow/shared";
import type { AppConfig } from "../config/env.js";

export function buildIceServers(config: AppConfig, deviceId: string): IceServerConfig[] {
  const servers: IceServerConfig[] = [];

  if (config.stunUrls.length > 0) {
    servers.push({ urls: config.stunUrls });
  }

  if (config.turnUrls.length > 0) {
    if (config.turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSeconds;
      const username = `${expiry}:${deviceId}`;
      const credential = createHmac("sha1", config.turnSecret).update(username).digest("base64");
      servers.push({ urls: config.turnUrls, username, credential });
    } else if (config.turnUsername && config.turnCredential) {
      servers.push({
        urls: config.turnUrls,
        username: config.turnUsername,
        credential: config.turnCredential,
      });
    }
  }

  return servers;
}
