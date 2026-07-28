"use strict";

/* ============================================================
   PortaSSH frontend
   - Reads the session token from the URL fragment (#<token>),
     so it never lands in server logs or history as a query.
   - Talks to the local Go API for vault + credential ops.
   - Opens one websocket-backed xterm.js session per tab.
   ============================================================ */

const TOKEN = location.hash.slice(1);
const ACCENTS = ["#6ea8fe", "#8b7cf6", "#4ade80", "#fbbf24", "#f472b6", "#22d3ee", "#f87171"];

const state = {
  creds: [],
  sessions: new Map(), // tabId -> { term, fit, socket, cred, el, tabEl }
  activeTab: null,
  editingColor: ACCENTS[0],
};

/* ---------------- API helper ---------------- */
async function api(path, opts = {}) {
  const headers = Object.assign({ "X-PortaSSH-Token": TOKEN }, opts.headers || {});
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

const $ = (id) => document.getElementById(id);

/* ============================================================
   LOCK SCREEN
   ============================================================ */
let vaultExists = false;

async function initLock() {
  const status = await api("/api/vault/status");
  vaultExists = status.exists;
  $("vault-path").textContent = status.path;

  if (status.unlocked) return showApp();

  const label = $("lock-label");
  const submit = $("lock-submit");
  const confirm = $("master2");
  if (!vaultExists) {
    label.textContent = "Create a master password";
    submit.textContent = "Create vault";
    confirm.style.display = "block";
  } else {
    label.textContent = "Master password";
    submit.textContent = "Unlock";
    confirm.style.display = "none";
  }
}

$("pw-toggle").addEventListener("click", () => {
  const el = $("master");
  el.type = el.type === "password" ? "text" : "password";
});

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("master").value;
  const err = $("lock-error");
  err.textContent = "";
  try {
    if (!vaultExists) {
      if (pw.length < 6) throw new Error("Use at least 6 characters.");
      if (pw !== $("master2").value) throw new Error("Passwords do not match.");
      await api("/api/vault/create", { method: "POST", body: JSON.stringify({ password: pw }) });
    } else {
      await api("/api/vault/unlock", { method: "POST", body: JSON.stringify({ password: pw }) });
    }
    $("master").value = ""; $("master2").value = "";
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    $("master").select();
  }
});

/* ============================================================
   APP SHELL
   ============================================================ */
async function showApp() {
  $("lock").classList.add("hidden");
  $("app").classList.remove("hidden");
  await loadCreds();
}

$("btn-lock").addEventListener("click", async () => {
  // Close all live sessions first.
  for (const id of [...state.sessions.keys()]) closeTab(id, true);
  await api("/api/vault/lock", { method: "POST" });
  $("app").classList.add("hidden");
  $("lock").classList.remove("hidden");
  await initLock();
  $("master").focus();
});

/* ============================================================
   CREDENTIAL LIST
   ============================================================ */
async function loadCreds() {
  state.creds = await api("/api/creds");
  renderCreds();
}

function renderCreds() {
  const q = $("search").value.trim().toLowerCase();
  const list = $("cred-list");
  list.innerHTML = "";

  const filtered = state.creds.filter((c) =>
    !q || c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q) ||
    (c.user || "").toLowerCase().includes(q)
  );

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cred-empty";
    empty.textContent = state.creds.length === 0
      ? "No connections yet.\nPress ＋ to add your first host."
      : "No matches.";
    empty.style.whiteSpace = "pre-line";
    list.appendChild(empty);
    return;
  }

  for (const c of filtered) {
    const el = document.createElement("div");
    el.className = "cred";
    const accent = c.color || ACCENTS[0];
    el.style.setProperty("--accent", accent);
    el.innerHTML = `
      <div class="cred-name">${esc(c.name)}</div>
      <div class="cred-sub">${esc(c.user)}@${esc(c.host)}:${c.port} · ${c.auth === "key" ? "🔑 key" : "🔒 password"}</div>
      <button class="cred-edit">edit</button>`;
    el.querySelector(".cred-edit").addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEditor(c);
    });
    el.addEventListener("click", () => openSession(c));
    // paint the left bar via the ::before which reads --accent
    el.style.setProperty("--accent", accent);
    list.appendChild(el);
  }
}

