export type DeviceType = "desktop" | "mobile" | "tablet" | "unknown";

export type GroupKind = "room" | "dev" | "network";

export type NetworkDiscoveryMode = "off" | "opt-in" | "auto";

export interface DeviceInfo {
  id: string;
  name: string;
  deviceType: DeviceType;
  os: string | null;
  browser: string | null;
}

export interface PeerInfo extends DeviceInfo {
  via: GroupKind[];
}

export interface RoomInfo {
  roomId: string;
  token: string;
  code: string | null;
  codeExpiresAt: number | null;
  memberCount: number;
}

export interface MembershipState {
  dev: boolean;
  network: boolean;
  rooms: RoomInfo[];
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionReady {
  self: DeviceInfo;
  sessionId: string;
  resumeToken: string;
  resumed: boolean;
  iceServers: IceServerConfig[];
  features: {
    devGroup: boolean;
    network: NetworkDiscoveryMode;
    networkSuggested: boolean;
  };
  membership: MembershipState;
  lanAddresses: string[];
}

export interface HandshakeAuth {
  sessionId?: string;
  resumeToken?: string;
  deviceType?: DeviceType;
}

export type AckResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export type Ack<T = Record<string, never>> = (result: AckResult<T>) => void;

export type SignalKind = "offer" | "answer" | "candidate";

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export interface OutgoingSignal {
  to: string;
  connId: string;
  kind: SignalKind;
  sdp?: string;
  candidate?: IceCandidatePayload | null;
}

export interface IncomingSignal {
  from: string;
  connId: string;
  kind: SignalKind;
  sdp?: string;
  candidate?: IceCandidatePayload | null;
}

export interface ServerToClientEvents {
  "session:ready": (payload: SessionReady) => void;
  "session:replaced": () => void;
  "peers:update": (payload: { peers: PeerInfo[] }) => void;
  "membership:update": (payload: MembershipState) => void;
  signal: (payload: IncomingSignal) => void;
  "rate:limited": (payload: { event: string }) => void;
}

export interface ClientToServerEvents {
  "room:create": (payload: Record<string, never>, ack: Ack<{ room: RoomInfo }>) => void;
  "room:join": (payload: { token: string }, ack: Ack<{ room: RoomInfo }>) => void;
  "room:redeem": (payload: { code: string }, ack: Ack<{ room: RoomInfo }>) => void;
  "room:code": (payload: { roomId: string }, ack: Ack<{ room: RoomInfo }>) => void;
  "room:leave": (payload: { roomId: string }, ack: Ack) => void;
  "dev:join": (payload: Record<string, never>, ack: Ack) => void;
  "dev:leave": (payload: Record<string, never>, ack: Ack) => void;
  "network:join": (payload: Record<string, never>, ack: Ack) => void;
  "network:leave": (payload: Record<string, never>, ack: Ack) => void;
  signal: (payload: OutgoingSignal) => void;
}
