/**
 * The remote web client, served as three static assets so the gateway can keep
 * a strict Content-Security-Policy (no inline script/style). The client is a
 * faithful, mobile-first rendering of the terminal transcript: dark monospace,
 * prompt cards, reasoning blocks, tool rows, and a send dock.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#17161c" />
<meta name="referrer" content="no-referrer" />
<title>midas remote</title>
<link rel="stylesheet" href="/client.css" />
</head>
<body>
<div id="root"></div>
<script src="/client.js"></script>
</body>
</html>
`;

export const CLIENT_CSS = `:root {
  --bg: #17161c;
  --panel: #1e1d25;
  --panel-2: #24222d;
  --border: #37343f;
  --text: #e7e5ee;
  --dim: #8b8899;
  --muted: #6f6c7c;
  --accent: #b48ead;
  --green: #a3be8c;
  --red: #bf616a;
  --yellow: #ebcb8b;
  --blue: #81a1c1;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text); font-family: var(--mono);
  font-size: 14px; line-height: 1.5; overscroll-behavior: none;
}
#root { height: 100dvh; display: flex; flex-direction: column; }
button { font-family: var(--mono); font-size: 13px; cursor: pointer; }

/* ---- login ---- */
.login { margin: auto; width: min(360px, 90vw); padding: 20px; }
.login h1 { font-size: 15px; font-weight: 600; color: var(--accent); margin: 0 0 4px; }
.login p { color: var(--dim); font-size: 12px; margin: 0 0 16px; }
.login input {
  width: 100%; padding: 12px; background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; font-family: var(--mono); font-size: 16px;
}
.login button {
  width: 100%; margin-top: 12px; padding: 12px; border: 0; border-radius: 8px;
  background: var(--accent); color: #17161c; font-weight: 700;
}
.login .err { color: var(--red); font-size: 12px; min-height: 18px; margin-top: 10px; }

