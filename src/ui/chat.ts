// The chat view: transcript, input, status line, stop, slash verbs.
// Mirrors spark's terminal chat: the answer mark is `*`, a cancelled answer
// keeps its partial text under `* (stopped)`, /help /new /last /model /q.
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChatEvent } from "../api";
import { chatForge, chatOpenai, listThreads, probeBrain, stopChat } from "../api";
import type { Entry } from "../state";
import {
  state,
  busy,
  beginTurn,
  onQueued,
  onDelta,
  onDone,
  onStopped,
  onError,
  freshThread,
  modelName,
  brainLine,
  statsLine,
} from "../state";
import { renderMarkdown } from "../markdown";
import { $, el, clear, hintOf } from "./dom";

export interface ChatDeps {
  onTurnDone: () => void; // a turn finished: refresh the thread list
  onBrain: () => void; // the brain (re)appeared mid-chat: header, drawer
}

const HELP = [
  "/help   this list",
  "/new    a fresh thread",
  "/last   the last turn, with its tok/s",
  "/model  which model is answering",
  "/q      close the window",
].join("\n");

const QUIT_WORDS = ["/q", "/quit", "/exit"];

let deps: ChatDeps;
let cur: { entry: Entry; over: boolean } | null = null;
let liveTxt: HTMLElement | null = null;
let liveMark: HTMLElement | null = null;

export function initChat(d: ChatDeps): void {
  deps = d;
  const ta = $<HTMLTextAreaElement>("chat-text");
  $("chat-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send();
  });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  });
  ta.addEventListener("input", autosize);
  $("chat-stop").addEventListener("click", () => void stop());
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || $("view-chat").hidden) return;
    if (busy(state)) {
      ev.preventDefault();
      void stop();
      return;
    }
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) t.blur();
  });
}

export function focusChat(): void {
  $<HTMLTextAreaElement>("chat-text").focus();
}

/* ----------------------------------------------------------- transcript */
function row(entry: Entry): HTMLElement {
  if (entry.role === "user") return el("div", "msg user", entry.text);
  if (entry.role === "system") return el("div", "msg system", entry.text);
  const d = el("div", "msg assistant" + (entry.error ? " err-row" : ""));
  d.appendChild(el("span", "mk", entry.partial ? "* (stopped)" : "*"));
  const txt = el("div", "txt");
  if (entry.partial || entry.error) txt.textContent = entry.text;
  else txt.appendChild(renderMarkdown(entry.text));
  d.appendChild(txt);
  return d;
}

export function renderTranscript(): void {
  const tr = clear($("transcript"));
  for (const e of state.transcript) tr.appendChild(row(e));
  tr.scrollTop = tr.scrollHeight;
  liveTxt = null;
  liveMark = null;
}

function appendRow(entry: Entry): HTMLElement {
  const tr = $("transcript");
  const d = row(entry);
  tr.appendChild(d);
  tr.scrollTop = tr.scrollHeight;
  return d;
}

/** one lowercase system line in the transcript (slash output, boot hints) */
export function sysLine(text: string): void {
  const entry: Entry = { role: "system", text };
  state.transcript.push(entry);
  appendRow(entry);
}

/* ----------------------------------------------------------- status */
export function updateStatus(): void {
  const p = $("chat-status");
  p.classList.remove("err");
  let text = "";
  switch (state.phase) {
    case "idle": {
      const b = state.brain;
      text = b
        ? b.kind === "forge"
          ? ((b.name ?? "forge") + (b.version ? " v" + b.version : "") + "  " + modelName(b))
          : modelName(b) + " (raw)"
        : "no brain -- open settings";
      break;
    }
    case "sending":
      text = "sending";
      break;
    case "queued":
      text = "queued";
      break;
    case "streaming":
      text = "answering";
      break;
    case "done":
      text = statsLine(state);
      break;
    case "stopped":
      text = "stopped -- the partial answer is kept";
      break;
    case "error":
      text = state.lastError ?? "error";
      p.classList.add("err");
      break;
  }
  p.textContent = text;
  $("chat-stop").hidden = !busy(state);
}

/* ----------------------------------------------------------- input */
function autosize(): void {
  const ta = $<HTMLTextAreaElement>("chat-text");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight + 2, 168) + "px";
}

