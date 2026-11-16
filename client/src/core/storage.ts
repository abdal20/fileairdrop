const KEY = "dropflow:session";
const NETWORK_KEY = "dropflow:network";

export function loadNetworkPreference(): boolean | null {
  try {
    const v = localStorage.getItem(NETWORK_KEY);
    return v === "on" ? true : v === "off" ? false : null;
  } catch {
    return null;
  }
}

export function saveNetworkPreference(on: boolean) {
  try {
    localStorage.setItem(NETWORK_KEY, on ? "on" : "off");
  } catch {
    return;
  }
}

export interface StoredSession {
  sessionId?: string;
  resumeToken?: string;
  roomTokens: string[];
  dev: boolean;
}

const empty: StoredSession = { roomTokens: [], dev: false };

export function loadSession(): StoredSession {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { ...empty };
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      resumeToken: typeof parsed.resumeToken === "string" ? parsed.resumeToken : undefined,
      roomTokens: Array.isArray(parsed.roomTokens)
        ? parsed.roomTokens.filter((t): t is string => typeof t === "string").slice(0, 5)
        : [],
      dev: parsed.dev === true,
    };
  } catch {
    return { ...empty };
  }
}

export function saveSession(session: StoredSession) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    return;
  }
}
