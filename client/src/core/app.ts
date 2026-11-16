import { TransferManager } from "../transfer/TransferManager";
import { DiscoveryClient } from "./discovery";

export const discovery = new DiscoveryClient();
export const transfers = new TransferManager(discovery);

let started = false;

export function startApp() {
  if (started) return;
  started = true;
  discovery.start();
}
