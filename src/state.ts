// The single app state and the chat state machine. Pure TS, no DOM.
// One turn at a time: idle -> sending -> queued -> streaming ->
// (done | stopped | error), then back to idle on the next turn.
import type { BrainInfo, ChatMessage, Timings } from "./api";

export type Phase =
  | "idle"
  | "sending"
  | "queued"
  | "streaming"
  | "done"
  | "stopped"
  | "error";

export interface Entry {
  role: "user" | "assistant" | "system";
  text: string;
  partial?: boolean; // a cancelled answer keeps its partial text
  error?: boolean;
}

export interface TurnStats {
  ms: number;
  model: string;
  deltas: number; // delta events this turn ~ generated tokens (forge estimate)
  timings?: Timings; // exact numbers, raw path only
}

export interface AppState {
  brain: BrainInfo | null;
  thread: string | null; // forge thread id
  transcript: Entry[];
  raw: ChatMessage[]; // raw path: the client-side history, no system message
  phase: Phase;
  turnStart: number;
  deltas: number;
  lastStats: TurnStats | null;
  lastError: string | null; // the hint of the last error, for the status line
}

export const state: AppState = {
  brain: null,
  thread: null,
  transcript: [],
  raw: [],
  phase: "idle",
  turnStart: 0,
  deltas: 0,
  lastStats: null,
  lastError: null,
};

/** one turn at a time */
export function busy(s: AppState): boolean {
  return s.phase === "sending" || s.phase === "queued" || s.phase === "streaming";
}

/** idle/done/stopped/error -> sending; returns the assistant entry to fill */
export function beginTurn(s: AppState, text: string): Entry {
  s.transcript.push({ role: "user", text });
  const entry: Entry = { role: "assistant", text: "", partial: true };
  s.transcript.push(entry);
  s.phase = "sending";
  s.turnStart = Date.now();
  s.deltas = 0;
  s.lastError = null;
  if (s.brain?.kind === "raw") s.raw.push({ role: "user", content: text });
  return entry;
}

export function onQueued(s: AppState): void {
  if (s.phase === "sending") s.phase = "queued";
}

export function onDelta(s: AppState, entry: Entry, t: string): void {
  entry.text += t;
  s.deltas += 1;
  s.phase = "streaming";
}

export function onDone(
  s: AppState,
  entry: Entry,
  e: { thread?: string; ms?: number; model?: string; timings?: Timings },
): void {
  entry.partial = false;
  s.phase = "done";
  if (s.brain?.kind === "forge" && e.thread) s.thread = e.thread;
  if (s.brain?.kind === "raw") s.raw.push({ role: "assistant", content: entry.text });
  s.lastStats = {
    ms: e.ms ?? Date.now() - s.turnStart,
    model: e.model ?? modelName(s.brain),
    deltas: s.deltas,
    timings: e.timings,
  };
}

/** cancel keeps the partial text, like the terminal's `* (stopped)` */
export function onStopped(s: AppState, entry: Entry): void {
  entry.partial = true;
  s.phase = "stopped";
  if (s.brain?.kind === "raw" && entry.text)
    s.raw.push({ role: "assistant", content: entry.text });
}

export function onError(s: AppState, entry: Entry, hint: string): void {
  s.phase = "error";
  s.lastError = hint;
  if (!entry.text) {
    entry.text = hint;
    entry.error = true;
    entry.partial = false;
  } // a half-streamed answer keeps its partial text; the hint goes to the status line
}

/** /new: a fresh thread, an empty transcript */
export function freshThread(s: AppState): void {
  s.thread = null;
  s.transcript = [];
  s.raw = [];
  s.phase = "idle";
  s.lastError = null;
}

/** a thread opened from the drawer replaces the transcript (forge only) */
export function loadThread(
  s: AppState,
  id: string,
  messages: { role: string; text: string; partial?: boolean }[],
): void {
  s.thread = id;
  s.transcript = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "system",
    text: m.text,
    partial: m.partial,
  }));
  s.phase = "idle";
  s.lastError = null;
}

/** the model answering conversations: the ember role on a forge, else the model */
export function modelName(brain: BrainInfo | null): string {
  if (!brain) return "";
  if (brain.kind === "forge" && brain.roles?.ember) return brain.roles.ember;
  return brain.model ?? brain.name ?? brain.url;
}

/** the /model one-liner: `<model> via <url> (<kind>)` */
export function brainLine(brain: BrainInfo | null): string {
  if (!brain) return "no brain yet -- connect in settings";
  return `${modelName(brain) || "?"} via ${brain.url} (${brain.kind})`;
}

/** the stats line after done: exact from timings (raw), else an estimate */
export function statsLine(s: AppState): string {
  const t = s.lastStats;
  if (!t) return "(no turns yet)";
  const tg = t.timings?.tg_tps;
  if (typeof tg === "number") {
    const pp = t.timings?.pp_tps ?? 0;
    return `${t.ms} ms  ${t.model}  ${tg.toFixed(1)} tok/s (prompt ${pp.toFixed(0)} tok/s)`;
  }
  const secs = t.ms / 1000;
  const tps = secs > 0 && t.deltas > 0 ? ` ~${(t.deltas / secs).toFixed(0)} tok/s` : "";
  return `${t.ms} ms  ${t.model}${tps}`;
}
