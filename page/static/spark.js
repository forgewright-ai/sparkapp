/* spark FORGE page. Vanilla ES2017, no build, no external resource, ASCII
   only (Unicode via \u escapes). Modules by convention, top to bottom:
     dom     - element helpers (textContent only, never innerHTML)
     host    - which shell carries us: a browser (fetch) or the sparkchat
               desktop app (window.__TAURI__ invoke + Channel); picked once
     api     - get/post/del/stream with one shape on both hosts; 401 -> login
     offline - the desktop cache: a reply carrying _cached_at is stale
     theme   - palette -> CSS custom properties; browser-only override
     auth    - the login card (web: cookie; desktop: server url + token)
     me      - GET /api/me: the role behind the cookie; .adm/.usr rendering
     events  - GET /api/events (EventSource or forge_events) -> header bar
     run     - POST /api/run: one verb's output streamed into #output
     monitor, chat, doView, config, help - the five views
     route   - hash routes and the keyboard map
   Contract: the route table in CLAUDE.md contract 9. Any 404 on a route
   that lands in a later step shows "not available yet" in place.
   Desktop commands (sparkchat proxy.rs): forge_get/forge_post/forge_delete
   {path[,body]}, forge_sse {path,body,channel} -> id, forge_events
   {channel} -> id, stop_stream {id}, chat_openai {messages,channel} -> id,
   set_settings {settings:{server_url}}, set_token {token}, clear_token,
   quit. Proxy channels carry {event, data} pairs (data JSON-parsed here,
   like the browser stream); chat_openai's channel carries ChatEvent
   objects tagged {type, ...} -- host.sse reads both shapes. */
