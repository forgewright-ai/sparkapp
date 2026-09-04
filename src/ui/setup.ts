// First run: the server url and a token, then connect.
// Every failure shows the ApiError hint verbatim (lowercase, `--` remedy).
import { checkToken, probeBrain, setSettings, setToken } from "../api";
import { state } from "../state";
import { $, hintOf } from "./dom";

export interface SetupDeps {
  onConnected: () => void;
}

let deps: SetupDeps;

export function initSetup(d: SetupDeps): void {
  deps = d;
  $("setup-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void connect();
  });
}

export function setupPrefill(url: string): void {
  $<HTMLInputElement>("setup-url").value = url;
}

export function setupHint(text: string): void {
  $("setup-error").textContent = text;
}

export function focusSetup(): void {
  const url = $<HTMLInputElement>("setup-url");
  (url.value ? $<HTMLInputElement>("setup-token") : url).focus();
}

async function connect(): Promise<void> {
  const url = $<HTMLInputElement>("setup-url").value.trim();
  const token = $<HTMLInputElement>("setup-token").value.trim();
  const err = $("setup-error");
  if (!url || !token) {
    err.textContent = "both fields -- the url and a token from the box";
    return;
  }
  const btn = $<HTMLButtonElement>("setup-connect");
  btn.disabled = true;
  err.textContent = "connecting";
  try {
    await setSettings({ server_url: url });
    await setToken(token);
    state.brain = await probeBrain(true);
    const check = await checkToken();
    if (!check.ok) {
      err.textContent = "wrong token -- check it on the box (spark forge --print-url)";
      return;
    }
    $<HTMLInputElement>("setup-token").value = "";
    err.textContent = "";
    deps.onConnected();
  } catch (e) {
    err.textContent = hintOf(e);
  } finally {
    btn.disabled = false;
  }
}
