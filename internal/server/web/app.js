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
  editingTags: [],            // chips in the open editor
  tagFilter: new Set(),       // lowercased; a host must carry all of them
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
  renderTagFilter();
  list.innerHTML = "";

  const filtered = state.creds.filter((c) => matchesTags(c) && matchesQuery(c, q));

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

  // Reordering only makes sense over the full, unfiltered list.
  const canReorder = !q && state.tagFilter.size === 0;

  for (const c of filtered) {
    const el = document.createElement("div");
    el.className = "cred";
    el.dataset.credId = c.id;
    const accent = c.color || ACCENTS[0];
    el.style.setProperty("--accent", accent);
    el.innerHTML = `
      <div class="cred-name"><span class="cred-label">${esc(c.name)}</span><span class="cred-live hidden" title="Session open"></span></div>
      <div class="cred-sub"><span>${esc(c.user)}@</span><span class="sub-host"></span><span>:${c.port}</span><span class="sub-auth"> · ${c.auth === "key" ? "🔑 key" : "🔒 password"}</span></div>
      <div class="cred-actions">
        <div class="cred-tags">${
          tagsOf(c).map((t) => `<span class="tag-chip static">${esc(t)}</span>`).join("")
        }</div>
        ${canReorder ? `<div class="cred-move">
          <button class="cred-arrow" data-dir="up" title="Move up">▲</button>
          <button class="cred-arrow" data-dir="down" title="Move down">▼</button>
        </div>` : ""}
        <button class="cred-new" title="Open a new session (${NEWSESSION_HINT}-click)">＋</button>
        <button class="cred-edit">edit</button>
      </div>`;
    el.querySelector(".cred-label").dataset.full = c.name;
    // Only the host may be elided, and it is measured against the whole line.
    const hostEl = el.querySelector(".sub-host");
    hostEl.dataset.full = c.host;
    hostEl.dataset.fitBox = "parent";
    el.querySelector(".cred-new").addEventListener("click", (ev) => {
      ev.stopPropagation();
      openSession(c);
    });
    el.querySelector(".cred-edit").addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEditor(c);
    });
    if (canReorder) {
      el.querySelectorAll(".cred-arrow").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          moveCred(c.id, btn.dataset.dir);
        });
      });
    }
    // Plain click reuses the session we already have; modifier-click (or the
    // hover ＋) forces a second one.
    el.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey) openSession(c);
      else focusOrOpen(c);
    });
    list.appendChild(el);
  }

  highlightActiveCred();
  fitLabels();
}

/* ============================================================
   TAGS
   Free-form labels on a host, replacing folders: a host can carry
   several, and selecting more than one narrows the list rather than
   widening it (work + project1 = hosts that are both).
   ============================================================ */

// tagsOf returns a credential's tags, tolerating older entries without any.
function tagsOf(c) { return Array.isArray(c.tags) ? c.tags : []; }

