// The left drawer: forge threads. Hidden entirely on a raw brain.
import { getThread, listThreads } from "../api";
import { state, busy, loadThread } from "../state";
import { $, el, clear, hintOf } from "./dom";

export interface ThreadsDeps {
  onOpened: () => void; // a thread's messages replaced the transcript
  onNew: () => void; // the `new` button = /new
}

let deps: ThreadsDeps;

export function initThreads(d: ThreadsDeps): void {
  deps = d;
  $("thread-new").addEventListener("click", () => {
    collapseDrawer();
    deps.onNew();
  });
  $("threads-toggle").addEventListener("click", () => {
    const on = $("view-chat").classList.toggle("drawer");
    $("threads-toggle").setAttribute("aria-expanded", on ? "true" : "false");
  });
}

/** the drawer exists only in front of a forge */
export function threadsVisible(show: boolean): void {
  $("threads").hidden = !show;
  $("threads-toggle").hidden = !show;
  $("view-chat").classList.toggle("solo", !show);
  if (!show) collapseDrawer();
}

export async function refreshThreads(): Promise<void> {
  if (state.brain?.kind !== "forge") return;
  let ul: HTMLElement;
  try {
    const threads = await listThreads(20);
    ul = clear($("thread-list"));
    for (const t of threads) {
      const li = el("li");
      const b = el("button", "pick", t.title || t.id) as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("data-id", t.id);
      b.setAttribute("aria-current", t.id === state.thread ? "true" : "false");
      b.addEventListener("click", () => void open(t.id));
      li.appendChild(b);
      li.appendChild(el("span", "meta", "· " + (t.turns || 0)));
      ul.appendChild(li);
    }
    if (!threads.length) ul.appendChild(el("li", "muted", "no threads yet"));
  } catch (e) {
    ul = clear($("thread-list"));
    ul.appendChild(el("li", "muted", hintOf(e)));
  }
}

async function open(id: string): Promise<void> {
  if (busy(state)) return; // one turn at a time
  try {
    const t = await getThread(id);
    loadThread(state, t.id, t.messages);
    collapseDrawer();
    markCurrent(t.id);
    deps.onOpened();
  } catch (e) {
    const ul = clear($("thread-list"));
    ul.appendChild(el("li", "muted", hintOf(e)));
  }
}

function markCurrent(id: string | null): void {
  document.querySelectorAll("#thread-list .pick").forEach((b) => {
    b.setAttribute("aria-current", b.getAttribute("data-id") === id ? "true" : "false");
  });
}

function collapseDrawer(): void {
  $("view-chat").classList.remove("drawer");
  $("threads-toggle").setAttribute("aria-expanded", "false");
}
