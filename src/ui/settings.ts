// The settings view: change url/token (with a re-probe), the brain health
// panel, forget token. Reached through the header's settings button.
import type { BrainInfo, TokenCheck } from "../api";
import {
  checkToken,
  clearToken,
  getSettings,
  probeBrain,
  setSettings,
  setToken,
} from "../api";
import { state } from "../state";
import { APP_VERSION } from "../version";
import { $, el, clear, hintOf } from "./dom";

export interface SettingsDeps {
  onChanged: () => void; // a successful re-probe: header, drawer, status
  onForgot: () => void; // the token is gone: back to setup
  onBack: () => void;
}

let deps: SettingsDeps;

export function initSettings(d: SettingsDeps): void {
  deps = d;
  $("settings-back").addEventListener("click", () => deps.onBack());
  $("settings-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void apply();
  });
  $("settings-forget").addEventListener("click", () => void forget());
  $("app-version").textContent = "sparkchat v" + APP_VERSION;
}

/** fill the fields and the health panel on the way in */
export async function openSettings(): Promise<void> {
  status("");
  try {
    const s = await getSettings();
    $<HTMLInputElement>("settings-url").value = s.server_url ?? "";
  } catch (e) {
    status(hintOf(e), true);
  }
  $<HTMLInputElement>("settings-token").value = "";
  renderBrain(state.brain, null);
  if (state.brain) {
    try {
      renderBrain(state.brain, await checkToken());
    } catch {
      // the panel already shows the brain; the token row stays unknown
    }
  }
}

async function apply(): Promise<void> {
  const url = $<HTMLInputElement>("settings-url").value.trim();
  const token = $<HTMLInputElement>("settings-token").value.trim();
  if (!url) {
    status("a server url first", true);
    return;
  }
  const btn = $<HTMLButtonElement>("settings-apply");
  btn.disabled = true;
  status("probing");
  try {
    await setSettings({ server_url: url });
    if (token) await setToken(token);
    state.brain = await probeBrain(true);
    let check: TokenCheck | null = null;
    try {
      check = await checkToken();
    } catch (e) {
      status(hintOf(e), true);
    }
    renderBrain(state.brain, check);
    if (check && !check.ok) status("wrong token -- check it on the box", true);
    else if (check) status("ok");
    $<HTMLInputElement>("settings-token").value = "";
    deps.onChanged();
  } catch (e) {
    status(hintOf(e), true);
    renderBrain(null, null);
  } finally {
    btn.disabled = false;
  }
}

async function forget(): Promise<void> {
  try {
    await clearToken();
  } catch (e) {
    status(hintOf(e), true);
    return;
  }
  status("");
  deps.onForgot();
}

function status(text: string, isErr = false): void {
  const p = $("settings-status");
  p.textContent = text;
  p.classList.toggle("err", isErr);
  p.classList.toggle("muted", !isErr);
}

/* ----------------------------------------------------------- health */
function renderBrain(brain: BrainInfo | null, check: TokenCheck | null): void {
  const dl = clear($("brain-facts"));
  const box = clear($("brain-models"));
  if (!brain) {
    dl.appendChild(el("dt", undefined, "brain"));
    dl.appendChild(el("dd", undefined, "none -- no server answered the probe"));
    return;
  }
  fact(dl, "kind", brain.kind);
  fact(dl, "url", brain.url);
  if (brain.name) fact(dl, "name", brain.name);
  if (brain.version) fact(dl, "version", brain.version);
  fact(dl, "model", brain.model);
  if (brain.upstream) fact(dl, "upstream", brain.upstream);
  if (check) fact(dl, "token", check.ok ? "ok" + who(check) : "refused");

  if (brain.roles && Object.keys(brain.roles).length) {
    box.appendChild(rolesTable(brain));
  } else if (brain.model_list && brain.model_list.length) {
    box.appendChild(modelListTable(brain.model_list));
  }
}

function who(check: TokenCheck): string {
  const bits = [check.name, check.role].filter((x): x is string => !!x);
  return bits.length ? " (" + bits.join(", ") + ")" : "";
}

function fact(dl: HTMLElement, k: string, v: string | undefined): void {
  dl.appendChild(el("dt", undefined, k));
  dl.appendChild(el("dd", undefined, v || "-"));
}

function rolesTable(brain: BrainInfo): HTMLElement {
  const wrap = el("div", "tbl");
  const tb = document.createElement("table");
  tb.appendChild(headRow(["role", "model", "state"]));
  for (const [role, stem] of Object.entries(brain.roles ?? {})) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", undefined, role));
    tr.appendChild(el("td", undefined, stem));
    tr.appendChild(el("td", undefined, brain.models?.[role] ?? "-"));
    tb.appendChild(tr);
  }
  wrap.appendChild(tb);
  return wrap;
}

function modelListTable(list: NonNullable<BrainInfo["model_list"]>): HTMLElement {
  const wrap = el("div", "tbl");
  const tb = document.createElement("table");
  tb.appendChild(headRow(["alias", "stem", "loaded"]));
  for (const m of list) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", undefined, m.alias));
    tr.appendChild(el("td", undefined, m.stem));
    tr.appendChild(el("td", undefined, m.loaded ? "yes" : "-"));
    tb.appendChild(tr);
  }
  wrap.appendChild(tb);
  return wrap;
}

function headRow(cols: string[]): HTMLElement {
  const tr = document.createElement("tr");
  for (const c of cols) tr.appendChild(el("th", undefined, c));
  return tr;
}