// allTags lists every tag in use, once per spelling, alphabetically.
function allTags() {
  const seen = new Map(); // lowercased -> first spelling seen
  for (const c of state.creds) {
    for (const t of tagsOf(c)) {
      const k = t.toLowerCase();
      if (!seen.has(k)) seen.set(k, t);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// matchesTags is true when the host carries every selected tag.
function matchesTags(c) {
  if (state.tagFilter.size === 0) return true;
  const own = new Set(tagsOf(c).map((t) => t.toLowerCase()));
  for (const t of state.tagFilter) if (!own.has(t)) return false;
  return true;
}

// matchesQuery searches name, host, user and tags.
function matchesQuery(c, q) {
  if (!q) return true;
  return c.name.toLowerCase().includes(q) ||
    c.host.toLowerCase().includes(q) ||
    (c.user || "").toLowerCase().includes(q) ||
    tagsOf(c).some((t) => t.toLowerCase().includes(q));
}

// renderTagFilter draws the chip row. It stays hidden until at least one host
// is tagged, so nothing changes for anyone not using tags.
function renderTagFilter() {
  const row = $("tag-filter");
  const tags = allTags();
  const known = new Set(tags.map((t) => t.toLowerCase()));

  // A tag can vanish when its last host is edited or deleted.
  for (const t of [...state.tagFilter]) if (!known.has(t)) state.tagFilter.delete(t);

  row.classList.toggle("hidden", tags.length === 0);
  row.innerHTML = "";
  if (tags.length === 0) return;

  for (const t of tags) {
    const on = state.tagFilter.has(t.toLowerCase());
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip" + (on ? " on" : "");
    chip.textContent = t;
    chip.title = on ? `Stop filtering by ${t}` : `Show only hosts tagged ${t}`;
    chip.addEventListener("click", () => {
      const k = t.toLowerCase();
      if (state.tagFilter.has(k)) state.tagFilter.delete(k); else state.tagFilter.add(k);
      renderCreds();
    });
    row.appendChild(chip);
  }

  if (state.tagFilter.size) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tag-chip clear";
    clear.textContent = "clear";
    clear.title = "Show every host again";
    clear.addEventListener("click", () => { state.tagFilter.clear(); renderCreds(); });
    row.appendChild(clear);
  }
}

/* ---- tag chips inside the editor ---- */

// addEditingTag keeps one spelling per tag: if the tag already exists
// elsewhere, reuse that spelling so "Work" and "work" stay one tag.
function addEditingTag(raw) {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return;
  const k = t.toLowerCase();
  if (state.editingTags.some((x) => x.toLowerCase() === k)) return;
  const existing = allTags().find((x) => x.toLowerCase() === k);
  state.editingTags.push(existing || t);
  renderEditingTags();
}

function removeEditingTag(tag) {
  state.editingTags = state.editingTags.filter((t) => t !== tag);
  renderEditingTags();
}

function renderEditingTags() {
  const box = $("tag-edit");
  const input = $("c-tags");
  for (const chip of [...box.querySelectorAll(".tag-chip")]) chip.remove();
  for (const t of state.editingTags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip on";
    chip.innerHTML = `${esc(t)}<button type="button" class="tag-x" title="Remove">×</button>`;
    chip.querySelector(".tag-x").addEventListener("click", () => removeEditingTag(t));
    box.insertBefore(chip, input);
  }

  // Offer the tags already in use that this host does not carry yet.
  const used = new Set(state.editingTags.map((t) => t.toLowerCase()));
  const suggest = $("tag-suggest");
  suggest.innerHTML = "";
  const rest = allTags().filter((t) => !used.has(t.toLowerCase()));
  suggest.classList.toggle("hidden", rest.length === 0);
  for (const t of rest) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip ghost-chip";
    chip.textContent = t;
    chip.title = `Add ${t}`;
    chip.addEventListener("click", () => addEditingTag(t));
    suggest.appendChild(chip);
  }
}

function initTagInput() {
  const input = $("c-tags");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();          // Enter must not submit the form
      addEditingTag(input.value);
      input.value = "";
    } else if (e.key === "Backspace" && input.value === "" && state.editingTags.length) {
      removeEditingTag(state.editingTags[state.editingTags.length - 1]);
    }
  });
  // Commit whatever is typed when focus leaves, so a half-typed tag is not lost.
  input.addEventListener("blur", () => { addEditingTag(input.value); input.value = ""; });
  $("tag-edit").addEventListener("click", (e) => { if (e.target.id !== "c-tags") input.focus(); });
}

// tabsForCred lists the open tab ids running a given host, in tab order.
function tabsForCred(id) {
  return [...state.sessions.entries()].filter(([, s]) => s.cred.id === id).map(([tabId]) => tabId);
}

// focusOrOpen brings an existing session for this host to the front instead of
// dialling a second one. Repeated clicks cycle through that host's tabs.
function focusOrOpen(cred) {
  const tabs = tabsForCred(cred.id);
  if (tabs.length === 0) { openSession(cred); return; }
  const i = tabs.indexOf(state.activeTab);
  activateTab(i === -1 ? tabs[0] : tabs[(i + 1) % tabs.length]);
}

// highlightActiveCred marks the sidebar host that owns the focused tab and
// shows which hosts have sessions running.
function highlightActiveCred() {
  const s = state.sessions.get(state.activeTab);
  const id = s ? s.cred.id : null;
  for (const el of $("cred-list").querySelectorAll(".cred")) {
    const cid = el.dataset.credId;
    el.classList.toggle("active", id != null && cid === id);
    const n = tabsForCred(cid).length;
    const live = el.querySelector(".cred-live");
    live.textContent = n > 1 ? String(n) : "";
    live.classList.toggle("hidden", n === 0);
  }
}

