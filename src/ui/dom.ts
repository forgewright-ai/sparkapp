// Element helpers shared by the views. createElement and textContent only.
import { isApiError } from "../api";

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error("missing #" + id);
  return e as T;
}

export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function clear<T extends HTMLElement>(node: T): T {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** the one line an error shows: an ApiError's hint verbatim, else its text */
export function hintOf(e: unknown): string {
  if (isApiError(e)) return e.hint;
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m || "the app core did not answer -- restart sparkchat";
}
