import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, HandshakeAuth, ServerToClientEvents } from "@dropflow/shared";

export type DropFlowSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const serverUrl = import.meta.env.VITE_SERVER_URL?.trim() || undefined;

export function createSocket(getAuth: () => HandshakeAuth): DropFlowSocket {
  const options = {
    autoConnect: false,
    transports: ["websocket", "polling"],
    auth: (cb: (data: object) => void) => cb(getAuth()),
  };
  return serverUrl ? io(serverUrl, options) : io(options);
}