(function () {
  "use strict";

  /* ----------------------------------------------------------- dom */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function fact(dl, k, v) {
    dl.appendChild(el("dt", null, k));
    dl.appendChild(el("dd", null, v === undefined || v === null || v === "" ? "-" : v));
  }
  function fmtTs(ts) {
    if (typeof ts === "number") {
      var d = new Date(ts * 1000);
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    return ts ? String(ts) : "-";
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function num(x, d) { return typeof x === "number" ? x.toFixed(d === undefined ? 1 : d) : "-"; }
  function keyOf(s) {
    if (!s) return "-";
    if (typeof s === "string") return s;
    return "ngl=" + s.ngl + " fa=" + s.fa + " kv=" + s.kv + " t=" + (s.t || "auto");
  }
  /* text with `code` spans in backticks, nothing else rendered */
  function codeSpans(node, text) {
    var parts = String(text).split("`");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      node.appendChild(i % 2 ? el("code", null, parts[i]) : document.createTextNode(parts[i]));
    }
    return node;
  }
  /* fenced block: pre.fence with a copy button; textContent only */
  function fenceBlock(code) {
    var pre = el("pre", "fence"), b = el("button", "quiet copy", "copy");
    b.type = "button";
    b.addEventListener("click", function () {
      function done() { b.textContent = "copied"; setTimeout(function () { b.textContent = "copy"; }, 1500); }
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(code).then(done, done); return; }
      var ta = document.createElement("textarea");   /* LAN http: no async clipboard */
      ta.value = code; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.left = "-999px";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (x) { /* nothing to do */ }
      document.body.removeChild(ta); done();
    });
    pre.appendChild(b);
    pre.appendChild(el("code", null, code));
    return pre;
  }
  /* prose + ``` fences; the split is on lines, textContent everywhere */
  function rich(node, text) {
    var lines = String(text).split("\n"), buf = [], fence = false, i;
    function flush() { if (buf.length) codeSpans(node, buf.join("\n")); buf = []; }
    for (i = 0; i < lines.length; i++) {
      if (lines[i].slice(0, 3) === "```") {
        if (fence) { node.appendChild(fenceBlock(buf.join("\n"))); buf = []; }
        else flush();
        fence = !fence;
        continue;
      }
      buf.push(lines[i]);
    }
    if (fence) node.appendChild(fenceBlock(buf.join("\n")));   /* unclosed fence still renders */
    else flush();
    return node;
  }
  function notYet(node, what) {
    clear(node).appendChild(el("p", "muted", (what || "this") + " is not available yet on this FORGE"));
  }
  function fail(node, e) {
    clear(node).appendChild(el("p", e && e.quiet ? "muted" : "err", String(e && e.message || e)));
  }

  /* ----------------------------------------------------------- host */
  var host = {
    tauri: !!(window.__TAURI__ && window.__TAURI__.core),
    raw: false,   /* desktop only: the upstream is a bare llama-server */
    invoke: function (cmd, args) { return window.__TAURI__.core.invoke(cmd, args || {}); },
    /* normalize a core rejection into the Error shape api.check throws */
    err: function (e) {
      if (e instanceof Error && e.status !== undefined) return e;
      var kind = e && e.kind, m = (e && (e.hint || e.message)) || (typeof e === "string" ? e : "the call failed");
      var s = e && typeof e.status === "number" ? e.status : 0;
      if (!s) {
        if (kind === "auth" || /\b401\b/.test(m)) s = 401;
        else if (kind === "role" || /\b403\b/.test(m)) s = 403;
        else if (/\b404\b/.test(m) || /not found/i.test(m)) s = 404;
      }
      var err = new Error(m);
      if (s) err.status = s;
      if (s === 401) auth.lost();
      if (s === 403 && kind === "role") { err.quiet = true; err.message = "this needs the admin token"; }
      return err;
    },
    /* one streamed command; the channel carries either {event, data}
       pairs (the proxy commands) or ChatEvent objects tagged {type, ...}
       (chat_openai) -- done ends it; error ends it too, unless the
       error handler returns true (a long-lived feed like forge_events
       stays subscribed while the core reconnects). ctl.abort()
       cancels via stop_stream. */
    sse: function (cmd, args, on, ctl) {
      return new Promise(function (resolve, reject) {
        var ch = new window.__TAURI__.core.Channel(), ended = false;
        function end() { if (!ended) { ended = true; resolve(); } }
        function fail(e) { if (!ended) { ended = true; reject(e); } }
        ch.onmessage = function (msg) {
          if (ended) return;   /* a message already in flight when stop hit */
          var ev, d;
          if (msg && msg.type) { ev = msg.type; d = msg; }   /* a tagged ChatEvent: the fields ride inline */
          else { ev = (msg && msg.event) || "message"; d = msg ? msg.data : null; }
          if (typeof d === "string") { try { d = JSON.parse(d); } catch (x) { /* plain text stays text */ } }
          /* 401 anywhere returns to login: a stream's auth/locked error
             pair too, not only the plain calls (api.check does this on
             the web host) */
          if (ev === "error" && d && (d.kind === "auth" || d.kind === "locked")) auth.lost();
          /* a pre-stream 404 arrives as an error pair too (the core
             cannot reject after the invoke resolved), carrying the
             "http 404" marker http.rs builds into every 404 hint --
             reject with it, like api.check throws on the web host, so
             the callers' e.status === 404 fallbacks ("not available
             yet on this FORGE") fire on both hosts. in-stream FORGE
             errors (kind auth/loading/down/bad) keep flowing to
             on.error below */
          if (ev === "error" && d && typeof d.hint === "string" && /\bhttp 404\b/.test(d.hint)) { fail(host.err(d)); return; }
          var kept = on[ev] ? on[ev](d) : undefined;
          if (ev === "done" || (ev === "error" && kept !== true)) end();
        };
        args = args || {};
        args.channel = ch;
        host.invoke(cmd, args).then(function (id) {
          if (ctl) ctl.abort = function () { host.invoke("stop_stream", { id: id }).catch(function () { /* already over */ }); end(); };
        }, function (e) { fail(host.err(e)); });
      });
    },
    /* which upstream: a FORGE, or a raw model server (chat only) */
    detect: function () {
      return api.get("/api/health").then(function (h) {
        host.raw = !(h && h.forge);
        return h;
      }).catch(function (e) {
        if (e && e.status === 401) throw e;
        return api.get("/v1/models").then(function () { host.raw = true; return null; });
      });
    }
  };

  /* ----------------------------------------------------------- api */
  var api = {
    headers: { "X-Spark": "1", "Content-Type": "application/json" },
    check: function (r) {
      if (r.status === 401) { auth.lost(); throw new Error("login needed"); }
      if (r.status === 403) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var role = j && j.error && j.error.kind === "role";
          var e = new Error(role ? "this needs the admin token" : "HTTP 403");
          e.status = 403; e.quiet = role;
          throw e;
        });
      }
      if (r.status === 404) { var e = new Error("not available yet"); e.status = 404; throw e; }
      if (!r.ok) { var f = new Error("HTTP " + r.status); f.status = r.status; throw f; }
      return r;
    },
    get: function (path) {
      if (host.tauri) return host.invoke("forge_get", { path: path }).then(offline.seen, function (e) { throw host.err(e); });
      return fetch(path, { credentials: "same-origin" }).then(api.check).then(function (r) { return r.json(); });
    },
    post: function (path, body) {
      if (host.tauri) return host.invoke("forge_post", { path: path, body: body || {} }).catch(function (e) { throw host.err(e); });
      return fetch(path, { method: "POST", headers: api.headers, body: JSON.stringify(body || {}), credentials: "same-origin" })
        .then(api.check).then(function (r) { return r.status === 204 ? null : r.json(); });
    },
    del: function (path) {
      if (host.tauri) return host.invoke("forge_delete", { path: path }).catch(function (e) { throw host.err(e); });
      return fetch(path, { method: "DELETE", headers: api.headers, credentials: "same-origin" })
        .then(api.check).then(function (r) { return r.status === 204 ? null : r.json(); });
    },
    /* POST that answers with text/event-stream; on = {event: fn(data)}.
       ctl, when given, gains .abort(); an abort resolves quietly. */
    stream: function (path, body, on, ctl) {
      if (host.tauri) return host.sse("forge_sse", { path: path, body: body || {} }, on, ctl);
      var c = typeof AbortController === "function" ? new AbortController() : null;
      if (ctl && c) ctl.abort = function () { c.abort(); };
      return fetch(path, { method: "POST", headers: api.headers, body: JSON.stringify(body || {}), credentials: "same-origin", signal: c ? c.signal : undefined })
        .then(api.check).then(function (r) {
          var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
          function block(b) {
            var ev = "message", data = [];
            b.split("\n").forEach(function (l) {
              if (l.indexOf("event:") === 0) ev = l.slice(6).trim();
              else if (l.indexOf("data:") === 0) data.push(l.slice(5).replace(/^ /, ""));
            });
            if (!data.length) return;
            var d = data.join("\n");
            try { d = JSON.parse(d); } catch (x) { /* plain text stays text */ }
            if (on[ev]) on[ev](d);
          }
          function pump() {
            return reader.read().then(function (x) {
              if (x.done) { if (buf.trim()) block(buf); return; }
              buf += dec.decode(x.value, { stream: true }).replace(/\r/g, "");
              var parts = buf.split("\n\n");
              buf = parts.pop();
              parts.forEach(block);
              return pump();
            });
          }
          return pump();
        })
        .catch(function (e) { if (e && e.name === "AbortError") return; throw e; });
    }
  };

  /* ----------------------------------------------------------- offline */
  var offline = {
    at: 0,   /* _cached_at epoch of the last stale reply, 0 = live */
    tick: 0,   /* the age refresher, running only while offline */
    seen: function (j) {
      if (j && typeof j === "object" && j._cached_at) offline.set(j._cached_at);
      else if (j && typeof j === "object") offline.clear();
      return j;
    },
    set: function (ts) {
      offline.at = ts;
      document.body.classList.add("offline");
      var b = $("chat-send"); if (b) b.disabled = true;
      offline.status();
      if (!offline.tick) offline.tick = setInterval(offline.status, 1000);
    },
    clear: function () {
      if (!offline.at) return;
      offline.at = 0;
      if (offline.tick) { clearInterval(offline.tick); offline.tick = 0; }
      document.body.classList.remove("offline");
      var b = $("chat-send"); if (b) b.disabled = false;
      if (!chat.busy) chat.status(chat.thread ? "thread " + chat.thread : "new thread");
    },
    age: function () {
      var s = Math.max(0, Math.round(Date.now() / 1000 - offline.at));
      if (s < 60) return s + " s";
      if (s < 3600) return Math.round(s / 60) + " m";
      if (s < 86400) return Math.round(s / 3600) + " h";
      return Math.round(s / 86400) + " d";
    },
    status: function () { if (offline.at && !chat.busy) chat.status("offline -- showing " + offline.age()); }
  };

  /* ----------------------------------------------------------- theme */
  var theme = {
    KEY: "spark.palette",
    /* copied from themes/*.env: bg fg accent muted, then ansi 0..15 */
    builtin: {
      "catppuccin-mocha": ["#1e1e2e", "#cdd6f4", "#cba6f7", "#6c7086", "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"],
      "gruvbox-dark": ["#282828", "#ebdbb2", "#fe8019", "#928374", "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
      "selenized-dark": ["#103c48", "#adbcbc", "#4695f7", "#72898f", "#184956", "#fa5750", "#75b938", "#dbb32d", "#4695f7", "#f275be", "#41c7b9", "#72898f", "#2d5b69", "#ff665c", "#84c747", "#ebc13d", "#58a3ff", "#ff84cd", "#53d6c7", "#cad8d9"],
      "solarized-light": ["#fdf6e3", "#657b83", "#268bd2", "#93a1a1", "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]
    },
    machine: null,      /* {name, palette} from /api/theme, or null = ember */
    names: [],
    fromEnv: function (p) {   /* THEME_* dict -> the flat array above */
      var a = [p.THEME_BG, p.THEME_FG, p.THEME_ACCENT, p.THEME_MUTED];
      for (var i = 0; i < 16; i++) a.push(p["THEME_ANSI_" + i]);
      return a;
    },
    hex: function (h) { return [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16); }); },
    mix: function (a, b, w) {   /* w = the share of a */
      var A = theme.hex(a), B = theme.hex(b);
      return "#" + [0, 1, 2].map(function (i) { return pad2(Math.round(A[i] * w + B[i] * (1 - w))); }).join("");
      function pad2(n) { return (n < 16 ? "0" : "") + n.toString(16); }
    },
    set: function (a) {   /* apply a flat array, or null to fall back to CSS */
      var st = document.documentElement.style, k;
      var names = ["--bg", "--fg", "--accent", "--muted"];
      for (k = 0; k < 16; k++) names.push("--ansi-" + k);
      names.push("--muted-text", "--line", "--tint");
      if (!a || a.length < 20 || a.some(function (c) { return !/^#[0-9a-fA-F]{6}$/.test(c || ""); })) {
        names.forEach(function (n) { st.removeProperty(n); });
        return;
      }
      for (k = 0; k < 20; k++) st.setProperty(names[k], a[k]);
      st.setProperty("--muted-text", theme.mix(a[1], a[0], 0.72));   /* readable, unlike THEME_MUTED */
      st.setProperty("--line", theme.mix(a[3], a[0], 0.4));
      st.setProperty("--tint", theme.mix(a[1], a[0], 0.05));
    },
    override: function () { try { return localStorage.getItem(theme.KEY) || ""; } catch (e) { return ""; } },
    apply: function () {
      var want = theme.override();
      if (want && theme.builtin[want]) return theme.set(theme.builtin[want]);
      if (want && theme.machine && theme.machine.name === want) return theme.set(theme.fromEnv(theme.machine.palette));
      if (theme.machine && theme.machine.palette) return theme.set(theme.fromEnv(theme.machine.palette));
      theme.set(null);
    },
    menu: function () {
      var cur = theme.override();
      var all = Object.keys(theme.builtin);
      theme.names.forEach(function (n) { if (all.indexOf(n) < 0) all.push(n); });
      all.sort();
      ["palette", "palette2"].forEach(function (id) {
        var sel = clear($(id));
        var o = el("option", null, "follow the machine"); o.value = "";
        sel.appendChild(o);
        all.forEach(function (n) {
          var op = el("option", null, n); op.value = n;
          if (!theme.builtin[n] && !(theme.machine && theme.machine.name === n)) op.disabled = true;
          sel.appendChild(op);
        });
        sel.value = cur;
      });
    },
    load: function () {
      return api.get("/api/theme").then(function (t) {
        theme.machine = t.palette ? { name: t.name, palette: t.palette } : null;
        theme.names = t.palettes || [];
        try { localStorage.setItem("spark.machine", JSON.stringify(theme.machine)); } catch (e) { /* fine */ }
        theme.menu(); theme.apply();
      }).catch(function () { /* before login: keep what we have */ });
    },
    init: function () {
      try { theme.machine = JSON.parse(localStorage.getItem("spark.machine") || "null"); } catch (e) { theme.machine = null; }
      theme.menu(); theme.apply();
      ["palette", "palette2"].forEach(function (id) {
        $(id).addEventListener("change", function () {
          try { if (this.value) localStorage.setItem(theme.KEY, this.value); else localStorage.removeItem(theme.KEY); } catch (e) { /* fine */ }
          theme.menu(); theme.apply();
        });
      });
    }
  };

  /* ----------------------------------------------------------- me */
  var me = {
    role: "admin", name: "",
    load: function () {
      return api.get("/api/me").then(function (m) {
        me.role = m.role === "user" ? "user" : "admin";
        me.name = m.name || "";
      }).catch(function () { me.role = "admin"; });   /* older FORGE: one token, one role */
    },
    apply: function () {
      var admin = me.role === "admin";
      $("role").textContent = me.role;
      $("role").hidden = host.raw;
      $("token-role").textContent = "you are " + me.role;
      document.querySelectorAll(".adm").forEach(function (n) { n.hidden = !admin; });
      document.querySelectorAll(".usr").forEach(function (n) { n.hidden = admin; });
      document.querySelector(".tabs a[data-view=do]").hidden = !admin;
    }
  };

  /* ----------------------------------------------------------- auth */
  var auth = {
    ok: false,
    lost: function () {
      if (!auth.ok && !$("login").hidden) return;
      auth.ok = false;
      events.stop();
      document.querySelectorAll(".view").forEach(function (v) { v.hidden = true; });
      $("logout").hidden = true;
      $("role").hidden = true;
      $("login").hidden = false;
      $("token").focus();
    },
    gained: function () {
      auth.ok = true;
      $("login").hidden = true;
      $("login-error").textContent = "";
      $("token").value = "";
      $("logout").hidden = false;
      document.body.classList.toggle("mode-raw", host.raw);
      if (host.raw) {   /* a bare model server: chat only */
        me.role = "user";
        me.apply();
        $("site").textContent = "raw model server";
        route.go("chat");
        route.show("chat", true);
        return;
      }
      me.load().then(function () {
        me.apply();
        theme.load();
        events.start();
        route.show(route.current(), true);
      });
    },
    setup: function () {   /* desktop: server url + token -> keychain */
      var url = $("server-url").value.trim(), tok = $("token").value;
      if (!url || !tok) { $("login-error").textContent = "server url and token are both needed -- spark forge --print-url shows them"; return; }
      $("login-error").textContent = "";
      host.invoke("set_settings", { settings: { server_url: url } })
        .then(function () { return host.invoke("set_token", { token: tok }); })
        .then(function () { return host.detect(); })
        .then(function () {
          /* /api/health answers without a token: prove the token itself
             on /api/me (raw mode has no /api/me; detect's probe stands) */
          if (host.raw) return null;
          return api.get("/api/me");
        })
        .then(auth.gained)
        .catch(function (e) {
          var err = host.err(e);
          $("login-error").textContent = err.status === 401
            ? "wrong token -- spark forge --print-url shows it"
            : "no answer from " + url + " -- " + err.message;
        });
    },
    init: function () {
      $("login-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        if (host.tauri) return auth.setup();
        var tok = $("token").value;
        if (!tok) return;
        $("login-error").textContent = "";
        fetch("/api/login", { method: "POST", headers: api.headers, body: JSON.stringify({ token: tok }), credentials: "same-origin" })
          .then(function (r) {
            if (r.status === 204 || r.ok) return auth.gained();
            $("login-error").textContent = r.status === 401 ? "wrong token -- spark forge --print-url shows it"
              : r.status === 429 ? "too many tries -- wait a minute" : "HTTP " + r.status;
          }).catch(function (e) { $("login-error").textContent = String(e.message || e); });
      });
      $("logout").addEventListener("click", function () {
        if (host.tauri) { host.invoke("clear_token").catch(function () { /* gone either way */ }).then(auth.lost); return; }
        api.post("/api/logout").catch(function () { /* the cookie is gone either way */ }).then(auth.lost);
      });
    }
  };

  /* ----------------------------------------------------------- events */
  var events = {
    src: null,
    handle: function (ev, d) {
      offline.clear();   /* a live pair proves the box is back */
      if (ev === "bar") $("bar").textContent = (d && d.line) || "";
      else if (ev === "check") {
        try { monitor.tally(d); } catch (x) { return; }
        if (route.current() === "monitor") monitor.loadCheck();
      } else if (ev === "serve") monitor.serveLive(d || {});
    },
    start: function () {
      events.stop();
      if (host.tauri) {
        if (host.raw) return;
        var ctl = {};
        var sub = { close: function () { if (ctl.abort) ctl.abort(); } };
        /* the core owns the reconnect (proxy.rs backs off and retries;
           no done pair ever arrives): an error pair is a blip to sit
           through, except auth/locked, which is fatal there too and
           sends us to login. the promise settles only on cancel,
           replacement or an invoke failure -- resubscribe after a
           pause only then, and only while the login stands */
        var again = function () {
          if (events.src !== sub) return;
          events.src = null;
          setTimeout(function () {
            if (auth.ok && !host.raw && !events.src) events.start();
          }, 5000);
        };
        host.sse("forge_events", {}, {
          bar: function (d) { events.handle("bar", d); },
          check: function (d) { events.handle("check", d); },
          serve: function (d) { events.handle("serve", d); },
          error: function (d) {
            var kind = d && d.kind;
            if (kind === "auth" || kind === "locked") { auth.lost(); return; }
            return true;   /* the core retries; stay on this subscription */
          }
        }, ctl).then(again, again);
        events.src = sub;
        return;
      }
      var s = new EventSource("/api/events");
      ["bar", "check", "serve"].forEach(function (ev) {
        s.addEventListener(ev, function (e) {
          var d; try { d = JSON.parse(e.data); } catch (x) { return; }
          events.handle(ev, d);
        });
      });
      s.onerror = function () { if (s.readyState === 2) events.src = null; };
      events.src = s;
    },
    stop: function () { if (events.src) { events.src.close(); events.src = null; } }
  };

  /* ----------------------------------------------------------- run */
  var run = {
    busy: false, ctl: null, stopping: false,
    /* Esc while a verb streams: abort settles the stream quietly on
       both hosts, so busy can never stick on a dead connection */
    stop: function () {
      if (!run.busy || !run.ctl || !run.ctl.abort) return;
      run.stopping = true;
      run.ctl.abort();
    },
    go: function (verb, args) {
      if (run.busy) return Promise.resolve();
      run.busy = true; run.stopping = false;
      var out = $("output");
      $("output-title").textContent = "output: spark " + [verb].concat(args || []).join(" ");
      out.textContent = "";
      out.scrollIntoView({ block: "nearest" });
      /* append, never replace: #output is aria-live, and a rewrite
         makes AT re-announce the whole log on every line */
      function line(s) { out.appendChild(document.createTextNode(s + "\n")); out.scrollTop = out.scrollHeight; }
      run.ctl = {};
      return api.stream("/api/run", { verb: verb, args: args || [] }, {
        line: function (d) { line(typeof d === "string" ? d : (d.s === undefined ? JSON.stringify(d) : d.s)); },
        done: function (d) { line("[exit " + (d && d.rc !== undefined ? d.rc : "?") + "]"); },
        error: function (d) { line("error: " + ((d && (d.hint || d.kind)) || d)); }   /* the desktop core reports as an error pair */
      }, run.ctl).catch(function (e) {
        line(e.quiet ? String(e.message) : e.status === 404 ? "spark " + verb + " is not available yet on this FORGE" : "error: " + (e.message || e));
      }).then(function () {
        if (run.stopping) { run.stopping = false; line("[stopped]"); }
        run.busy = false; run.ctl = null; config.load();
      });
    },
    init: function () {
      document.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest("button[data-run]") : null;
        if (!b) return;
        var args = b.getAttribute("data-args");
        run.go(b.getAttribute("data-run"), args ? args.split(" ") : []);
      });
      $("output-clear").addEventListener("click", function () { $("output").textContent = ""; $("output-title").textContent = "output"; });
    }
  };

  /* ----------------------------------------------------------- monitor */
  var GLYPH = { ok: "\u2713", fail: "\u2717", warn: "!", na: "\u2013" };
  var CATS = ["SOFTWARE", "CAPABILITY", "NONFUNCTIONAL"];
  var monitor = {
    ts: 0, days: "1",
    load: function () {
      if (host.raw) { notYet(clear($("check-table")), "monitor"); clear($("stats-tiles")); return; }
      monitor.loadCheck();
      monitor.loadStats();
      if (me.role !== "admin") return;   /* serve/gpu/bench are admin cards */
      api.get("/api/serve").then(monitor.serve).catch(function (e) { fail($("serve-facts"), e); });
      api.get("/api/gpu").then(monitor.gpu).catch(function () { $("gpu-card").hidden = true; });
      api.get("/api/bench").then(monitor.bench).catch(function (e) { fail($("bench-facts"), e); });
    },
    loadCheck: function () {
      api.get("/api/check").then(function (c) {
        monitor.tally(c);
        var t = clear($("check-table")), rows = c.rows || [];
        CATS.concat(rows.map(function (r) { return r.category; }).filter(function (x, i, a) { return CATS.indexOf(x) < 0 && a.indexOf(x) === i; }))
          .forEach(function (cat) {
            var rs = rows.filter(function (r) { return r.category === cat; });
            if (!rs.length) return;
            t.appendChild(el("div", "cat", cat));
            rs.forEach(function (r) {
              var d = el("div", "r " + r.status);
              d.appendChild(el("span", "g " + r.status, GLYPH[r.status] || "?")).setAttribute("title", r.status);
              d.appendChild(el("span", "n", r.name));
              d.appendChild(el("span", "v", r.value));
              if (r.remedy && r.status !== "ok") d.appendChild(el("span", "rem", r.remedy));
              t.appendChild(d);
            });
          });
      }).catch(function (e) { fail($("check-table"), e); });
    },
    tally: function (c) {
      var k = c.counts || {};
      $("check-tally").textContent = (k.ok || 0) + " ok  " + (k.fail || 0) + " fail  " + (k.warn || 0) + " warn  " + (k.na || 0) + " na";
      monitor.ts = c.ts || 0;
      monitor.age();
    },
    age: function () {
      if (!monitor.ts) return;
      $("check-age").textContent = "age " + Math.max(0, Math.round(Date.now() / 1000 - monitor.ts)) + " s";
    },
    loadStats: function () {
      api.get("/api/stats?days=" + monitor.days).then(function (s) {
        var t = clear($("stats-tiles"));
        function tile(k, v, sub) {
          var d = el("div", "tile");
          d.appendChild(el("div", "k", k)); d.appendChild(el("div", "v", v));
          if (sub) d.appendChild(el("div", "s", sub));
          t.appendChild(d);
        }
        tile("turns", s.turns || 0);
        tile("generate tok/s", num(s.tg_mean), "p50 " + num(s.tg_p50) + "  p05 " + num(s.tg_p05));
        tile("prompt tok/s", num(s.pp_mean), "cache " + num(s.cache, 0) + " %");
        tile("latency ms", num(s.ms_p50, 0), "p95 " + num(s.ms_p95, 0));
        var b = s.baseline;
        tile("of baseline", b && b.tg && s.tg_mean ? num(100 * s.tg_mean / b.tg, 0) + " %" : "-", b ? "tg " + num(b.tg) + " " + (b.settings || "") : "no bench yet");
        var r = s.running || {};
        tile("running", r.ngl !== undefined ? keyOf(r) : "-", r.ngl !== undefined ? "" : "no server here");
      }).catch(function (e) { fail($("stats-tiles"), e); });
    },
    serve: function (s) {
      var dl = clear($("serve-facts"));
      fact(dl, "url", s.url); fact(dl, "health", s.health); fact(dl, "model", s.model);
      fact(dl, "service", s.service); fact(dl, "pids", (s.pids || []).join(" "));
      fact(dl, "mem free", s.mem_free_gb !== undefined && s.mem_free_gb !== null ? num(s.mem_free_gb) + " GB" : "-");
      var log = $("serve-log");
      log.textContent = (s.log || []).slice(-40).join("\n");
      log.scrollTop = log.scrollHeight;
    },
    serveLive: function (d) {
      var dds = $("serve-facts").querySelectorAll("dd");
      if (dds.length >= 2) { dds[0].textContent = d.url || "-"; dds[1].textContent = d.health || "-"; }
    },
    gpu: function (g) {
      var card = $("gpu-card");
      if (!g || !Object.keys(g).length) { card.hidden = true; return; }
      card.hidden = false;
      var dl = clear($("gpu-facts"));
      fact(dl, "name", g.name); fact(dl, "busy", g.busy !== undefined ? g.busy + " %" : "-");
      fact(dl, "vram", g.vram_total ? num(g.vram_used) + " / " + num(g.vram_total) + " GB" : "-");
      fact(dl, "gtt", g.gtt_total ? num(g.gtt_used) + " / " + num(g.gtt_total) + " GB" : "-");
    },
    bench: function (b) {
      var dl = clear($("bench-facts")), base = b.baseline, t = b.tune, box = clear($("tune-table"));
      if (base) {
        fact(dl, "baseline", "pp " + num(base.pp) + "  tg " + num(base.tg) + " tok/s");
        fact(dl, "settings", keyOf(base.settings)); fact(dl, "model", base.model);
        fact(dl, "size", base.size); fact(dl, "when", fmtTs(base.ts));
      } else fact(dl, "baseline", "none yet (spark bench)");
      if (!t || !t.table) { box.appendChild(el("p", "muted", "no tune run yet (spark bench --tune)")); return; }
      var now = keyOf(b.now || t.current), win = keyOf(t.winner);
      var tb = el("table"), tr = el("tr");
      ["settings", "pp", "tg", ""].forEach(function (h, i) { tr.appendChild(el("th", i && i < 3 ? "num" : null, h)); });
      tb.appendChild(tr);
      t.table.forEach(function (r) {
        var k = keyOf(r.settings), row = el("tr", k === win ? "win" : null);
        row.appendChild(el("td", "mono", k));
        row.appendChild(el("td", "num", num(r.pp))); row.appendChild(el("td", "num", num(r.tg)));
        row.appendChild(el("td", "muted", (k === win ? "winner " : "") + (k === now ? "now" : "")));
        tb.appendChild(row);
      });
      var wrap = el("div", "tbl"); wrap.appendChild(tb); box.appendChild(wrap);
      box.appendChild(el("p", "muted small", "tune " + fmtTs(t.ts) + ", " + t.model + " -- winner tg " + num(t.winner_tg) + ", pp " + num(t.winner_pp)));
    },
    init: function () {
      $("stats-days").addEventListener("change", function () { monitor.days = this.value; monitor.loadStats(); });
      $("check-refresh").addEventListener("click", function () {
        api.post("/api/check/refresh").catch(function () { /* older server: just re-read */ }).then(monitor.loadCheck);
      });
      setInterval(monitor.age, 1000);
    }
  };

  /* ----------------------------------------------------------- chat */
  var chat = {
    thread: null, busy: false, ctl: null, stopping: false,
    listHead: undefined,   /* newest thread id from the last completed list load; undefined = never loaded, null = loaded and empty */
    history: [],   /* raw mode only: [{role, content}], capped */
    CAP: 20000,    /* raw history budget in characters */
    /* the status line: one writer, so the error color never lingers.
       unchanged text writes nothing: the line is aria-live, and even a
       same-string textContent swap is a mutation AT re-announces (the
       per-delta "answering" and the offline ticker land here) */
    status: function (text, isErr) {
      var p = $("chat-status");
      if (p.textContent === text && p.classList.contains("err") === !!isErr) return;
      p.textContent = text;
      p.classList.toggle("err", !!isErr);
    },
    load: function () {
      if (host.raw) return;   /* no threads on a bare model server */
      chat.list();
      if (chat.thread) chat.open(chat.thread);
    },
    /* refresh the thread list only: the open transcript stays as it is */
    list: function () {
      if (host.raw) return;
      api.get("/api/threads?n=30").then(function (d) {
        chat.listHead = (d.threads || []).length ? d.threads[0].id : null;
        var ul = clear($("thread-list"));
        (d.threads || []).forEach(function (t) {
          var li = el("li"), b = el("button", "pick", t.title || t.id);
          b.type = "button"; b.setAttribute("data-id", t.id); b.setAttribute("aria-current", t.id === chat.thread ? "true" : "false");
          b.addEventListener("click", function () { chat.open(t.id); });
          li.appendChild(b);
          li.appendChild(el("span", "meta", (t.turns || 0) + " turns  " + fmtTs(t.ts)));
          ul.appendChild(li);
        });
        if (!(d.threads || []).length) ul.appendChild(el("li", "muted", "no threads yet"));
      }).catch(function (e) { e.status === 404 ? notYet($("thread-list"), "the thread list") : fail($("thread-list"), e); });
    },
    /* open and fresh no-op while an answer streams: they would detach
       the live row and swap the thread out from under the stream (n,
       j/k, r and the thread picks all land here) -- Esc stops first */
    open: function (id) {
      if (chat.busy) return;
      chat.thread = id;
      chat.drawer(false);
      document.querySelectorAll("#thread-list .pick").forEach(function (b) {
        b.setAttribute("aria-current", b.getAttribute("data-id") === id ? "true" : "false");
      });
      api.get("/api/threads/" + encodeURIComponent(id)).then(function (d) {
        var tr = clear($("transcript"));
        (d.messages || []).forEach(function (m) { chat.msg(m.role, m.text, m.ms); });
        tr.scrollTop = tr.scrollHeight;
        if (offline.at) offline.status(); else chat.status("thread " + id);
      }).catch(function (e) { fail($("transcript"), e); });
    },
    fresh: function () {
      if (chat.busy) return;
      chat.thread = null; chat.history = []; clear($("transcript"));
      if (offline.at) offline.status(); else chat.status("new thread");
      document.querySelectorAll("#thread-list .pick").forEach(function (b) { b.setAttribute("aria-current", "false"); });
      $("chat-text").focus();
    },
    drawer: function (on) {
      /* closing must not strand focus on a hidden node: hand it back
         to the toggle, the disclosure pattern's trigger */
      if (!on && $("view-chat").classList.contains("drawer") && $("threads").contains(document.activeElement))
        $("threads-toggle").focus();
      $("view-chat").classList.toggle("drawer", !!on);
      $("threads-toggle").setAttribute("aria-expanded", on ? "true" : "false");
    },
    /* one transcript row: mark column + body; the role stays for AT */
    msg: function (role, text, ms) {
      var d = el("div", "msg " + role);
      var mk = el("span", "m", role === "assistant" ? "*" : role === "user" ? ">" : "!");
      mk.setAttribute("aria-hidden", "true");
      d.appendChild(mk);
      d.appendChild(el("span", "vh", role));
      rich(d.appendChild(el("div", "txt")), text || "");
      if (ms !== undefined) d.appendChild(el("div", "ms", ms + " ms"));
      var tr = $("transcript"); tr.appendChild(d); tr.scrollTop = tr.scrollHeight;
      return d;
    },
    streamOn: function (on) { $("chat-stop").hidden = !on; },
    stop: function () {
      if (!chat.busy || !chat.ctl || !chat.ctl.abort) return;
      chat.stopping = true;
      chat.ctl.abort();
    },
    /* the server's forge._title, byte for byte: a thread's title is
       its first user line, whitespace collapsed, capped at 60 */
    title: function (s) {
      s = String(s || "").split(/\s+/).filter(Boolean).join(" ");
      return s.length <= 60 ? s : s.slice(0, 57) + "...";
    },
    /* after stopping the first turn of a new thread the FORGE usually
       kept nothing -- adopt the newest thread only when it is not the
       head the last completed list load saw before sending AND its
       title matches the text this send opened with (the FORGE is
       multi-client: a head that merely differs could be another
       client's new thread -- the prompt, a phone -- and adopting it
       would append our next message there; `before` is null only when
       that load answered empty -- while the list has never loaded the
       caller skips adoption instead, so a pre-existing thread is
       never mistaken for ours); no wall-clock compare: the server's
       ts is its local time, not ours. the list alone is refreshed,
       keeping the stopped partial on screen */
    adopt: function (before, text) {
      api.get("/api/threads?n=1").then(function (d) {
        if (chat.busy) return;   /* a newer send owns the thread and the status now */
        var t = (d.threads || [])[0];
        if (t && t.id !== before && t.title === chat.title(text)) chat.thread = t.id;
        chat.status(chat.thread ? "thread " + chat.thread : "new thread");
        chat.list();
      }).catch(function () {
        if (!chat.busy) chat.status(chat.thread ? "thread " + chat.thread : "new thread");
        chat.list();
      });
    },
    send: function () {
      if (offline.at) { offline.status(); return; }
      var ta = $("chat-text"), text = ta.value.trim();
      if (!text || chat.busy) return;
      if (host.raw) return chat.sendRaw(text, ta);
      chat.busy = true; chat.stopping = false; ta.value = ""; chat.size();
      var wasNew = !chat.thread;
      var before = chat.listHead;   /* undefined while the list has never loaded */
      chat.msg("user", text);
      var d = chat.msg("assistant", ""), txt = d.querySelector(".txt"), acc = "", t0 = Date.now(), fin = false;
      d.classList.add("streaming");
      chat.streamOn(true);
      chat.ctl = {};
      chat.status("answering");
      api.stream("/api/chat", chat.thread ? { thread: chat.thread, text: text } : { text: text }, {
        queued: function () { chat.status("queued"); },
        /* append the fragment, never rewrite: #transcript is
           aria-live, and a rewrite re-announces the whole answer per
           token; rich() re-renders once, on done */
        delta: function (x) { var t = (x && x.t !== undefined) ? x.t : String(x); acc += t; txt.appendChild(document.createTextNode(t)); $("transcript").scrollTop = 1e9; chat.status("answering"); },
        done: function (x) {
          rich(clear(txt), acc);
          d.appendChild(el("div", "ms", (x && x.ms !== undefined ? x.ms : Date.now() - t0) + " ms" + (x && x.model ? "  " + x.model : "")));
          if (x && x.thread) chat.thread = x.thread;
          chat.status("thread " + (chat.thread || ""));
          fin = true;   /* reload after busy clears: open is guarded while streaming */
        },
        error: function (x) {
          d.classList.add("error"); mkBang(d);
          txt.textContent = "error: " + (x && (x.hint || x.kind) || x);
          chat.status("error", true);
        }
      }, chat.ctl).catch(function (e) {
        d.classList.add("error"); mkBang(d);
        txt.textContent = e.status === 404 ? "chat is not available yet on this FORGE" : "error: " + (e.message || e);
        chat.status("error", true);
      }).then(function () {
        d.classList.remove("streaming");
        chat.streamOn(false);
        chat.busy = false; chat.ctl = null;
        if (fin) chat.load();
        if (chat.stopping) {
          chat.stopping = false;
          if (acc) rich(clear(txt), acc);
          d.appendChild(el("div", "stopped", "(stopped)"));
          if (wasNew && !chat.thread && before !== undefined) chat.adopt(before, text);
          else { chat.status(chat.thread ? "thread " + chat.thread : "new thread"); chat.list(); }
        }
        ta.focus();
      });
    },
    /* raw llama-server: in-memory history, chat_openai on the core */
    sendRaw: function (text, ta) {
      chat.busy = true; chat.stopping = false; ta.value = ""; chat.size();
      chat.msg("user", text);
      chat.history.push({ role: "user", content: text });
      chat.cap();
      var d = chat.msg("assistant", ""), txt = d.querySelector(".txt"), acc = "", t0 = Date.now(), ok = false;
      d.classList.add("streaming");
      chat.streamOn(true);
      chat.ctl = {};
      chat.status("answering");
      host.sse("chat_openai", { messages: chat.history.slice() }, {
        /* append, never rewrite: same live-region rule as chat.send */
        delta: function (x) { var t = (x && x.t !== undefined) ? x.t : String(x); acc += t; txt.appendChild(document.createTextNode(t)); $("transcript").scrollTop = 1e9; },
        done: function (x) {
          ok = true;
          rich(clear(txt), acc);
          d.appendChild(el("div", "ms", (x && x.ms !== undefined ? x.ms : Date.now() - t0) + " ms" + (x && x.model ? "  " + x.model : "")));
          chat.history.push({ role: "assistant", content: acc });
          chat.status("");
        },
        error: function (x) {
          d.classList.add("error"); mkBang(d);
          txt.textContent = "error: " + (x && (x.hint || x.kind) || x);
          chat.status("error", true);
        }
      }, chat.ctl).catch(function (e) {
        d.classList.add("error"); mkBang(d);
        txt.textContent = "error: " + (e.message || e);
        chat.status("error", true);
      }).then(function () {
        d.classList.remove("streaming");
        chat.streamOn(false);
        chat.busy = false; chat.ctl = null;
        var stopped = chat.stopping;
        chat.stopping = false;
        if (stopped) {
          if (acc) rich(clear(txt), acc);
          d.appendChild(el("div", "stopped", "(stopped)"));
          chat.status("");
        }
        if (!ok) {   /* a failed turn must not leave a dangling user message */
          if (stopped && acc) chat.history.push({ role: "assistant", content: acc });
          else if (chat.history.length && chat.history[chat.history.length - 1].role === "user") chat.history.pop();
        }
        ta.focus();
      });
    },
    cap: function () {   /* keep the raw history under CAP, oldest pairs first */
      function total() { return chat.history.reduce(function (n, m) { return n + m.content.length; }, 0); }
      while (chat.history.length > 2 && total() > chat.CAP) chat.history.splice(0, 2);
    },
    next: function (dir) {   /* j/k: open the next/previous thread */
      var picks = Array.prototype.slice.call(document.querySelectorAll("#thread-list .pick"));
      if (!picks.length) return;
      var i = -1;
      picks.forEach(function (b, k) { if (b.getAttribute("data-id") === chat.thread) i = k; });
      var n = i < 0 ? (dir > 0 ? 0 : picks.length - 1) : Math.min(picks.length - 1, Math.max(0, i + dir));
      if (picks[n] && n !== i) chat.open(picks[n].getAttribute("data-id"));
    },
    size: function () {
      var ta = $("chat-text"); ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, 192) + "px";
    },
    init: function () {
      var ta = $("chat-text");
      $("chat-form").addEventListener("submit", function (ev) { ev.preventDefault(); chat.send(); });
      ta.addEventListener("keydown", function (ev) {
        if (ev.isComposing || ev.keyCode === 229) return;   /* IME: this Enter commits the candidate */
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); chat.send(); }
      });
      ta.addEventListener("input", chat.size);
      $("chat-stop").addEventListener("click", chat.stop);
      $("thread-new").addEventListener("click", chat.fresh);
      $("threads-toggle").addEventListener("click", function () {
        chat.drawer(!$("view-chat").classList.contains("drawer"));
      });
    }
  };
  function mkBang(d) { var mk = d.querySelector(".m"); if (mk) mk.textContent = "!"; }

  /* ----------------------------------------------------------- do */
  var doView = {
    thread: null, busy: false, named: false,
    load: function () { /* nothing to fetch: a goal starts it */ },
    reset: function () { doView.thread = null; doView.named = false; clear($("do-steps")); },
    propose: function (text) {
      if (doView.busy) return;
      doView.busy = true;
      $("do-status").textContent = "thinking";
      var body = doView.thread ? { thread: doView.thread, text: text } : { text: text };
      api.post("/api/do/propose", body).then(function (d) {
        if (d.thread) doView.thread = d.thread;
        if (d.driver && !doView.named) {
          doView.named = true;
          $("do-steps").appendChild(el("div", "muted small", "driving with " + d.driver));
        }
        $("do-status").textContent = (d.ms !== undefined ? d.ms + " ms" : "") + (doView.thread ? "  thread " + doView.thread : "");
        doView.step(d.reply || {}, d.unchecked || []);
      }).catch(function (e) {
        $("do-status").textContent = e.quiet ? String(e.message) : e.status === 404 ? "do is not available yet on this FORGE" : "error: " + (e.message || e);
      }).then(function () { doView.busy = false; });
    },
    step: function (r, bad) {
      var box = $("do-steps"), n = box.querySelectorAll(".step").length + 1;
      if (r.kind === "done" || !r.command) {
        var dn = el("div", "step done");
        dn.appendChild(el("div", "cmd" + (bad && bad.length ? " warn" : ""), "done"));
        dn.appendChild(el("div", "hint", r.hint || ""));
        if (bad && bad.length) dn.appendChild(el("div", "muted small",
          "unchecked: no command produced " + bad.join(", ") + " -- believe the outputs above"));
        box.appendChild(dn);
        return;
      }
      var s = el("div", "step" + (r.danger ? " danger" : ""));
      var cmd = el("div", "cmd"); cmd.appendChild(el("span", "muted", n + "  ")); cmd.appendChild(el("code", null, r.command));
      s.appendChild(cmd);
      s.appendChild(el("div", "hint", r.hint || ""));
      var ctl = el("div", "ctl"), b = el("button", r.danger ? "danger" : null, r.danger ? "Run anyway" : "Run");
      b.type = "button"; ctl.appendChild(b);
      var note = el("span", "muted small", ""); ctl.appendChild(note);
      s.appendChild(ctl);
      var armed = 0;
      b.addEventListener("click", function () {
        if (r.danger && Date.now() - armed > 5000) {
          armed = Date.now(); b.classList.add("confirm"); note.textContent = "click again to confirm";
          setTimeout(function () { if (Date.now() - armed >= 5000) { b.classList.remove("confirm"); note.textContent = ""; } }, 5100);
          return;
        }
        b.disabled = true; note.textContent = "running";
        api.post("/api/do/run", { command: r.command }).then(function (d) {
          note.textContent = "";
          ctl.appendChild(el("span", "rc " + (d.rc === 0 ? "ok" : "fail"), "exit " + d.rc));
          var pre = el("pre", "log", d.tail || ""); s.appendChild(pre);
          var next = el("button", null, "next step"); next.type = "button";
          next.addEventListener("click", function () {
            next.disabled = true;
            doView.propose("Output of `" + r.command + "` (exit " + d.rc + "):\n" + (d.tail || ""));
          });
          s.appendChild(next); next.focus();
        }).catch(function (e) { b.disabled = false; note.textContent = e.quiet ? String(e.message) : "error: " + (e.message || e); });
      });
      box.appendChild(s); b.focus();
    },
    init: function () {
      $("do-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var g = $("do-goal").value.trim();
        if (!g) return;
        doView.reset();
        doView.propose(g);
      });
    }
  };

  /* ----------------------------------------------------------- config */
  var config = {
    load: function () {
      if (host.raw) {
        notYet(clear($("memory-list")), "memory");
        $("soul-text").value = "";
        $("soul-status").textContent = "not available on a raw model server";
        return;
      }
      if (me.role === "admin") api.get("/api/config").then(function (c) {
        var sel = clear($("theme-pick")), cur = (c.effective || {}).SITE_THEME || (c.site || {}).SITE_THEME || "";
        ["none"].concat(c.themes || []).forEach(function (n) { var o = el("option", null, n); o.value = n; sel.appendChild(o); });
        sel.value = cur || "none";
        var eff = c.effective || {};
        if (!$("font-face").value) $("font-face").value = eff.SITE_FONT_FACE || "";
        if (!$("font-size").value) $("font-size").value = eff.SITE_FONT_SIZE || "";
        var box = clear($("model-table")), tb = el("table"), tr = el("tr");
        ["model", "GB", "needs RAM", "fits", "downloaded", "state", ""].forEach(function (h, i) { tr.appendChild(el("th", i === 1 || i === 2 ? "num" : null, h)); });
        tb.appendChild(tr);
        (c.models || []).forEach(function (m) {
          var row = el("tr", m.chosen ? "chosen" : null);
          row.appendChild(el("td", "mono", (m.role === "spark" ? "* " : m.role === "ember" ? "+ " : "") + m.name));
          row.appendChild(el("td", "num", num(m.gb))); row.appendChild(el("td", "num", num(m.ram_gb, 0)));
          row.appendChild(el("td", m.fits ? "ok" : "warn", m.fits ? "yes" : "no"));
          row.appendChild(el("td", null, m.downloaded ? "yes" : "-"));
          row.appendChild(el("td", null, (m.serving ? "serving " : "") + (m.chosen ? "chosen" : "")));
          var td = el("td"), b = el("button", "quiet", "choose"); b.type = "button";
          b.setAttribute("data-run", "model"); b.setAttribute("data-args", m.name);
          td.appendChild(b); row.appendChild(td); tb.appendChild(row);
        });
        var wrap = el("div", "tbl"); wrap.appendChild(tb); box.appendChild(wrap);
        if ((c.models || []).some(function (m) { return m.role; }))
          box.appendChild(el("p", "muted small", "marks: * the spark (prompt line), + the ember (conversations)"));
        var ep = clear($("ember-pick"));
        ["auto", "none"].concat((c.models || []).map(function (m) { return m.name; })).forEach(function (n) {
          var o = el("option", null, n); o.value = n; ep.appendChild(o);
        });
        ep.value = eff.SITE_EMBER_MODEL || "auto";
        var dl = clear($("config-facts"));
        fact(dl, "prompt", c.off ? "off" : "on"); fact(dl, "service", c.service);
        fact(dl, "model", eff.SITE_AI_MODEL); fact(dl, "ember", eff.SITE_EMBER_MODEL || "auto");
        fact(dl, "theme", cur || "none");
        fact(dl, "quiet boot", eff.SITE_QUIET_BOOT); fact(dl, "quiet login", eff.SITE_QUIET_LOGIN);
      }).catch(function (e) { fail($("model-table"), e); });
      api.get("/api/soul").then(function (s) {
        $("soul-text").value = typeof s === "string" ? s : (s.text || "");
        $("soul-status").textContent = "";
      }).catch(function (e) { $("soul-status").textContent = e.status === 404 ? "the soul editor is not available yet" : "error: " + (e.message || e); });
      config.memory();
    },
    memory: function () {
      api.get("/api/memory").then(function (m) {
        var ul = clear($("memory-list"));
        (m.facts || []).forEach(function (f, i) {
          var li = el("li"), x = el("button", "x", "x"), n = (typeof f === "object" && f.n !== undefined) ? f.n : i + 1;
          x.type = "button"; x.setAttribute("aria-label", "forget " + n);
          x.addEventListener("click", function () { api.del("/api/memory/" + n).then(config.memory).catch(function (e) { fail(ul, e); }); });
          li.appendChild(el("span", "meta", n));
          li.appendChild(el("span", "pick", typeof f === "object" ? (f.text || f.fact || JSON.stringify(f)) : f));
          li.appendChild(x); ul.appendChild(li);
        });
        if (!(m.facts || []).length) ul.appendChild(el("li", "muted", "nothing remembered"));
      }).catch(function (e) { e.status === 404 ? notYet($("memory-list"), "memory") : fail($("memory-list"), e); });
    },
    init: function () {
      $("theme-form").addEventListener("submit", function (ev) { ev.preventDefault(); run.go("theme", [$("theme-pick").value]).then(theme.load); });
      $("ember-pick").addEventListener("change", function () { run.go("ember", [this.value]); });
      $("font-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var f = $("font-face").value.trim(), s = $("font-size").value.trim();
        if (f === "none" || (f && !s)) run.go("font", [f]); else if (f && s) run.go("font", [f, s]);
      });
      $("soul-save").addEventListener("click", function () {
        $("soul-status").textContent = "saving";
        api.post("/api/soul", { text: $("soul-text").value }).then(function () { $("soul-status").textContent = "saved"; })
          .catch(function (e) { $("soul-status").textContent = "error: " + (e.message || e); });
      });
      $("memory-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var t = $("memory-text").value.trim();
        if (!t) return;
        api.post("/api/memory", { text: t }).then(function () { $("memory-text").value = ""; config.memory(); })
          .catch(function (e) { fail($("memory-list"), e); });
      });
    }
  };

  /* ----------------------------------------------------------- help */
  var help = {
    load: function () {
      $("help-health").textContent = host.tauri ? "<server url>/api/health" : location.origin + "/api/health";
    },
    init: function () { }
  };

  /* ----------------------------------------------------------- route */
  var VIEWS = { monitor: monitor, chat: chat, "do": doView, config: config, help: help };
  var ORDER = ["monitor", "chat", "do", "config", "help"];
  var route = {
    current: function () {
      var h = location.hash.replace(/^#\/?/, "").split("/")[0];
      return VIEWS[h] ? h : "monitor";
    },
    show: function (name, load) {
      document.querySelectorAll(".tabs a").forEach(function (a) {
        if (a.getAttribute("data-view") === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      });
      if (!auth.ok) return;
      ORDER.forEach(function (v) { $("view-" + v).hidden = v !== name; });
      if (load !== false) VIEWS[name].load();
    },
    go: function (name) { location.hash = "#/" + name; },
    keys: function (ev) {
      var t = ev.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (ev.key === "Escape") {   /* stop the answer or the running verb, else leave the input, else close the drawer */
        if (chat.busy && chat.ctl) { chat.stop(); ev.preventDefault(); return; }
        if (run.busy && run.ctl) { run.stop(); ev.preventDefault(); return; }
        if (typing) { t.blur(); return; }
        if ($("view-chat").classList.contains("drawer")) chat.drawer(false);
        return;
      }
      if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var n = parseInt(ev.key, 10);
      if (n >= 1 && n <= 5) {
        if (me.role === "admin" || ORDER[n - 1] !== "do") route.go(ORDER[n - 1]);
        ev.preventDefault(); return;
      }
      if (ev.key === "/") {
        var v = $("view-" + route.current()), inp = v && v.querySelector("[data-main]");
        if (inp) { inp.focus(); ev.preventDefault(); }
        return;
      }
      if (ev.key === "r") { route.show(route.current()); ev.preventDefault(); return; }
      if (ev.key === "n" && route.current() === "chat") { chat.fresh(); ev.preventDefault(); return; }
      if ((ev.key === "j" || ev.key === "k") && route.current() === "chat" && !host.raw) {
        chat.next(ev.key === "j" ? 1 : -1); ev.preventDefault(); return;
      }
      if (ev.key === "q" && host.tauri) { host.invoke("quit").catch(function () { /* nothing to do */ }); return; }
      if (ev.key === "?") { route.go("help"); ev.preventDefault(); }
    },
    init: function () {
      window.addEventListener("hashchange", function () { route.show(route.current()); });
      document.addEventListener("keydown", route.keys);
    }
  };

  /* ----------------------------------------------------------- boot */
  function siteLine(h) {
    var mm = h.model ? "  " + h.model : "";
    if (h.roles) {
      var rk = ["spark", "ember"].concat(Object.keys(h.roles).filter(function (k) { return k !== "spark" && k !== "ember"; }));
      var rr = rk.filter(function (k) { return h.roles[k]; }).map(function (k) { return k + " " + h.roles[k]; });
      if (rr.length) mm = "  " + rr.join(" \u00b7 ");
    }
    $("site").textContent = (h.name || "") + (h.version ? "  v" + h.version : "") + mm;
    document.title = "spark" + (h.name ? " " + h.name : "");
  }
  function boot() {
    document.body.classList.add(host.tauri ? "host-tauri" : "host-web");
    theme.init(); auth.init(); run.init(); route.init();
    ORDER.forEach(function (v) { VIEWS[v].init(); });
    if (host.tauri) {
      host.detect().then(function (h) {
        if (h && h.forge) siteLine(h);
        auth.gained();
      }).catch(function () { auth.lost(); });
      route.show(route.current(), false);
      return;
    }
    api.get("/api/health").then(siteLine).catch(function () { $("site").textContent = "no FORGE answers"; });
    api.get("/api/bar").then(function (b) { $("bar").textContent = b.line || ""; auth.gained(); })
      .catch(function () { /* 401 already showed the login card */ });
    route.show(route.current(), false);
  }
  boot();
})();
