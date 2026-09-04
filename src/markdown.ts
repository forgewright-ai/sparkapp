// Dependency-free renderer for the little markdown a model answer carries:
// paragraphs, fenced ``` code blocks (verbatim, monospace, scrolls sideways),
// inline `code` spans. DOM via createElement/textContent only, never HTML
// strings. While streaming the row shows plain text; on done it is
// re-rendered through this (the FORGE page does the same).

export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];

  const flush = () => {
    if (!para.length) return;
    const p = document.createElement("p");
    inlineCode(p, para.join("\n"));
    frag.appendChild(p);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence (or the end: an unclosed fence still renders)
      const pre = document.createElement("pre");
      pre.className = "block";
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }
    if (line.trim() === "") {
      flush();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return frag;
}

/** text with `code` spans in backticks, nothing else rendered */
function inlineCode(node: HTMLElement, text: string): void {
  const parts = text.split("`");
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    if (i % 2) {
      const c = document.createElement("code");
      c.textContent = parts[i];
      node.appendChild(c);
    } else {
      node.appendChild(document.createTextNode(parts[i]));
    }
  }
}
