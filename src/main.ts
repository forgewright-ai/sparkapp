// Boot and view routing: setup (no url or no token), chat, settings.
// All server bytes flow through src/api.ts and the Rust core.
import { getSettings, hasToken, probeBrain } from "./api";
import { state, freshThread, modelName } from "./state";
import { $, hintOf } from "./ui/dom";
import {
  focusChat,
  initChat,
  newThreadVerb,
  renderTranscript,
  sysLine,
  updateStatus,
} from "./ui/chat";
import { initThreads, refreshThreads, threadsVisible } from "./ui/threads";
import { focusSetup, initSetup, setupHint, setupPrefill } from "./ui/setup";
import { initSettings, openSettings } from "./ui/settings";

type View = "setup" | "chat" | "settings";
const VIEWS: View[] = ["setup", "chat", "settings"];

function show(view: View): void {
  for (const v of VIEWS) $("view-" + v).hidden = v !== view;
  $("gear").hidden = view !== "chat";
}

function updateHeader(): void {
  const b = state.brain;
  $("site").textContent = b
    ? b.kind === "forge"
      ? ((b.name ?? "forge") + (b.version ? " v" + b.version : "") + "  " + modelName(b))
      : modelName(b) + " (raw)"
    : "";
}

function applyBrain(): void {
  updateHeader();
  threadsVisible(state.brain?.kind === "forge");
  void refreshThreads();
  updateStatus();
}

function enterChat(bootErr?: unknown): void {
  show("chat");
  applyBrain();
  if (bootErr !== undefined) sysLine(hintOf(bootErr));
  focusChat();
}

function enterSetup(): void {
  show("setup");
  focusSetup();
}

async function boot(): Promise<void> {
  initChat({ onTurnDone: () => void refreshThreads(), onBrain: applyBrain });
  initThreads({ onOpened: onThreadOpened, onNew: newThreadVerb });
  initSetup({ onConnected: () => enterChat() });
  initSettings({
    onChanged: applyBrain,
    onForgot: () => {
      freshThread(state);
      renderTranscript();
      enterSetup();
    },
    onBack: () => {
      show("chat");
      updateStatus();
      focusChat();
    },
  });
  $("gear").addEventListener("click", () => {
    show("settings");
    void openSettings();
  });

  let serverUrl = "";
  let token = false;
  try {
    const [s, t] = await Promise.all([getSettings(), hasToken()]);
    serverUrl = s.server_url ?? "";
    token = t;
  } catch (e) {
    enterSetup();
    setupHint(hintOf(e));
    return;
  }
  setupPrefill(serverUrl);
  if (!serverUrl || !token) {
    enterSetup();
    return;
  }
  try {
    state.brain = await probeBrain();
  } catch (e) {
    enterChat(e); // the hint lands in the transcript; send retries the probe
    return;
  }
  enterChat();
}

function onThreadOpened(): void {
  renderTranscript();
  updateStatus();
  focusChat();
}

void boot();