/* ---- top bar ---- */
.bar {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  padding-top: calc(10px + env(safe-area-inset-top));
  background: var(--panel); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 5;
}
.bar .back {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 10px;
}
.bar .title { flex: 1; min-width: 0; }
.bar .title .name { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.bar .title .sub { display: block; color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.bar .dot.busy { background: var(--yellow); }
.bar .dot.idle { background: var(--green); }
.bar .logout { background: transparent; color: var(--dim); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }

/* ---- session list ---- */
.list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.row {
  display: block; width: 100%; text-align: left; padding: 12px;
  background: transparent; color: var(--text); border: 0; border-bottom: 1px solid var(--border);
}
.row:active { background: var(--panel); }
.row .r-title { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .r-meta { display: block; color: var(--dim); font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { color: var(--muted); padding: 24px 12px; text-align: center; }

/* ---- session ---- */
.stream { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 10px 10px 6px; }
.msg { margin-bottom: 10px; }
.msg .who { color: var(--dim); font-size: 11px; margin-bottom: 3px; }
.prompt {
  border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px;
  white-space: pre-wrap; word-break: break-word; background: rgba(180,142,173,0.06);
}
.text { white-space: pre-wrap; word-break: break-word; }
.msg.assistant .text { padding: 2px 0; }
.notice { color: var(--muted); font-size: 12px; padding: 2px 0; }
.error { color: var(--red); white-space: pre-wrap; word-break: break-word; border-left: 2px solid var(--red); padding-left: 8px; }
.reason { color: var(--dim); }
.reason summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.reason .body { white-space: pre-wrap; word-break: break-word; padding: 4px 0 4px 10px; border-left: 1px solid var(--border); }
.tool { margin: 6px 0; }
.tool summary { cursor: pointer; list-style: none; display: flex; gap: 8px; align-items: baseline; }
.tool summary::-webkit-details-marker { display: none; }
.tool .nm { color: var(--blue); }
.tool .st { font-size: 11px; }
.tool .st.running { color: var(--yellow); }
.tool .st.completed { color: var(--green); }
.tool .st.error { color: var(--red); }
.tool .st.pending { color: var(--muted); }
.tool pre {
  margin: 5px 0; padding: 8px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto;
}
.bash pre { border-left: 2px solid var(--yellow); }
.bash.err pre { border-left-color: var(--red); }

/* ---- prompts (permissions / questions) ---- */
.cards { padding: 0 10px 6px; }
.card { border: 1px solid var(--yellow); border-radius: 8px; padding: 10px; margin-bottom: 8px; background: var(--panel); }
.card .q { white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
.card .btns { display: flex; flex-wrap: wrap; gap: 8px; }
.card .btns button { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; }
.card .btns button.ok { border-color: var(--green); color: var(--green); }
.card .btns button.no { border-color: var(--red); color: var(--red); }

/* ---- input dock ---- */
.dock {
  border-top: 1px solid var(--border); background: var(--panel);
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
  display: flex; gap: 8px; align-items: flex-end;
}
.dock textarea {
  flex: 1; resize: none; min-height: 42px; max-height: 32dvh; padding: 10px;
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; font-family: var(--mono); font-size: 16px; line-height: 1.4;
}
.dock button { border: 0; border-radius: 8px; padding: 11px 14px; background: var(--accent); color: #17161c; font-weight: 700; }
.dock button.abort { background: var(--red); color: #fff; }
.dock button:disabled { opacity: 0.5; }
.hint { color: var(--muted); font-size: 11px; text-align: center; padding: 6px 0 0; }
`;

export const CLIENT_JS = `(function () {
  "use strict";
  var state = {
    sessions: [],
    currentId: null,
    currentTitle: "",
    currentDir: "",
    ws: null,
    reconnect: 0,
    reconnectTimer: null,
    order: [],
    nodes: new Map(),
    phase: "idle",
    permissions: [],
    questions: []
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === "text") node.textContent = value;
        else if (key === "class") node.className = value;
        else if (key === "onclick") node.addEventListener("click", value);
        else node.setAttribute(key, value);
      });
    }
    if (children) children.forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function root() { return document.getElementById("root"); }
  function rel(ts) {
    if (!ts) return "";
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  function api(path, options) {
    var opts = Object.assign({ credentials: "same-origin" }, options || {});
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || String(res.status)); });
      return res.json();
    });
  }

  /* ---------------- login ---------------- */
  function showLogin(message) {
    closeWs();
    var password = el("input", { type: "password", placeholder: "remote password", autocomplete: "current-password" });
    var err = el("div", { class: "err", text: message || "" });
    var form = el("form", { class: "login" }, [
      el("h1", { text: "midas remote" }),
      el("p", { text: "Enter the password from /settings to continue." }),
      password,
      el("button", { type: "submit", text: "Unlock" }),
      err
    ]);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      err.textContent = "";
      api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Midas-Remote": "1" },
        body: JSON.stringify({ password: password.value })
      }).then(function () { showSessions(); }).catch(function (e) {
        err.textContent = String(e.message || e).indexOf("unauthorized") >= 0 ? "Wrong password" : String(e.message || e);
      });
    });
    clear(root());
    root().appendChild(form);
    password.focus();
  }

  /* ---------------- session list ---------------- */
  function showSessions() {
    closeWs();
    state.currentId = null;
    api("/api/sessions").then(function (data) {
      state.sessions = data.sessions || [];
      renderSessions();
    }).catch(function () {});
  }
  function renderSessions() {
    var bar = el("div", { class: "bar" }, [
      el("div", { class: "title" }, [
        el("span", { class: "name", text: "midas remote" }),
        el("span", { class: "sub", text: state.sessions.length + " session" + (state.sessions.length === 1 ? "" : "s") })
      ]),
      el("button", { class: "logout", text: "lock", onclick: lock })
    ]);
    var list = el("div", { class: "list" });
    if (state.sessions.length === 0) {
      list.appendChild(el("div", { class: "empty", text: "No sessions yet." }));
    }
    state.sessions.forEach(function (session) {
      var meta = (session.directory || "") + " \\u00b7 " + rel(session.updated);
      list.appendChild(el("button", { class: "row", onclick: function () { openSession(session); } }, [
        el("span", { class: "r-title", text: session.title }),
        el("span", { class: "r-meta", text: meta })
      ]));
    });
    clear(root());
    root().appendChild(bar);
    root().appendChild(list);
  }
  function lock() {
    api("/api/logout", { method: "POST", headers: { "X-Midas-Remote": "1" } })
      .catch(function () {})
      .then(function () { showLogin(); });
  }

  /* ---------------- session view ---------------- */
  function openSession(session) {
    state.currentId = session.id;
    state.currentTitle = session.title;
    state.currentDir = session.directory || "";
    state.order = [];
    state.nodes = new Map();
    state.phase = "idle";
    state.permissions = [];
    state.questions = [];
    renderSession();
    connect();
  }
  function renderSession() {
    var status = el("span", { class: "dot " + (state.phase === "idle" ? "idle" : "busy") });
    var bar = el("div", { class: "bar" }, [
      el("button", { class: "back", text: "\\u2190", onclick: showSessions }),
      el("div", { class: "title" }, [
        el("span", { class: "name", text: state.currentTitle || "Session" }),
        el("span", { class: "sub", text: state.phase === "busy" ? "working\\u2026" : state.phase })
      ]),
      status
    ]);
    var stream = el("div", { class: "stream", id: "stream" });
    var cards = el("div", { class: "cards", id: "cards" });
    var input = el("textarea", { id: "input", rows: "1", placeholder: "Message midas\\u2026", enterkeyhint: "send" });
    var send = el("button", { id: "send", text: "Send" });
    var abort = el("button", { class: "abort", text: "Stop", onclick: function () { send_ws({ type: "abort" }); } });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
    });
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 400) + "px";
    });
    send.addEventListener("click", submit);
    var dock = el("div", { class: "dock" }, [input, abort, send]);
    clear(root());
    root().appendChild(bar);
    root().appendChild(stream);
    root().appendChild(cards);
    root().appendChild(dock);
    updateComposer();
  }
  function submit() {
    var input = document.getElementById("input");
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    if (!send_ws({ type: "prompt", text: text })) return;
    input.value = "";
    input.style.height = "auto";
  }
  function updateComposer() {
    var send = document.getElementById("send");
    var abort = document.querySelector(".dock button.abort");
    var busy = state.phase !== "idle";
    if (send) send.disabled = busy || !state.ws;
    if (abort) abort.style.display = busy ? "" : "none";
    var dot = document.querySelector(".bar .dot");
    if (dot) dot.className = "dot " + (busy ? "busy" : "idle");
  }
  function stream() { return document.getElementById("stream"); }
  function atEnd() {
    var node = stream();
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }

  /* ---------------- websocket ---------------- */
  function connect() {
    if (!state.currentId) return;
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/ws");
    state.ws = ws;
    ws.onopen = function () {
      state.reconnect = 0;
      updateComposer();
      ws.send(JSON.stringify({ type: "open", sessionId: state.currentId, directory: state.currentDir }));
    };
    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      handle(data);
    };
    ws.onclose = function () {
      if (state.ws === ws) state.ws = null;
      updateComposer();
      if (!state.currentId) return;
      var delay = Math.min(8000, 500 * Math.pow(2, state.reconnect++));
      state.reconnectTimer = setTimeout(connect, delay);
    };
    ws.onerror = function () {};
  }
  function closeWs() {
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
  }
  function send_ws(payload) {
    if (!state.ws || state.ws.readyState !== 1) return false;
    state.ws.send(JSON.stringify(payload));
    return true;
  }
  function handle(data) {
    if (data.type === "snapshot") {
      state.currentTitle = data.session && data.session.title ? data.session.title : state.currentTitle;
      state.phase = data.phase || "idle";
      state.permissions = data.permissions || [];
      state.questions = data.questions || [];
      state.order = [];
      state.nodes = new Map();
      var node = stream();
      if (node) clear(node);
      (data.messages || []).forEach(upsert);
      renderCards();
      updateBar();
      updateComposer();
      scroll(true);
    } else if (data.type === "message") {
      var stick = atEnd();
      upsert(data.message);
      if (stick) scroll(false);
    } else if (data.type === "remove") {
      removeMessage(data.id);
    } else if (data.type === "session") {
      if (data.session && data.session.title) {
        state.currentTitle = data.session.title;
        var name = document.querySelector(".bar .title .name");
        if (name) name.textContent = state.currentTitle;
      }
    } else if (data.type === "phase") {
      state.phase = data.phase;
      updateBar();
      updateComposer();
    } else if (data.type === "permissions") {
      state.permissions = data.permissions || [];
      renderCards();
    } else if (data.type === "questions") {
      state.questions = data.questions || [];
      renderCards();
    } else if (data.type === "error") {
      appendNotice(data.message, true);
    }
  }
  function scroll(force) {
    var node = stream();
    if (!node) return;
    if (force) node.scrollTop = node.scrollHeight;
    else if (atEnd()) node.scrollTop = node.scrollHeight;
  }
  function updateBar() {
    var sub = document.querySelector(".bar .sub");
    if (sub) sub.textContent = state.phase === "busy" ? "working\\u2026" : state.phase;
  }

  /* ---------------- message rendering ---------------- */
  function upsert(message) {
    if (!message || message.hidden) return;
    var existing = state.nodes.get(message.id);
    var node = renderMessage(message);
    var streamNode = stream();
    if (existing && existing.parentNode === streamNode) streamNode.replaceChild(node, existing);
    else if (streamNode) streamNode.appendChild(node);
    state.nodes.set(message.id, node);
    if (state.order.indexOf(message.id) < 0) state.order.push(message.id);
  }
  function removeMessage(id) {
    var node = state.nodes.get(id);
    if (node && node.parentNode) node.parentNode.removeChild(node);
    state.nodes.delete(id);
    state.order = state.order.filter(function (x) { return x !== id; });
  }
  function appendNotice(text, isError) {
    var node = stream();
    if (!node) return;
    node.appendChild(el("div", { class: isError ? "error" : "notice", text: text }));
    scroll(false);
  }
  function renderMessage(message) {
    var wrap = el("div", { class: "msg " + (message.role === "user" ? "user" : "assistant") });
    if (message.role === "user") {
      var promptText = partsText(message.parts) || "(message)";
      wrap.appendChild(el("div", { class: "who", text: "You" + (message.agent ? " \\u00b7 " + message.agent : "") }));
      wrap.appendChild(el("div", { class: "prompt", text: promptText }));
      return wrap;
    }
    var who = message.agent ? message.agent : "midas";
    if (message.modelID) who += " \\u00b7 " + message.modelID;
    wrap.appendChild(el("div", { class: "who", text: who }));
    if (message.error) {
      wrap.appendChild(el("div", { class: "error", text: message.error }));
    }
    (message.parts || []).forEach(function (part) {
      if (part && part.kind === "text" && !part.text) return;
      var node = renderPart(part);
      if (node) wrap.appendChild(node);
    });
    if (message.notice && (!message.parts || message.parts.length === 0)) {
      wrap.appendChild(el("div", { class: "notice", text: partsText(message.parts) }));
    }
    return wrap;
  }
  function partsText(parts) {
    return (parts || []).filter(function (p) { return p.kind === "text"; }).map(function (p) { return p.text || ""; }).join("");
  }
  function renderPart(part) {
    if (!part) return null;
    if (part.kind === "text") {
      if (!part.text) return null;
      return el("div", { class: "text", text: part.text });
    }
    if (part.kind === "reasoning") {
      if (!part.text) return null;
      return el("details", { class: "reason" }, [
        el("summary", { text: "thinking" }),
        el("div", { class: "body", text: part.text })
      ]);
    }
    if (part.kind === "tool") {
      var details = el("details", { class: "tool" });
      details.appendChild(el("summary", {}, [
        el("span", { class: "nm", text: part.tool || "tool" }),
        el("span", { class: "st " + (part.status || "pending"), text: "[" + (part.title || part.status || "") + "]" })
      ]));
      if (part.input) details.appendChild(el("pre", { text: part.input }));
      if (part.output) details.appendChild(el("pre", { text: part.output }));
      if (part.error) details.appendChild(el("pre", { text: part.error }));
      return details;
    }
    if (part.kind === "bash") {
      var cls = "tool bash" + (part.status === "error" ? " err" : "");
      var bash = el("details", { class: cls });
      bash.appendChild(el("summary", {}, [
        el("span", { class: "nm", text: "$ " + (part.command || "") }),
        el("span", { class: "st " + (part.status === "complete" ? "completed" : part.status), text: "[" + part.status + "]" })
      ]));
      if (part.output) bash.appendChild(el("pre", { text: part.output }));
      return bash;
    }
    return null;
  }

  /* ---------------- permission / question cards ---------------- */
  function renderCards() {
    var host = document.getElementById("cards");
    if (!host) return;
    clear(host);
    state.permissions.forEach(function (permission) {
      var title = permission.title || permission.type || permission.permission || "Permission";
      var pattern = permission.pattern;
      if (pattern && typeof pattern !== "string") pattern = pattern.join(", ");
      var card = el("div", { class: "card" }, [
        el("div", { class: "q", text: "Permission: " + title + (pattern ? "\\n" + pattern : "") }),
        el("div", { class: "btns" }, [
          button("Allow once", "ok", function () { respond(permission.id, "once"); }),
          button("Always", "", function () { respond(permission.id, "always"); }),
          button("Reject", "no", function () { respond(permission.id, "reject"); })
        ])
      ]);
      host.appendChild(card);
    });
    state.questions.forEach(function (question) {
      (question.questions || []).forEach(function (prompt) {
        var btns = el("div", { class: "btns" });
        (prompt.options || []).forEach(function (option) {
          btns.appendChild(button(option.label, "", function () {
            send_ws({ type: "question", id: question.id, answers: [[option.label]] });
          }));
        });
        btns.appendChild(button("Dismiss", "no", function () {
          send_ws({ type: "questionReject", id: question.id });
        }));
        host.appendChild(el("div", { class: "card" }, [
          el("div", { class: "q", text: (prompt.header ? prompt.header + "\\n" : "") + prompt.question }),
          btns
        ]));
      });
    });
  }
  function button(label, cls, onclick) {
    return el("button", { class: cls, text: label, onclick: onclick });
  }
  function respond(id, response) {
    send_ws({ type: "permission", id: id, response: response });
  }

  /* ---------------- boot ---------------- */
  api("/api/sessions").then(function () { showSessions(); }).catch(function () {});
})();
`;
