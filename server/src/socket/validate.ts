import type { IceCandidatePayload, OutgoingSignal, SignalKind } from "@dropflow/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const CONN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CODE_RE = /^\d{6}$/;
const SIGNAL_KINDS: readonly SignalKind[] = ["offer", "answer", "candidate"];

export const MAX_SDP_LENGTH = 32_000;
export const MAX_CANDIDATE_LENGTH = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

export function parseToken(payload: unknown): string | null {
  return isRecord(payload) && isToken(payload.token) ? payload.token : null;
}

export function parseCode(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.code !== "string") return null;
  const code = payload.code.replace(/\s|-/g, "");
  return CODE_RE.test(code) ? code : null;
}

export function parseRoomId(payload: unknown): string | null {
  return isRecord(payload) && isUuid(payload.roomId) ? payload.roomId : null;
}

function parseCandidate(value: unknown): IceCandidatePayload | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = value;
  if (typeof candidate !== "string" || candidate.length > MAX_CANDIDATE_LENGTH) return undefined;
  if (sdpMid !== null && sdpMid !== undefined && (typeof sdpMid !== "string" || sdpMid.length > 64)) {
    return undefined;
  }
  if (
    sdpMLineIndex !== null &&
    sdpMLineIndex !== undefined &&
    (!Number.isInteger(sdpMLineIndex) || (sdpMLineIndex as number) < 0 || (sdpMLineIndex as number) > 64)
  ) {
    return undefined;
  }
  if (
    usernameFragment !== null &&
    usernameFragment !== undefined &&
    (typeof usernameFragment !== "string" || usernameFragment.length > 256)
  ) {
    return undefined;
  }
  return {
    candidate,
    sdpMid: (sdpMid as string | null | undefined) ?? null,
    sdpMLineIndex: (sdpMLineIndex as number | null | undefined) ?? null,
    usernameFragment: (usernameFragment as string | null | undefined) ?? null,
  };
}

export function parseSignal(payload: unknown): OutgoingSignal | null {
  if (!isRecord(payload)) return null;
  const { to, connId, kind, sdp, candidate } = payload;
  if (!isUuid(to)) return null;
  if (typeof connId !== "string" || !CONN_ID_RE.test(connId)) return null;
  if (typeof kind !== "string" || !(SIGNAL_KINDS as readonly string[]).includes(kind)) return null;

  if (kind === "offer" || kind === "answer") {
    if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > MAX_SDP_LENGTH) return null;
    return { to, connId, kind, sdp };
  }

  const parsed = parseCandidate(candidate);
  if (parsed === undefined) return null;
  return { to, connId, kind: "candidate", candidate: parsed };
}