// moveCred swaps a host with its neighbour and persists the new order.
async function moveCred(id, dir) {
  const arr = state.creds;
  const i = arr.findIndex((c) => c.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderCreds(); // optimistic
  try {
    const updated = await api("/api/creds/reorder", {
      method: "POST",
      body: JSON.stringify({ order: arr.map((c) => c.id) }),
    });
    if (Array.isArray(updated)) { state.creds = updated; renderCreds(); }
  } catch {
    await loadCreds(); // revert to server truth on failure
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
  state.editingTags = cred ? [...tagsOf(cred)] : [];
  $("c-tags").value = "";
  renderEditingTags();
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
  addEditingTag($("c-tags").value); // a tag typed but not yet committed
  $("c-tags").value = "";
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
    tags: state.editingTags,
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
// preset(bg, fg, cursor, selection, [16 ansi colors]) -> xterm theme object.
function preset(bg, fg, cursor, sel, a) {
  return {
    background: bg, foreground: fg, cursor: cursor, cursorAccent: bg, selectionBackground: sel,
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  };
}

// Popular, recognisable terminal colour schemes.
const TERM_PRESETS = {
  dracula:   preset("#282a36", "#f8f8f2", "#f8f8f2", "#44475a", ["#21222c","#ff5555","#50fa7b","#f1fa8c","#bd93f9","#ff79c6","#8be9fd","#f8f8f2","#6272a4","#ff6e6e","#69ff94","#ffffa5","#d6acff","#ff92df","#a4ffff","#ffffff"]),
  nord:      preset("#2e3440", "#d8dee9", "#d8dee9", "#434c5e", ["#3b4252","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#88c0d0","#e5e9f0","#4c566a","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#8fbcbb","#eceff4"]),
  onedark:   preset("#282c34", "#abb2bf", "#528bff", "#3e4451", ["#282c34","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#abb2bf","#5c6370","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#ffffff"]),
  monokai:   preset("#272822", "#f8f8f2", "#f8f8f0", "#49483e", ["#272822","#f92672","#a6e22e","#f4bf75","#66d9ef","#ae81ff","#a1efe4","#f8f8f2","#75715e","#f92672","#a6e22e","#f4bf75","#66d9ef","#ae81ff","#a1efe4","#f9f8f5"]),
  gruvbox:   preset("#282828", "#ebdbb2", "#ebdbb2", "#504945", ["#282828","#cc241d","#98971a","#d79921","#458588","#b16286","#689d6a","#a89984","#928374","#fb4934","#b8bb26","#fabd2f","#83a598","#d3869b","#8ec07c","#ebdbb2"]),
  solardark: preset("#002b36", "#839496", "#93a1a1", "#073642", ["#073642","#dc322f","#859900","#b58900","#268bd2","#d33682","#2aa198","#eee8d5","#586e75","#cb4b16","#586e75","#657b83","#839496","#6c71c4","#93a1a1","#fdf6e3"]),
  solarlight:preset("#fdf6e3", "#657b83", "#586e75", "#eee8d5", ["#073642","#dc322f","#859900","#b58900","#268bd2","#d33682","#2aa198","#eee8d5","#002b36","#cb4b16","#586e75","#657b83","#839496","#6c71c4","#93a1a1","#fdf6e3"]),
  tomorrow:  preset("#1d1f21", "#c5c8c6", "#c5c8c6", "#373b41", ["#1d1f21","#cc6666","#b5bd68","#f0c674","#81a2be","#b294bb","#8abeb7","#c5c8c6","#969896","#cc6666","#b5bd68","#f0c674","#81a2be","#b294bb","#8abeb7","#ffffff"]),
  github:    preset("#ffffff", "#24292e", "#24292e", "#c8e1ff", ["#24292e","#d73a49","#22863a","#b08800","#0366d6","#6f42c1","#1b7c83","#6a737d","#959da5","#cb2431","#28a745","#dbab09","#2188ff","#8a63d2","#3192aa","#d1d5da"]),
};

// Dropdown order + labels; "auto" follows the app's light/dark theme.
const TERM_THEME_LIST = [
  { id: "auto",       label: "Match app (auto)" },
  { id: "dracula",    label: "Dracula" },
  { id: "nord",       label: "Nord" },
  { id: "onedark",    label: "One Dark" },
  { id: "monokai",    label: "Monokai" },
  { id: "gruvbox",    label: "Gruvbox Dark" },
  { id: "solardark",  label: "Solarized Dark" },
  { id: "solarlight", label: "Solarized Light" },
  { id: "tomorrow",   label: "Tomorrow Night" },
  { id: "github",     label: "GitHub Light" },
];

// termBaseTheme returns the palette for the current selection (before overrides).
// "auto" follows the app theme — including a full scheme when one is active —
// so picking e.g. Dracula for the whole app themes the terminal to match too.
function termBaseTheme() {
  const id = prefs.termTheme || "auto";
  if (id === "auto") {
    if (isSchemeTheme(prefs.theme)) return TERM_PRESETS[prefs.theme];
    return XTERM_THEMES[effectiveTheme()] || XTERM_THEMES.dark;
  }
  return TERM_PRESETS[id] || XTERM_THEMES.dark;
}

// terminalTheme is the effective xterm theme: the chosen palette, with the
// user's custom background/foreground overrides applied on top.
function terminalTheme() {
  const t = Object.assign({}, termBaseTheme());
  if (prefs.termBg) { t.background = prefs.termBg; t.cursorAccent = prefs.termBg; }
  if (prefs.termFg) t.foreground = prefs.termFg;
  return t;
}

// effectiveTermColors returns the bg/fg shown in the colour pickers.
function effectiveTermColors() {
  const base = termBaseTheme();
  return { bg: prefs.termBg || base.background, fg: prefs.termFg || base.foreground };
}

// applyTerminal pushes colours to every open terminal and the surrounding chrome.
function applyTerminal() {
  const t = terminalTheme();
  document.documentElement.style.setProperty("--term-bg", t.background);
  for (const s of state.sessions.values()) {
    try { s.term.options.theme = t; s.fit.fit(); } catch {}
  }
  if (!$("settings").classList.contains("hidden")) refreshSettingsPreview();
}

let tabCounter = 0;

function openSession(cred) {
  const tabId = "t" + (++tabCounter);
  $("empty-state").classList.add("hidden");

  // Tab button
  const tabEl = document.createElement("div");
  tabEl.className = "tab active";
  tabEl.innerHTML = `<span class="dot"></span><span class="name"></span><span class="close">×</span>`;
  tabEl.querySelector(".name").dataset.full = cred.name;
  tabEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("close")) { closeTab(tabId); return; }
    activateTab(tabId);
  });
  $("tabs").appendChild(tabEl);
  fitLabels(); // a new tab narrows its neighbours

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
    theme: terminalTheme(),
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
  highlightActiveCred();
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
  highlightActiveCred();
  fitLabels(); // the remaining tabs just got wider
}

