// The frozen contract between the webview and the Rust core.
// Every HTTP byte flows through these commands; the token never enters the webview.
import { invoke, Channel } from "@tauri-apps/api/core";

export interface Settings {
  server_url: string;
}

export interface ModelEntry {
  alias: string;
  stem: string;
  loaded: boolean;
}

export interface BrainInfo {
  kind: "forge" | "raw";
  url: string;
  name?: string;
  version?: string;
  model?: string;
  upstream?: string;
  models?: Record<string, string>;
  roles?: Record<string, string>;
  model_list?: ModelEntry[];
}

export interface Timings {
  pp_n?: number;
  pp_tps?: number;
  tg_n?: number;
  tg_tps?: number;
  cache_n?: number;
}

export type ChatEvent =
  | { type: "queued" }
  | { type: "delta"; t: string }
  | { type: "done"; thread?: string; ms?: number; model?: string; timings?: Timings }
  | { type: "error"; kind: ErrorKind; hint: string };

export type ErrorKind = "auth" | "loading" | "down" | "timeout" | "bad" | "locked";

export interface ApiError {
  kind: ErrorKind;
  hint: string;
}

export interface ThreadMeta {
  id: string;
  ts: number;
  title: string;
  turns: number;
}

export interface ThreadMessage {
  ts: number;
  role: string;
  text: string;
  partial?: boolean;
}

export interface Thread {
  id: string;
  messages: ThreadMessage[];
}

export interface TokenCheck {
  ok: boolean;
  name?: string;
  role?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) =>
  invoke<void>("set_settings", { settings });

export const hasToken = () => invoke<boolean>("has_token");
export const setToken = (token: string) => invoke<void>("set_token", { token });
export const clearToken = () => invoke<void>("clear_token");

export const probeBrain = (fresh = false) =>
  invoke<BrainInfo>("probe_brain", { fresh });
export const checkToken = () => invoke<TokenCheck>("check_token");

export function chatForge(
  text: string,
  thread: string | null,
  onEvent: (e: ChatEvent) => void,
): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("chat_forge", { text, thread, channel });
}

export function chatOpenai(
  messages: ChatMessage[],
  onEvent: (e: ChatEvent) => void,
): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("chat_openai", { messages, channel });
}

export const stopChat = () => invoke<void>("stop_chat");

export const listThreads = (n = 20) => invoke<ThreadMeta[]>("list_threads", { n });
export const getThread = (id: string) => invoke<Thread>("get_thread", { id });

export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === "object" && e !== null && "kind" in e && "hint" in e
  );
}