$("search").addEventListener("input", renderCreds);

/* ============================================================
   CREDENTIAL EDITOR MODAL
   ============================================================ */
function openEditor(cred) {
  const isEdit = !!cred;
  $("modal-title").textContent = isEdit ? "Edit connection" : "New connection";
  $("c-id").value = cred ? cred.id : "";
  $("c-name").value = cred ? cred.name : "";
  $("c-host").value = cred ? cred.host : "";
  $("c-port").value = cred ? cred.port : 22;
  $("c-user").value = cred ? cred.user : "";
  $("c-auth").value = cred ? cred.auth : "password";
  $("c-password").value = "";
  $("c-key").value = "";
  $("c-passphrase").value = "";
  $("pw-hint").textContent = isEdit ? "(leave blank to keep current)" : "";
  $("key-hint").textContent = isEdit ? "(leave blank to keep current)" : "";
  $("modal-error").textContent = "";
  $("btn-delete").classList.toggle("hidden", !isEdit);
  state.editingColor = (cred && cred.color) || ACCENTS[0];
  renderSwatches();
  syncAuthFields();
  $("modal").classList.remove("hidden");
  $("c-name").focus();
}

function renderSwatches() {
  const row = $("color-row");
  row.innerHTML = "";
  for (const c of ACCENTS) {
    const s = document.createElement("div");
    s.className = "swatch" + (c === state.editingColor ? " selected" : "");
    s.style.background = c;
    s.addEventListener("click", () => { state.editingColor = c; renderSwatches(); });
    row.appendChild(s);
  }
}

function syncAuthFields() {
  const method = $("c-auth").value;
  document.querySelectorAll("[data-auth]").forEach((el) => {
    el.classList.toggle("hidden", el.getAttribute("data-auth") !== method);
  });
}
$("c-auth").addEventListener("change", syncAuthFields);

$("btn-add").addEventListener("click", () => openEditor(null));
$("btn-cancel").addEventListener("click", closeEditor);
function closeEditor() { $("modal").classList.add("hidden"); }