/* ----------------------------------------------------------- send */
async function send(): Promise<void> {
  const ta = $<HTMLTextAreaElement>("chat-text");
  const text = ta.value.trim();
  if (!text || busy(state)) return;
  ta.value = "";
  autosize();
  if (text.startsWith("/")) {
    slash(text);
    return;
  }
  if (!state.brain) {
    try {
      state.brain = await probeBrain();
      deps.onBrain();
    } catch (e) {
      sysLine(hintOf(e));
      updateStatus();
      return;
    }
  }
  const entry = beginTurn(state, text);
  appendRow(state.transcript[state.transcript.length - 2]); // the user row
  const d = appendRow(entry);
  liveMark = d.querySelector(".mk");
  liveTxt = d.querySelector(".txt");
  const turn = { entry, over: false };
  cur = turn;
  updateStatus();

  const handle = (e: ChatEvent) => {
    if (cur !== turn) return;
    if (e.type === "queued" && !turn.over) {
      onQueued(state);
      updateStatus();
    } else if (e.type === "delta" && !turn.over) {
      onDelta(state, entry, e.t);
      if (liveTxt) liveTxt.textContent = entry.text;
      const tr = $("transcript");
      tr.scrollTop = tr.scrollHeight;
      if (state.deltas === 1) updateStatus();
    } else if (e.type === "done") {
      if (turn.over) {
        // stopped locally; a late done still names the thread
        if (state.brain?.kind === "forge" && e.thread) state.thread = e.thread;
        return;
      }
      turn.over = true;
      onDone(state, entry, e);
      if (liveMark) liveMark.textContent = "*";
      if (liveTxt) {
        clear(liveTxt);
        liveTxt.appendChild(renderMarkdown(entry.text));
      }
      updateStatus();
      deps.onTurnDone();
    } else if (e.type === "error" && !turn.over) {
      turn.over = true;
      onError(state, entry, e.hint);
      failRow(entry);
      updateStatus();
    }
  };

  try {
    if (state.brain.kind === "forge") await chatForge(text, state.thread, handle);
    else await chatOpenai(state.raw.slice(), handle); // beginTurn already appended the user turn
  } catch (e) {
    if (cur === turn && !turn.over) {
      turn.over = true;
      onError(state, entry, hintOf(e));
      failRow(entry);
      updateStatus();
    }
  } finally {
    if (cur === turn && !turn.over) {
      // the channel closed without done or error -- but a late done may
      // still be in flight (channel vs invoke ordering isn't promised),
      // so give it a beat before keeping what streamed
      await new Promise((r) => setTimeout(r, 80));
      if (cur === turn && !turn.over) {
        turn.over = true;
        onStopped(state, entry);
        if (liveMark) liveMark.textContent = "* (stopped)";
        updateStatus();
      }
    }
    ta.focus();
  }
}

function failRow(entry: Entry): void {
  if (entry.error) {
    // nothing streamed: the row is the hint
    if (liveTxt) liveTxt.textContent = entry.text;
    if (liveTxt) liveTxt.closest(".msg")?.classList.add("err-row");
  } else if (liveMark) {
    // a half-streamed answer keeps its text under the stopped mark;
    // the hint lives on the status line
    liveMark.textContent = "* (stopped)";
  }
}

/* ----------------------------------------------------------- stop */
async function stop(): Promise<void> {
  const turn = cur;
  if (!turn || turn.over || !busy(state)) return;
  try {
    await stopChat();
  } catch {
    // the core did not answer; finalize locally all the same
  }
  if (turn.over || cur !== turn) return;
  turn.over = true;
  onStopped(state, turn.entry);
  if (liveMark) liveMark.textContent = "* (stopped)";
  updateStatus();
  // stopping the first turn of a new forge thread cancels the read before
  // done names the thread -- but the server created it; adopt the newest
  if (state.brain?.kind === "forge" && state.thread === null) {
    try {
      const ts = await listThreads(1);
      if (ts[0]) state.thread = ts[0].id;
    } catch {
      // the drawer refresh below will try again
    }
  }
  deps.onTurnDone();
}

/* ----------------------------------------------------------- slash */
function slash(text: string): void {
  const verb = text.split(/\s+/)[0];
  if (QUIT_WORDS.includes(verb)) {
    void getCurrentWindow().close();
    return;
  }
  if (verb === "/help") sysLine(HELP);
  else if (verb === "/new") {
    freshThread(state);
    renderTranscript();
    sysLine("*: a fresh thread");
    updateStatus();
    deps.onTurnDone();
  } else if (verb === "/last") sysLine(statsLine(state));
  else if (verb === "/model") sysLine(brainLine(state.brain));
  else sysLine("no " + verb + " -- /help lists them");
}

/** the `new` button in the drawer routes through the same verb */
export function newThreadVerb(): void {
  if (busy(state)) return;
  slash("/new");
  focusChat();
}