window.addEventListener("resize", () => {
  const s = state.sessions.get(state.activeTab);
  if (s) s.fit.fit();
  fitLabels();
});

/* ============================================================
   PREFERENCES  (persisted server-side, beside the vault)
   Because PortaSSH binds a *random* port each launch, the browser's
   localStorage — keyed by origin (host:port) — can't survive a restart.
   So all UI prefs live in a JSON file next to the vault and travel with
   it on the stick. This object is the single source of truth.
   ============================================================ */
const PREF_DEFAULTS = {
  theme: "dracula",       // app theme: "system" (follow OS) or a scheme id
  font: "jetbrains",
  fontSize: 13.5,
  lineHeight: 1.15,
  termTheme: "auto",      // terminal palette: "auto" | preset id
  termBg: "",             // optional custom background override (hex)
  termFg: "",             // optional custom foreground override (hex)
  sidebarWidth: 290,      // sidebar width in px
  sidebarCollapsed: false,
};
let prefs = Object.assign({}, PREF_DEFAULTS);

async function loadPrefs() {
  try {
    const p = await api("/api/prefs");
    prefs = Object.assign({}, PREF_DEFAULTS, p && typeof p === "object" ? p : {});
  } catch {
    prefs = Object.assign({}, PREF_DEFAULTS);
  }
}
let _saveTimer = null;
function savePrefs() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    api("/api/prefs", { method: "PUT", body: JSON.stringify(prefs) }).catch(() => {});
  }, 150);
}

/* ============================================================
   THEME  (whole-app theming)
   prefs.theme ∈ {"system","light","dark"} (built-ins) OR a scheme id
   (dracula, nord, …). For a scheme we derive a full set of UI tokens
   from its palette and apply them as inline CSS variables on :root.
   ============================================================ */
const systemLight = window.matchMedia("(prefers-color-scheme: light)");