$("cred-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("modal-error");
  err.textContent = "";
  const payload = {
    id: $("c-id").value || "",
    name: $("c-name").value.trim(),
    host: $("c-host").value.trim(),
    port: parseInt($("c-port").value, 10) || 22,
    user: $("c-user").value.trim(),
    auth: $("c-auth").value,
    password: $("c-password").value,
    privateKey: $("c-key").value,
    passphrase: $("c-passphrase").value,
    color: state.editingColor,
  };
  try {
    await api("/api/creds", { method: "POST", body: JSON.stringify(payload) });
    closeEditor();
    await loadCreds();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$("btn-delete").addEventListener("click", async () => {
  const id = $("c-id").value;
  if (!id) return;
  if (!confirm("Delete this connection permanently?")) return;
  try {
    await api("/api/creds/" + encodeURIComponent(id), { method: "DELETE" });
    closeEditor();
    await loadCreds();
  } catch (ex) {
    $("modal-error").textContent = ex.message;
  }
});

/* ============================================================
   CHANGE MASTER PASSWORD
   ============================================================ */
$("btn-change-pw").addEventListener("click", () => {
  $("pw-current").value = ""; $("pw-next").value = ""; $("pw-confirm").value = "";
  $("pw-error").textContent = "";
  $("pw-modal").classList.remove("hidden");
});
$("pw-cancel").addEventListener("click", () => $("pw-modal").classList.add("hidden"));
$("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("pw-error");
  err.textContent = "";
  if ($("pw-next").value !== $("pw-confirm").value) { err.textContent = "New passwords do not match."; return; }
  if ($("pw-next").value.length < 6) { err.textContent = "Use at least 6 characters."; return; }
  try {
    await api("/api/vault/password", {
      method: "POST",
      body: JSON.stringify({ current: $("pw-current").value, next: $("pw-next").value }),
    });
    $("pw-modal").classList.add("hidden");
  } catch (ex) {
    err.textContent = ex.message;
  }
});

/* ============================================================
   TERMINAL SESSIONS (tabs)
   ============================================================ */
const XTERM_THEMES = {
  dark: {
    background: "#000000", foreground: "#e6e9f0", cursor: "#6ea8fe",
    cursorAccent: "#000000", selectionBackground: "#33415580",
    black: "#151926", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
    blue: "#6ea8fe", magenta: "#8b7cf6", cyan: "#22d3ee", white: "#e6e9f0",
    brightBlack: "#5c6479", brightRed: "#fca5a5", brightGreen: "#86efac",
    brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9", brightWhite: "#ffffff",
  },
  light: {
    background: "#fbfbfe", foreground: "#1a1e29", cursor: "#2563eb",
    cursorAccent: "#ffffff", selectionBackground: "#2563eb33",
    black: "#1a1e29", red: "#dc2626", green: "#16a34a", yellow: "#b45309",
    blue: "#2563eb", magenta: "#7c3aed", cyan: "#0891b2", white: "#4b5163",
    brightBlack: "#97a0b2", brightRed: "#ef4444", brightGreen: "#22c55e",
    brightYellow: "#d97706", brightBlue: "#3b82f6", brightMagenta: "#8b5cf6",
    brightCyan: "#06b6d4", brightWhite: "#1a1e29",
  },
};
function xtermTheme() {
  return XTERM_THEMES[effectiveTheme()] || XTERM_THEMES.dark;
}

let tabCounter = 0;

function openSession(cred) {
  const tabId = "t" + (++tabCounter);
  $("empty-state").classList.add("hidden");

  // Tab button
  const tabEl = document.createElement("div");
  tabEl.className = "tab active";
  tabEl.innerHTML = `<span class="dot"></span><span class="name">${esc(cred.name)}</span><span class="close">×</span>`;
  tabEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("close")) { closeTab(tabId); return; }
    activateTab(tabId);
  });
  $("tabs").appendChild(tabEl);

  // Terminal pane
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);

  const fs = fontSettings();
  const term = new Terminal({
    fontFamily: fontStack(fs.font),
    fontSize: fs.size,
    lineHeight: fs.lineHeight,
    cursorBlink: true,
    theme: xtermTheme(),
    allowProposedApi: true,
    scrollback: 10000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
  term.open(pane);
  fit.fit();

  const session = { term, fit, cred, el: pane, tabEl, socket: null };
  state.sessions.set(tabId, session);
  activateTab(tabId);

  term.writeln(`\x1b[38;5;75m╭─ PortaSSH\x1b[0m connecting to \x1b[1m${cred.user}@${cred.host}:${cred.port}\x1b[0m …`);

  connectSocket(tabId);

  term.onData((d) => {
    const s = state.sessions.get(tabId);
    if (s && s.socket && s.socket.readyState === WebSocket.OPEN) {
      s.socket.send(JSON.stringify({ type: "data", data: d }));
    }
  });
  term.onResize(({ cols, rows }) => {
    const s = state.sessions.get(tabId);
    if (s && s.socket && s.socket.readyState === WebSocket.OPEN) {
      s.socket.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });
}

function connectSocket(tabId) {
  const s = state.sessions.get(tabId);
  if (!s) return;
  const { term, fit, cred } = s;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/api/ws?token=${encodeURIComponent(TOKEN)}` +
    `&id=${encodeURIComponent(cred.id)}&cols=${term.cols}&rows=${term.rows}`;
  const socket = new WebSocket(url);
  s.socket = socket;

  socket.onopen = () => {
    s.tabEl.classList.add("connected");
  };
  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "data": term.write(msg.data); break;
      case "error":
        term.writeln(`\r\n\x1b[31m✖ ${msg.data}\x1b[0m`);
        s.tabEl.classList.remove("connected");
        break;
      case "status":
        term.writeln(`\r\n\x1b[38;5;244m╰─ ${msg.data}\x1b[0m`);
        s.tabEl.classList.remove("connected");
        break;
    }
  };
  socket.onclose = () => {
    s.tabEl.classList.remove("connected");
  };
}

function activateTab(tabId) {
  state.activeTab = tabId;
  for (const [id, s] of state.sessions) {
    const on = id === tabId;
    s.tabEl.classList.toggle("active", on);
    s.el.style.display = on ? "block" : "none";
    if (on) {
      requestAnimationFrame(() => { s.fit.fit(); s.term.focus(); });
    }
  }
}

function closeTab(tabId, silent) {
  const s = state.sessions.get(tabId);
  if (!s) return;
  try { if (s.socket) s.socket.close(); } catch {}
  try { s.term.dispose(); } catch {}
  s.el.remove();
  s.tabEl.remove();
  state.sessions.delete(tabId);

  if (state.activeTab === tabId) {
    const next = [...state.sessions.keys()].pop();
    if (next) activateTab(next);
    else { state.activeTab = null; if (!silent) $("empty-state").classList.remove("hidden"); }
  }
  if (state.sessions.size === 0) $("empty-state").classList.remove("hidden");
}

window.addEventListener("resize", () => {
  const s = state.sessions.get(state.activeTab);
  if (s) s.fit.fit();
});

/* ============================================================
   THEME  (system-aware, with manual override persisted on the stick)
   pref ∈ {"system","light","dark"} stored in localStorage.
   ============================================================ */
const THEME_KEY = "portassh-theme";
const systemLight = window.matchMedia("(prefers-color-scheme: light)");

function themePref() { return localStorage.getItem(THEME_KEY) || "system"; }
function effectiveTheme() {
  const p = themePref();
  if (p === "light" || p === "dark") return p;
  return systemLight.matches ? "light" : "dark";
}
function applyTheme() {
  const p = themePref();
  const root = document.documentElement;
  if (p === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p);

  const icon = p === "light" ? "☀️" : p === "dark" ? "🌙" : "🖥️";
  const title = "Theme: " + (p === "system" ? "follow system" : p) + " (click to change)";
  for (const id of ["btn-theme", "btn-theme-lock"]) {
    const el = $(id);
    if (el) { el.textContent = icon; el.title = title; }
  }
  // Live-update any open terminals.
  const t = xtermTheme();
  for (const s of state.sessions.values()) {
    try { s.term.options.theme = t; s.fit.fit(); } catch {}
  }
}
function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(themePref()) + 1) % order.length];
  if (next === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, next);
  applyTheme();
}
function initTheme() {
  applyTheme();
  systemLight.addEventListener("change", () => { if (themePref() === "system") applyTheme(); });
  $("btn-theme").addEventListener("click", cycleTheme);
  $("btn-theme-lock").addEventListener("click", cycleTheme);
}

/* ============================================================
   FONTS & SETTINGS  (terminal font / size / line-height)
   Persisted in localStorage, which lives in the browser profile
   on the stick — so your look travels with you.
   ============================================================ */
const FONTS = [
  { id: "jetbrains", label: "JetBrains Mono",  stack: '"JetBrains Mono", monospace' },
  { id: "fira",      label: "Fira Code",       stack: '"Fira Code", monospace' },
  { id: "cascadia",  label: "Cascadia Code",   stack: '"Cascadia Code", monospace' },
  { id: "plex",      label: "IBM Plex Mono",   stack: '"IBM Plex Mono", monospace' },
  { id: "source",    label: "Source Code Pro", stack: '"Source Code Pro", monospace' },
  { id: "roboto",    label: "Roboto Mono",     stack: '"Roboto Mono", monospace' },
  { id: "system",    label: "System monospace", stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
];
const FONT_DEFAULTS = { font: "jetbrains", size: 13.5, lineHeight: 1.15 };

function fontSettings() {
  return {
    font: localStorage.getItem("portassh-font") || FONT_DEFAULTS.font,
    size: parseFloat(localStorage.getItem("portassh-fontsize")) || FONT_DEFAULTS.size,
    lineHeight: parseFloat(localStorage.getItem("portassh-lineheight")) || FONT_DEFAULTS.lineHeight,
  };
}
function fontStack(id) { return (FONTS.find((f) => f.id === id) || FONTS[0]).stack; }

// applyFont pushes the current font settings to every open terminal, live.
function applyFont() {
  const s = fontSettings();
  const stack = fontStack(s.font);
  for (const sess of state.sessions.values()) {
    try {
      sess.term.options.fontFamily = stack;
      sess.term.options.fontSize = s.size;
      sess.term.options.lineHeight = s.lineHeight;
      sess.fit.fit();
    } catch {}
  }
}

function openSettings() {
  const sel = $("set-font");
  sel.innerHTML = "";
  const s = fontSettings();
  for (const f of FONTS) {
    const o = document.createElement("option");
    o.value = f.id; o.textContent = f.label;
    if (f.id === s.font) o.selected = true;
    sel.appendChild(o);
  }
  $("set-size").value = s.size;
  $("set-lh").value = s.lineHeight;
  refreshSettingsPreview();
  $("settings").classList.remove("hidden");
}

function refreshSettingsPreview() {
  const font = $("set-font").value;
  const size = parseFloat($("set-size").value);
  const lh = parseFloat($("set-lh").value);
  $("set-size-val").textContent = size + "px";
  $("set-lh-val").textContent = lh.toFixed(2);
  const prev = $("set-preview");
  prev.style.setProperty("--preview-font", fontStack(font));
  prev.style.setProperty("--preview-size", size + "px");
  prev.style.setProperty("--preview-lh", lh);
}

function saveSettingsFromUI() {
  localStorage.setItem("portassh-font", $("set-font").value);
  localStorage.setItem("portassh-fontsize", $("set-size").value);
  localStorage.setItem("portassh-lineheight", $("set-lh").value);
  refreshSettingsPreview();
  applyFont();
}

function initSettings() {
  $("btn-settings").addEventListener("click", openSettings);
  $("set-close").addEventListener("click", () => $("settings").classList.add("hidden"));
  for (const id of ["set-font", "set-size", "set-lh"]) {
    $(id).addEventListener("input", saveSettingsFromUI);
  }
  $("set-reset").addEventListener("click", () => {
    localStorage.removeItem("portassh-font");
    localStorage.removeItem("portassh-fontsize");
    localStorage.removeItem("portassh-lineheight");
    openSettings();
    applyFont();
  });
}

/* ============================================================
   KEYBOARD SHORTCUTS
   Platform-aware so we never clobber the terminal's own keys:
   on macOS the modifier is ⌘ (the shell uses Ctrl, ⌘ is free);
   elsewhere it's Ctrl+Shift (leaving plain Ctrl+letters for readline),
   with Alt+digit for tab jumps.
   ============================================================ */
const IS_MAC = (() => {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  return /mac|iphone|ipad/i.test(p);
})();

// comboKey matches "the app modifier + <code>", e.g. code "KeyK", "Backslash".
function comboKey(e, code) {
  if (e.altKey) return false;
  return IS_MAC
    ? (e.metaKey && !e.ctrlKey && e.code === code)
    : (e.ctrlKey && e.shiftKey && e.code === code);
}
function comboShiftKey(e, code) { // modifier + Shift + code (for [ ] brackets)
  return IS_MAC
    ? (e.metaKey && e.shiftKey && e.code === code)
    : (e.ctrlKey && e.shiftKey && e.code === code);
}
function comboDigit(e, n) {
  const code = "Digit" + n;
  return IS_MAC
    ? (e.metaKey && !e.ctrlKey && !e.altKey && e.code === code)
    : (e.altKey && !e.ctrlKey && !e.shiftKey && e.code === code);
}

function kb(macKeys, otherKeys) { return IS_MAC ? macKeys : otherKeys; }
const SHORTCUTS = [
  ["Command palette · connect", kb(["⌘", "K"], ["Ctrl", "⇧", "K"])],
  ["New connection", kb(["⌘", "E"], ["Ctrl", "⇧", "E"])],
  ["Next tab", kb(["⌘", "⇧", "]"], ["Ctrl", "⇧", "]"])],
  ["Previous tab", kb(["⌘", "⇧", "["], ["Ctrl", "⇧", "["])],
  ["Jump to tab 1–9", kb(["⌘", "1…9"], ["Alt", "1…9"])],
  ["Close current tab", kb(["⌘", "⌫"], ["Ctrl", "⇧", "⌫"])],
  ["Lock vault", kb(["⌘", "L"], ["Ctrl", "⇧", "L"])],
  ["Toggle theme", kb(["⌘", "\\"], ["Ctrl", "⇧", "\\"])],
  ["Settings", kb(["⌘", ","], ["Ctrl", "⇧", ","])],
  ["Show this help", kb(["⌘", "/"], ["F1"])],
];

function tabOrder() { return [...state.sessions.keys()]; }
function shiftTab(delta) {
  const order = tabOrder();
  if (order.length === 0) return;
  let i = order.indexOf(state.activeTab);
  if (i < 0) i = 0;
  const next = order[(i + delta + order.length) % order.length];
  activateTab(next);
}
function gotoTabIndex(idx) {
  const order = tabOrder();
  if (idx >= 0 && idx < order.length) activateTab(order[idx]);
}

function appVisible() { return !$("app").classList.contains("hidden"); }

function handleGlobalKey(e) {
  // Escape closes the top-most overlay from anywhere.
  if (e.key === "Escape" && closeTopOverlay()) { e.preventDefault(); return; }

  // While the palette is open, it owns navigation keys.
  if (isPaletteOpen() && handlePaletteKey(e)) return;

  if (!appVisible()) return; // shortcuts only once unlocked

  const fire = (fn) => { e.preventDefault(); e.stopImmediatePropagation(); fn(); };

  if (comboKey(e, "KeyK")) return fire(openPalette);
  if (comboKey(e, "KeyE")) return fire(() => openEditor(null));
  if (comboKey(e, "KeyL")) return fire(() => $("btn-lock").click());
  if (comboKey(e, "Backslash")) return fire(cycleTheme);
  if (comboKey(e, "Comma")) return fire(openSettings);
  if (comboKey(e, "Slash") || e.code === "F1") return fire(openHelp);
  if (comboKey(e, "Backspace")) return fire(() => { if (state.activeTab) closeTab(state.activeTab); });
  if (comboShiftKey(e, "BracketRight")) return fire(() => shiftTab(1));
  if (comboShiftKey(e, "BracketLeft")) return fire(() => shiftTab(-1));
  for (let n = 1; n <= 9; n++) {
    if (comboDigit(e, n)) return fire(() => gotoTabIndex(n - 1));
  }
}

function initShortcuts() {
  window.addEventListener("keydown", handleGlobalKey, true);
  $("btn-help").addEventListener("click", openHelp);
  $("help-close").addEventListener("click", () => $("help").classList.add("hidden"));
  $("palette-input").addEventListener("input", renderPalette);
  // Reflect the real palette key in the sidebar hint.
  $("palette-hint").textContent = IS_MAC ? "⌘K" : "Ctrl⇧K";
}

function closeTopOverlay() {
  for (const id of ["palette", "help", "settings", "pw-modal", "modal"]) {
    const el = $(id);
    if (el && !el.classList.contains("hidden")) { el.classList.add("hidden"); return true; }
  }
  return false;
}

/* ---------------- Command palette ---------------- */
let paletteItems = []; // flat list currently rendered
let paletteActive = 0;

function isPaletteOpen() { return !$("palette").classList.contains("hidden"); }

function openPalette() {
  $("palette-input").value = "";
  paletteActive = 0;
  renderPalette();
  $("palette").classList.remove("hidden");
  $("palette-input").focus();
}

function buildPaletteItems(query) {
  const q = query.trim().toLowerCase();
  const match = (s) => !q || s.toLowerCase().includes(q);

  const hosts = state.creds
    .filter((c) => match(c.name) || match(c.host) || match(c.user))
    .map((c) => ({
      kind: "connect",
      title: c.name,
      sub: `${c.user}@${c.host}:${c.port}`,
      color: c.color || ACCENTS[0],
      letter: (c.name || "?").trim().charAt(0).toUpperCase(),
      run: () => { closePalette(); openSession(c); },
    }));

  const commands = [
    { kind: "command", icon: "＋", title: "New connection…", sub: "Add a saved host", run: () => { closePalette(); openEditor(null); } },
    { kind: "command", icon: "🎨", title: "Toggle theme", sub: "System · Light · Dark", run: () => { cycleTheme(); } },
    { kind: "command", icon: "⚙️", title: "Settings", sub: "Terminal font, size, spacing", run: () => { closePalette(); openSettings(); } },
    { kind: "command", icon: "🔒", title: "Lock vault", sub: "Wipe keys from memory", run: () => { closePalette(); $("btn-lock").click(); } },
    { kind: "command", icon: "⌨︎", title: "Keyboard shortcuts", sub: "", run: () => { closePalette(); openHelp(); } },
  ].filter((c) => match(c.title));

  return hosts.concat(commands);
}

function renderPalette() {
  const list = $("palette-list");
  paletteItems = buildPaletteItems($("palette-input").value);
  if (paletteActive >= paletteItems.length) paletteActive = Math.max(0, paletteItems.length - 1);
  list.innerHTML = "";

  if (paletteItems.length === 0) {
    list.innerHTML = `<div class="palette-empty">No matches</div>`;
    return;
  }
  paletteItems.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "palette-item" + (i === paletteActive ? " active" : "");
    const icon = it.kind === "connect"
      ? `<div class="pi-icon host" style="background:${it.color}">${esc(it.letter)}</div>`
      : `<div class="pi-icon">${it.icon}</div>`;
    el.innerHTML = `${icon}
      <div class="pi-main">
        <div class="pi-title">${esc(it.title)}</div>
        ${it.sub ? `<div class="pi-sub">${esc(it.sub)}</div>` : ""}
      </div>
      <div class="pi-tag">${it.kind === "connect" ? "connect" : "command"}</div>`;
    el.addEventListener("mousemove", () => { if (paletteActive !== i) { paletteActive = i; paintPaletteActive(); } });
    el.addEventListener("click", () => it.run());
    list.appendChild(el);
  });
}

function paintPaletteActive() {
  const nodes = $("palette-list").children;
  for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle("active", i === paletteActive);
  if (nodes[paletteActive]) nodes[paletteActive].scrollIntoView({ block: "nearest" });
}

function handlePaletteKey(e) {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      paletteActive = Math.min(paletteItems.length - 1, paletteActive + 1); paintPaletteActive(); return true;
    case "ArrowUp":
      e.preventDefault();
      paletteActive = Math.max(0, paletteActive - 1); paintPaletteActive(); return true;
    case "Enter":
      e.preventDefault();
      if (paletteItems[paletteActive]) paletteItems[paletteActive].run(); return true;
    default:
      return false; // let the input receive typing
  }
}
function closePalette() { $("palette").classList.add("hidden"); }

/* ---------------- Help overlay ---------------- */
function openHelp() {
  const grid = $("help-grid");
  grid.innerHTML = "";
  for (const [label, keys] of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "help-row";
    row.innerHTML = `<span class="hr-label">${esc(label)}</span>
      <span class="hr-keys">${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>`;
    grid.appendChild(row);
  }
  $("help").classList.remove("hidden");
}

/* ---------------- util ---------------- */
function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ---------------- boot ---------------- */
initTheme();
initSettings();
initShortcuts();
initLock().catch((e) => {
  $("lock-error").textContent = "Failed to reach PortaSSH backend: " + e.message;
});