// --- small colour helpers ---
function hexToRgb(h) {
  h = String(h).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r) {
  return "#" + r.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
}
function mixHex(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
}
function relLum(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

// App theme dropdown: "System (auto)" to follow the OS, then every scheme.
const APP_THEME_LIST = [
  { id: "system", label: "System (auto)" },
].concat(TERM_THEME_LIST.filter((t) => t.id !== "auto"));

// The UI variables an app scheme controls (so we can cleanly clear them).
const APP_VAR_KEYS = [
  "--bg", "--bg-2", "--panel", "--panel-2", "--border", "--border-2",
  "--text", "--muted", "--faint", "--accent", "--accent-2", "--good", "--danger",
  "--glow", "--shadow-lg",
];

// deriveAppTheme turns a terminal palette into a full set of UI tokens.
function deriveAppTheme(s) {
  const bg = s.background, fg = s.foreground;
  const dark = relLum(bg) < 0.4;
  const accent = s.blue || s.brightBlue;
  const accent2 = s.magenta || s.brightMagenta || accent;
  const t = { "--text": fg, "--accent": accent, "--accent-2": accent2, "--good": s.green, "--danger": s.red };
  t["--muted"] = mixHex(bg, fg, 0.58);
  t["--faint"] = mixHex(bg, fg, 0.40);
  if (dark) {
    t["--bg"] = bg;
    t["--bg-2"] = mixHex(bg, "#ffffff", 0.04);
    t["--panel"] = mixHex(bg, "#ffffff", 0.06);
    t["--panel-2"] = mixHex(bg, "#ffffff", 0.10);
    t["--border"] = mixHex(bg, "#ffffff", 0.15);
    t["--border-2"] = mixHex(bg, "#ffffff", 0.25);
    t["--shadow-lg"] = "0 30px 80px -30px rgba(0,0,0,.8)";
  } else {
    t["--bg"] = mixHex(bg, "#000000", 0.05);
    t["--bg-2"] = "#ffffff";
    t["--panel"] = mixHex(bg, "#ffffff", 0.55);
    t["--panel-2"] = mixHex(bg, "#000000", 0.04);
    t["--border"] = mixHex(bg, "#000000", 0.11);
    t["--border-2"] = mixHex(bg, "#000000", 0.20);
    t["--shadow-lg"] = "0 30px 70px -30px rgba(30,41,80,.35)";
  }
  t["--glow"] = `0 0 0 1px ${rgba(accent, 0.35)}, 0 8px 30px -8px ${rgba(accent, 0.5)}`;
  return t;
}

const BUILTIN_THEMES = ["system", "light", "dark"];
function isSchemeTheme(p) { return !BUILTIN_THEMES.includes(p) && !!TERM_PRESETS[p]; }

function themePref() { return prefs.theme || "system"; }
function effectiveTheme() {
  const p = themePref();
  if (p === "light" || p === "dark") return p;
  if (isSchemeTheme(p)) return relLum(TERM_PRESETS[p].background) < 0.4 ? "dark" : "light";
  return systemLight.matches ? "light" : "dark";
}
function applyTheme() {
  const p = themePref();
  const root = document.documentElement;

  // Clear any previously-applied scheme variables first.
  for (const k of APP_VAR_KEYS) root.style.removeProperty(k);

  if (isSchemeTheme(p)) {
    const dark = relLum(TERM_PRESETS[p].background) < 0.4;
    root.setAttribute("data-theme", dark ? "dark" : "light");
    const vars = deriveAppTheme(TERM_PRESETS[p]);
    for (const k in vars) root.style.setProperty(k, vars[k]);
  } else if (p === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", p);
  }

  applyTerminal(); // "auto" terminal palette depends on the app theme
}
function initTheme() {
  applyTheme();
  systemLight.addEventListener("change", () => { if (themePref() === "system") applyTheme(); });
}

/* ============================================================
   FONTS & SETTINGS  (terminal font / size / spacing / colours)
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
function fontSettings() {
  return { font: prefs.font, size: prefs.fontSize, lineHeight: prefs.lineHeight };
}
function fontStack(id) { return (FONTS.find((f) => f.id === id) || FONTS[0]).stack; }

// applyFont pushes font settings to every open terminal, live.
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
  // App theme dropdown
  const asel = $("set-apptheme");
  asel.innerHTML = "";
  for (const t of APP_THEME_LIST) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.label;
    if (t.id === prefs.theme) o.selected = true;
    asel.appendChild(o);
  }
  // Font dropdown
  const fsel = $("set-font");
  fsel.innerHTML = "";
  for (const f of FONTS) {
    const o = document.createElement("option");
    o.value = f.id; o.textContent = f.label;
    if (f.id === prefs.font) o.selected = true;
    fsel.appendChild(o);
  }
  // Terminal theme dropdown
  const tsel = $("set-termtheme");
  tsel.innerHTML = "";
  for (const t of TERM_THEME_LIST) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.label;
    if (t.id === prefs.termTheme) o.selected = true;
    tsel.appendChild(o);
  }
  $("set-size").value = prefs.fontSize;
  $("set-lh").value = prefs.lineHeight;
  syncColorPickers();
  refreshSettingsPreview();
  $("settings").classList.remove("hidden");
}

// syncColorPickers points the bg/fg inputs at the current effective colours.
function syncColorPickers() {
  const c = effectiveTermColors();
  $("set-bg").value = toHex6(c.bg);
  $("set-fg").value = toHex6(c.fg);
}

function refreshSettingsPreview() {
  $("set-size-val").textContent = prefs.fontSize + "px";
  $("set-lh-val").textContent = Number(prefs.lineHeight).toFixed(2);
  const c = effectiveTermColors();
  const prev = $("set-preview");
  prev.style.setProperty("--preview-font", fontStack(prefs.font));
  prev.style.setProperty("--preview-size", prefs.fontSize + "px");
  prev.style.setProperty("--preview-lh", prefs.lineHeight);
  prev.style.background = c.bg;
  prev.style.color = c.fg;
}

function initSettings() {
  $("btn-settings").addEventListener("click", openSettings);
  $("set-close").addEventListener("click", () => $("settings").classList.add("hidden"));

  $("set-apptheme").addEventListener("input", () => {
    prefs.theme = $("set-apptheme").value;
    savePrefs(); applyTheme(); syncColorPickers(); refreshSettingsPreview();
  });
  $("set-font").addEventListener("input", () => { prefs.font = $("set-font").value; savePrefs(); refreshSettingsPreview(); applyFont(); });
  $("set-size").addEventListener("input", () => { prefs.fontSize = parseFloat($("set-size").value); savePrefs(); refreshSettingsPreview(); applyFont(); });
  $("set-lh").addEventListener("input", () => { prefs.lineHeight = parseFloat($("set-lh").value); savePrefs(); refreshSettingsPreview(); applyFont(); });

  // Terminal palette: switching a preset clears custom colour overrides.
  $("set-termtheme").addEventListener("input", () => {
    prefs.termTheme = $("set-termtheme").value;
    prefs.termBg = ""; prefs.termFg = "";
    savePrefs(); syncColorPickers(); applyTerminal();
  });
  $("set-bg").addEventListener("input", () => { prefs.termBg = $("set-bg").value; savePrefs(); applyTerminal(); });
  $("set-fg").addEventListener("input", () => { prefs.termFg = $("set-fg").value; savePrefs(); applyTerminal(); });
  $("set-reset-colors").addEventListener("click", () => {
    prefs.termBg = ""; prefs.termFg = "";
    savePrefs(); syncColorPickers(); applyTerminal();
  });

  $("set-reset").addEventListener("click", () => {
    Object.assign(prefs, {
      font: PREF_DEFAULTS.font, fontSize: PREF_DEFAULTS.fontSize, lineHeight: PREF_DEFAULTS.lineHeight,
      termTheme: PREF_DEFAULTS.termTheme, termBg: "", termFg: "",
    });
    savePrefs();
    openSettings();
    applyFont(); applyTerminal();
  });
}

// toHex6 normalises a colour to #rrggbb for <input type="color">.
function toHex6(c) {
  if (typeof c !== "string") return "#000000";
  let h = c.trim();
  if (h[0] !== "#") h = "#" + h;
  if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]; // #rgb -> #rrggbb
  if (h.length >= 7) return h.slice(0, 7).toLowerCase();
  return "#000000";
}

/* ============================================================
   SIDEBAR  (collapsible + resizable, persisted in prefs)
   ============================================================ */
const SIDEBAR_MIN = 210, SIDEBAR_MAX = 480, SIDEBAR_DEFAULT = 290;
// Below this the header can no longer hold the title and all three buttons at
// full size, so the two optional buttons drop out (see .app.narrow).
const SIDEBAR_NARROW = 265;
function clampSidebar(w) {
  w = parseInt(w, 10) || SIDEBAR_DEFAULT;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
}
function setSidebarWidth(w) {
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  $("app").classList.toggle("narrow", w < SIDEBAR_NARROW);
}
function refitActive() {
  const s = state.sessions.get(state.activeTab);
  if (s) requestAnimationFrame(() => { try { s.fit.fit(); } catch {} });
  fitLabels(); // sidebar and tab bar both changed width
}
function applySidebar() {
  setSidebarWidth(clampSidebar(prefs.sidebarWidth));
  const collapsed = !!prefs.sidebarCollapsed;
  $("app").classList.toggle("collapsed", collapsed);
  $("btn-expand").classList.toggle("hidden", !collapsed);
  refitActive();
}
function initSidebar() {
  applySidebar();
  $("btn-collapse").addEventListener("click", () => { prefs.sidebarCollapsed = true; savePrefs(); applySidebar(); });
  $("btn-expand").addEventListener("click", () => { prefs.sidebarCollapsed = false; savePrefs(); applySidebar(); });

  const handle = $("resize-handle");
  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = clampSidebar(e.clientX); // sidebar starts at viewport x=0
    prefs.sidebarWidth = w;
    setSidebarWidth(w);
    refitActive();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    savePrefs();
  });
  handle.addEventListener("dblclick", () => {
    prefs.sidebarWidth = SIDEBAR_DEFAULT;
    savePrefs();
    applySidebar();
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

// Modifier that forces a second session for an already-connected host.
const NEWSESSION_HINT = IS_MAC ? "⌘" : "Ctrl";

function kb(macKeys, otherKeys) { return IS_MAC ? macKeys : otherKeys; }
const SHORTCUTS = [
  ["Command palette · connect", kb(["⌘", "K"], ["Ctrl", "⇧", "K"])],
  ["New connection", kb(["⌘", "E"], ["Ctrl", "⇧", "E"])],
  ["Second session for a host", kb(["⌘", "click"], ["Ctrl", "click"])],
  ["Next tab", kb(["⌘", "⇧", "]"], ["Ctrl", "⇧", "]"])],
  ["Previous tab", kb(["⌘", "⇧", "["], ["Ctrl", "⇧", "["])],
  ["Jump to tab 1–9", kb(["⌘", "1…9"], ["Alt", "1…9"])],
  ["Close current tab", kb(["⌘", "⌫"], ["Ctrl", "⇧", "⌫"])],
  ["Lock vault", kb(["⌘", "L"], ["Ctrl", "⇧", "L"])],
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

function activeTerm() {
  const s = state.sessions.get(state.activeTab);
  return s ? s.term : null;
}

/* macOS clipboard bridge — for the terminal only.
   Text fields need nothing from us: the app's Edit menu drives the WebView's
   native cut:/copy:/paste:/selectAll:, which get undo and every input type
   right. A terminal selection, though, is *drawn* by xterm rather than being a
   DOM selection, so the native copy: has nothing to act on and ⌘C would come up
   empty. We handle that case here.
   The page is offered ⌘-keys before the menu is, and calling preventDefault
   suppresses the menu action — so whatever we claim below, the Edit menu will
   not also fire; whatever we decline falls through to it.
   No-op off macOS: Windows (WebView2) and Linux (WebKitGTK) deliver these to
   the page natively, and we must never shadow Ctrl+C (SIGINT) in the shell. */
function handleClipboardKey(e) {
  if (!IS_MAC) return false;
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (!["KeyC", "KeyV", "KeyA"].includes(e.code)) return false;

  // Hand real text fields to the Edit menu. xterm's hidden helper textarea is
  // not one — it is the focused element whenever the terminal has focus.
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.closest(".xterm")) {
    return false;
  }

  const term = activeTerm();
  if (!term) return false;
  switch (e.code) {
    case "KeyC":
      if (!term.hasSelection()) return false; // nothing selected — let ⌘C pass through
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      break;
    case "KeyV":
      navigator.clipboard.readText().then((text) => { if (text) term.paste(text); }).catch(() => {});
      break;
    case "KeyA":
      term.selectAll();
      break;
  }
  e.preventDefault();
  return true;
}

function handleGlobalKey(e) {
  // Escape closes the top-most overlay from anywhere.
  if (e.key === "Escape" && closeTopOverlay()) { e.preventDefault(); return; }

  // macOS ⌘C/⌘V/⌘A in the terminal; text fields go to the Edit menu instead.
  if (handleClipboardKey(e)) { e.stopImmediatePropagation(); return; }

  // While the palette is open, it owns navigation keys.
  if (isPaletteOpen() && handlePaletteKey(e)) return;

  if (!appVisible()) return; // shortcuts only once unlocked

  const fire = (fn) => { e.preventDefault(); e.stopImmediatePropagation(); fn(); };

  if (comboKey(e, "KeyK")) return fire(openPalette);
  if (comboKey(e, "KeyE")) return fire(() => openEditor(null));
  if (comboKey(e, "KeyL")) return fire(() => $("btn-lock").click());
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
    .filter((c) => match(c.name) || match(c.host) || match(c.user) || tagsOf(c).some(match))
    .map((c) => ({
      kind: "connect",
      tag: tabsForCred(c.id).length ? "focus" : "connect",
      title: c.name,
      sub: `${c.user}@${c.host}:${c.port}`,
      color: c.color || ACCENTS[0],
      letter: (c.name || "?").trim().charAt(0).toUpperCase(),
      run: () => { closePalette(); focusOrOpen(c); },
    }));

  const commands = [
    { kind: "command", icon: "＋", title: "New connection…", sub: "Add a saved host", run: () => { closePalette(); openEditor(null); } },
    { kind: "command", icon: "⚙️", title: "Settings", sub: "Theme, font, colours", run: () => { closePalette(); openSettings(); } },
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
      <div class="pi-tag">${it.tag || "command"}</div>`;
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

/* ---------------- middle truncation ----------------
   Host names and user@host lines differ at both ends ("web-01" vs "web-02",
   ":22" vs ":2222"), so a trailing ellipsis hides exactly the part you need.
   CSS can only ellipsize an edge, so anything marked with data-full gets cut
   in the middle by hand instead. */

// squeeze keeps `keep` characters of s, split across both ends. It counts in
// code points so the 🔑/🔒 in a host line never gets cut in half.
function squeeze(s, keep) {
  const cp = Array.from(s);
  if (keep >= cp.length) return s;
  if (keep <= 0) return "…";
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return cp.slice(0, head).join("") + "…" + (tail ? cp.slice(cp.length - tail).join("") : "");
}

const measureRange = document.createRange();

// fitsIn measures in fractions of a pixel. scrollWidth/clientWidth are rounded
// to integers, so a label overflowing by half a pixel reads as "fits" and
// gets an end-ellipsis from CSS instead of being cut in the middle.
function fitsIn(box) {
  measureRange.selectNodeContents(box);
  return measureRange.getBoundingClientRect().width <= box.getBoundingClientRect().width + 0.01;
}

// fitLabel shrinks one element's text until it stops overflowing. data-fit-box
// = "parent" measures the whole surrounding line instead of the element, so a
// single segment can be sacrificed to keep the rest of the line intact.
function fitLabel(el) {
  const full = el.dataset.full;
  if (full == null) return;
  const box = el.dataset.fitBox === "parent" ? el.parentElement : el;
  el.textContent = full;
  el.removeAttribute("title");
  if (fitsIn(box)) return;

  // Binary search the longest squeeze that still fits.
  let lo = 0, hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    el.textContent = squeeze(full, mid);
    if (fitsIn(box)) lo = mid; else hi = mid - 1;
  }
  el.textContent = squeeze(full, lo);
  el.title = full; // the hidden middle stays reachable on hover
}

// tightenSubs is the last resort for the host lines: once a host is squeezed as
// far as it goes, drop the "· 🔑 key" markers rather than let the line run over
// and take the port with it. The port is the part you actually need.
// The decision is collective — one cramped row drops the marker on every row,
// so the column never shows "· 🔑 key" on one line and nothing on the next.
function tightenSubs() {
  const list = $("cred-list");
  const subs = [...list.querySelectorAll(".cred-sub")];
  if (!subs.some((s) => !fitsIn(s))) return;
  list.classList.add("no-auth");
  for (const s of subs) fitLabel(s.querySelector(".sub-host"));
}

// The UI font is font-display:swap, so first paint can measure the fallback
// and land a pixel off once the real font arrives.
if (document.fonts) document.fonts.ready.then(() => fitLabels());

let fitQueued = false;
// fitLabels re-cuts every marked label, coalesced to one pass per frame so a
// sidebar drag does not re-measure on every mousemove.
function fitLabels() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    // Restore what a previous, narrower pass gave up before re-measuring.
    $("cred-list").classList.remove("no-auth");
    for (const el of document.querySelectorAll("[data-full]")) fitLabel(el);
    tightenSubs();
  });
}

/* ---------------- util ---------------- */
function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ---------------- boot ---------------- */
(async function boot() {
  await loadPrefs();     // fetch persisted settings before first paint of theme
  initTheme();           // applies theme + terminal colours from prefs
  initSettings();
  initSidebar();
  initTagInput();
  initShortcuts();
  await initLock();
})().catch((e) => {
  $("lock-error").textContent = "Failed to reach PortaSSH backend: " + e.message;
});
