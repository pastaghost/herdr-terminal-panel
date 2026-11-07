// The terminal panel's data and actions: the shared list of panel terminals, their
// optional link to a space, how they group into splits, what the panel's terminal area
// shows, agent status, and the label edits behind the right-click menu. No UI here.
//
// The panel has one list of terminals, shown in every space. A terminal can be linked
// ("associated") with a space: switching to that space selects it. Unlinked ones stay
// selected across switches.
//
// Everything about a terminal lives on the core terminal as labels, so it survives
// restarts and every Herdr window sees the same:
//   herdr-drawer.panel   "1": it's a panel terminal
//   herdr-drawer.space   the space it's linked with (its local id), if any. Older panel
//                        terminals have only this label; it makes them members too.
//   herdr-drawer.group   split group: the address of the group's first terminal
//   herdr-drawer.name    a name given with Rename…
//   herdr-drawer.color   a color name from COLORS
//   herdr-drawer.icon    an icon name from ICON_NAMES
//   herdr-drawer.window  "1" while it's in its own window (not listed in the panel)
// They deliberately don't carry `herdr.space` / `herdr.tab`, so they never become Herdr
// panes or tabs, until "Move Terminal into Editor Area" adds exactly those.

import {
  spaces, terminals, focused, panes, machines, run, hc, home, shared, setShared,
  layout, notify, appHome, readTextFile, writeTextFile, openOverlay,
} from "herdr";

export const L = {
  panel: "herdr-drawer.panel",
  space: "herdr-drawer.space",
  group: "herdr-drawer.group",
  name: "herdr-drawer.name",
  color: "herdr-drawer.color",
  icon: "herdr-drawer.icon",
  window: "herdr-drawer.window",
};
export const DRAWER = "drawer";
export const TERM = "drawer-term";
export const ASSETS = "mods/drawer";
export const RESTORE_PX = "drawer.restorePx";
const SELECTED = "drawer.selected"; // the panel's selected terminal
const BY_SPACE = "drawer.active"; // space id -> the linked terminal last selected there
const REQ = "drawer.req";
export const UNSEEN = "drawer.unseen"; // addresses that finished while nobody looked
export const ATTENTION = "drawer.attention"; // the terminal the last alert was about

/** [label value, theme color, what people see]. */
export const COLORS = [
  ["", null, "Default"],
  ["red", "ansi1", "Red"],
  ["green", "ansi2", "Green"],
  ["yellow", "ansi3", "Yellow"],
  ["blue", "ansi4", "Blue"],
  ["magenta", "ansi5", "Magenta"],
  ["cyan", "ansi6", "Cyan"],
];
export const ICON_NAMES = [
  "terminal", "server", "monitor", "folder", "git-branch", "layers", "settings",
  "search", "file-text", "clock", "archive", "pin", "square", "check",
];

/** "vps/sp1" -> "sp1"; local ids pass through. */
export const localId = (id) => (id && id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);
/** "vps/t7" -> "vps"; "t7" -> null. */
export const machineOf = (a) => (a && a.includes("/") ? a.slice(0, a.indexOf("/")) : null);

export function activeSpace() {
  return spaces().find((s) => s.active) ?? null;
}

export function findNode(n, id) {
  if (!n || typeof n !== "object") return null;
  if (n.id === id) return n;
  for (const c of n.children ?? []) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

export function drawerHidden() {
  return Boolean(findNode(layout(), DRAWER)?.hidden);
}

export const terminal = (address) => terminals().find((t) => t.address === address) ?? null;

const isPanel = (t) => Boolean(t.labels?.[L.panel] || t.labels?.[L.space]);

/** The space a terminal is linked with, or null. */
export function spaceOf(t) {
  const id = t?.labels?.[L.space];
  if (!id) return null;
  const m = machineOf(t.address);
  return spaces().find((s) => localId(s.id) === id && (s.machine ?? null) === m) ?? null;
}

export const linkedTo = (t, space) => Boolean(space) && spaceOf(t)?.id === space.id;

// Terminals being killed: off the list at once, so the panel stops showing them first.
export const dying = new Set();

/** Every live panel terminal, oldest first. Ones in their own window are left out
 *  unless `windowed`. */
export function sessions({ windowed = false } = {}) {
  return terminals()
    .filter((t) => t.state === "live" && isPanel(t) && !dying.has(t.address)
      && (windowed || !t.labels?.[L.window]))
    .sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));
}

export const groupKey = (t) => t.labels?.[L.group] || t.address;

/** Sessions in split groups, in the order each group's first terminal was made. */
export function groups(list = sessions()) {
  const g = new Map();
  for (const t of list) {
    const k = groupKey(t);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  return [...g.values()];
}

function bySpace() {
  const m = shared(BY_SPACE);
  return m && typeof m === "object" ? m : {};
}

export function selected(list = sessions()) {
  if (!list.length) return null;
  const want = shared(SELECTED);
  return list.find((t) => t.address === want) ?? list[list.length - 1];
}

/** Selects a terminal; if it's linked with the shown space, that space remembers it. */
export function setSelected(address) {
  setShared(SELECTED, address);
  const t = terminal(address);
  const space = activeSpace();
  if (t && linkedTo(t, space)) setShared(BY_SPACE, { ...bySpace(), [space.id]: address });
}

/** On arriving in a space: select its linked terminal, the one used there last if several.
 *  With none linked, the selection stays. */
export function arriveIn(space) {
  const linked = sessions().filter((t) => linkedTo(t, space));
  if (!linked.length) return false;
  const want = bySpace()[space.id];
  const pick = linked.find((t) => t.address === want) ?? linked[0];
  if (shared(SELECTED) === pick.address) return false;
  setShared(SELECTED, pick.address);
  return true;
}

export function sessionName(t) {
  return t.labels?.[L.name] || t.program?.name || t.foreground?.name || "shell";
}

export function iconOf(t) {
  const name = t.labels?.[L.icon];
  return `${ASSETS}/icons/${ICON_NAMES.includes(name) ? name : "terminal"}.svg`;
}

/** The terminal's color from the theme, or null for the default. */
export function colorOf(t, theme) {
  const c = COLORS.find(([v]) => v && v === t.labels?.[L.color]);
  return c ? theme[c[1]] : null;
}

/** Where a new terminal should start: where the shown space is working. */
function cwdFor(space) {
  const f = focused();
  if (f?.space === space.id && f.cwd) return f.cwd;
  const tab = space.tabs.find((t) => t.active);
  const p = tab && panes().find((p) => p.tab === tab.id && p.cwd);
  if (p) return p.cwd;
  if (space.folder) return space.folder;
  return space.machine ? null : home();
}

// ---- Agent status ---------------------------------------------------------------------

/** "working" | "blocked" | "error" | "done" (finished while nobody looked) | null. */
export function statusOf(t) {
  if (t.status === "blocked" || t.status === "error") return t.status;
  if (t.status === "working") return "working";
  const unseen = shared(UNSEEN);
  return Array.isArray(unseen) && unseen.includes(t.address) ? "done" : null;
}

export function markUnseen(address, on) {
  const now = Array.isArray(shared(UNSEEN)) ? shared(UNSEEN) : [];
  const has = now.includes(address);
  if (on && !has) setShared(UNSEEN, [...now, address]);
  if (!on && has) setShared(UNSEEN, now.filter((a) => a !== address));
}

// ---- What the panel's terminal area shows ------------------------------------------

/** The `drawer-term` node: the selected terminal's split group side by side, one
 *  terminal, or this mod's "empty" view. */
// Herdr only lights a node's focus border when a pane is inside it, and the panel shows
// terminal blocks, not panes, so each block carries its own: blue while it has the keyboard.
const FOCUS_LOOK = { radius: 8, border: { width: 1, color: "#00000000" }, focus: { border: { width: 1, color: "accent" } } };

export function wantedNode() {
  const list = sessions();
  const sel = selected(list);
  if (!sel) return { id: TERM, type: "block", content: { mod: "drawer", props: { role: "empty" } } };
  const group = list.filter((t) => groupKey(t) === groupKey(sel));
  if (group.length < 2) return { id: TERM, type: "block", ...FOCUS_LOOK, content: { terminal: sel.address } };
  return {
    id: TERM,
    type: "row",
    divider: { width: 1, color: "border" },
    children: group.map((t, i) => ({ id: `${TERM}-${i}`, type: "block", ...FOCUS_LOOK, content: { terminal: t.address } })),
  };
}

function nodeKey(n) {
  if (!n) return "";
  if (n.type === "row") return "r:" + (n.children ?? []).map((c) => c.content?.terminal).join(",");
  if (n.content?.terminal) return "t:" + n.content.terminal;
  return `m:${n.content?.mod}:${n.content?.props?.role ?? ""}`;
}

/** The terminals the panel shows now. */
export function shownTerminals() {
  const n = findNode(layout(), TERM);
  if (!n) return [];
  return n.type === "row" ? (n.children ?? []).map((c) => c.content?.terminal) : [n.content?.terminal];
}

/** True when the shown layout's terminal area already shows what it should. */
export function inSync() {
  const n = findNode(layout(), TERM);
  return !n || nodeKey(n) === nodeKey(wantedNode());
}

function replaceNode(n, id, next) {
  const kids = n?.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].id === id) {
      kids[i] = kids[i].size ? { ...next, size: kids[i].size } : next;
      return true;
    }
    if (replaceNode(kids[i], id, next)) return true;
  }
  return false;
}

let writing = false;

/** Points the panel's terminal area at the selected terminal (or its split group) by
 *  editing the layout file.
 *
 *  Not layout.set: layout() hands back a simplified tree (a column with one child is merged
 *  into that child, losing its size and hidden flag), and setting it back loses structure.
 *  The file edit replaces that one node and nothing else. */
export async function syncLayout() {
  if (writing || inSync()) return false;
  const name = shared("layout");
  if (typeof name !== "string" || !name) return false;
  writing = true;
  try {
    const path = `${appHome()}/layouts/${name}.json`;
    const text = await readTextFile(path);
    if (!text) return false;
    const l = JSON.parse(text);
    const want = wantedNode();
    if (nodeKey(findNode(l, TERM)) === nodeKey(want)) return false;
    if (!replaceNode(l, TERM, want)) return false;
    await writeTextFile(path, JSON.stringify(l, null, 2) + "\n", text);
    return true;
  } catch (e) {
    console.log(`[drawer] layout write failed: ${e}`);
    return false;
  } finally {
    writing = false;
  }
}

/** Waits (up to ~2 s) until the panel no longer shows `address`. */
export async function waitHidden(address, cx) {
  for (let i = 0; i < 20 && shownTerminals().includes(address); i++) await cx.sleep(100);
}

// ---- Repair -----------------------------------------------------------------------------
//
// When a terminal shown in a layout block exits, Herdr removes that block and rewrites the
// layout file from its simplified tree, which drops every one-child column (the panel's
// own structure, and the Files panel's wrapper). The panel kills its own terminals only
// after showing something else, but `exit` typed in a shell can't be intercepted. So the
// bar copy checks the file every few seconds and, if the panel's blocks are gone, puts
// back the last intact copy (see repairLayout).

const PANEL_IDS = ["drawer", "drawer-bar", "drawer-body", TERM, "drawer-side"];

function ids(n, out = new Set()) {
  if (n?.id) out.add(n.id);
  for (const c of n?.children ?? []) ids(c, out);
  return out;
}

function panelTree(old) {
  const drawer = {
    id: DRAWER, type: "column",
    size: old?.size ?? { px: 260 }, min: 100,
    background: "background", radius: 10,
    border: { width: 1, color: "border" },
    focus: { border: { width: 1, color: "accent" } },
    children: [
      { id: "drawer-bar", type: "block", size: { px: 36 }, content: { mod: "drawer" } },
      { id: "drawer-body", type: "row", divider: { width: 1, color: "border" }, children: [
        wantedNode(),
        { id: "drawer-side", type: "block", size: { px: 210 }, min: 140, max: 420, content: { mod: "drawer", props: { role: "list" } } },
      ] },
    ],
  };
  if (old?.hidden) drawer.hidden = true;
  return drawer;
}

let repairing = false;
// layout name -> the file's text the last time the panel's blocks were all there.
const BACKUP = "drawer.layoutBackup";

/** Herdr's `main` with the panel added, keeping the damaged file's look. The fallback when
 *  there's no saved copy; other edits to the layout are lost. */
function fromMain(base, cur) {
  const next = { ...base, cloned_from: cur.cloned_from ?? { name: "main" } };
  for (const k of ["theme", "colors", "font", "font_size", "ui_font", "terminal_opacity"]) {
    if (k in cur) next[k] = cur[k];
  }
  const body = findNode(next, "work-body");
  const i = (body?.children ?? []).findIndex((c) => c.id === "main");
  if (i < 0) return null;
  body.children[i] = { id: "center", type: "column", gap: 8, children: [body.children[i], panelTree(findNode(cur, DRAWER))] };
  return next;
}

/** Repairs the shown layout's file if Herdr dropped the panel's blocks. True if it did.
 *
 *  While the file is intact, it's saved (shared "drawer.layoutBackup"). Repair restores
 *  that copy, so other edits to the layout survive, with the terminal area pointed at the
 *  selection. Only a missing panel block counts as damage: deliberate edits elsewhere
 *  (removing the Files panel, say) are left alone, and so is a layout that no longer has
 *  the panel at all. */
export async function repairLayout() {
  const name = shared("layout");
  if (repairing || typeof name !== "string" || !name || name === "main") return false;
  repairing = true;
  try {
    const path = `${appHome()}/layouts/${name}.json`;
    const text = await readTextFile(path);
    if (!text) return false;
    const cur = JSON.parse(text);
    const have = ids(cur);
    // Only a layout with the panel in it is ours to repair.
    if (!have.has(DRAWER) && !have.has("drawer-bar")) return false;
    const missing = PANEL_IDS.filter((id) => !have.has(id));
    const saved = shared(BACKUP) && typeof shared(BACKUP) === "object" ? shared(BACKUP) : {};
    if (!missing.length) {
      if (saved[name] !== text) setShared(BACKUP, { ...saved, [name]: text });
      return false;
    }
    let next = null;
    let from = "saved copy";
    try {
      const copy = saved[name] && JSON.parse(saved[name]);
      if (copy && PANEL_IDS.every((id) => ids(copy).has(id)) && replaceNode(copy, TERM, wantedNode())) next = copy;
    } catch { /* fall back to main */ }
    if (!next) {
      from = "Herdr's main layout";
      const baseText = await readTextFile(`${appHome()}/layouts/main.json`);
      next = baseText && fromMain(JSON.parse(baseText), cur);
    }
    if (!next) {
      notify({ title: "Terminal panel layout needs repair", body: "Herdr's main layout changed shape; ask Claude to re-add the panel.", level: "warning" });
      return false;
    }
    await writeTextFile(path, JSON.stringify(next, null, 2) + "\n", text);
    console.log(`[drawer] repaired layout ${name} from ${from}: was missing ${missing.join(", ")}`);
    return true;
  } catch (e) {
    console.log(`[drawer] layout repair failed: ${e}`);
    return false;
  } finally {
    repairing = false;
  }
}

/** Waits (up to ~2 s) for the app to apply the layout file, then focuses the terminal. */
export async function focusWhenShown(address, cx) {
  for (let i = 0; i < 20; i++) {
    if (shownTerminals().includes(address)) {
      run("pane.focus", { terminal: address });
      return;
    }
    await cx.sleep(100);
  }
}

// ---- Starting and labelling terminals -------------------------------------------------

export const state = {
  // A start in progress.
  starting: false,
  // The panel already started one by itself. terminals() lags a moment behind `hc run`,
  // so "no terminals yet" can't decide on its own whether to start one: the panel starts
  // one by itself at most once; after that only the person does.
  autoStarted: false,
};
// Never more than one start per half second, whatever asks.
let lastStart = 0;

/** Starts a panel terminal on the space's machine, in `cwd` (default: where the space is
 *  working), in split group `group`, linked with the space if `link`. Resolves with its
 *  address, or null. */
export async function newSession(space, { group, cwd, link = false } = {}) {
  if (!space || state.starting) return null;
  const now = Date.now();
  if (now - lastStart < 500) return null;
  lastStart = now;
  state.autoStarted = true;
  state.starting = true;
  try {
    const args = ["run", "--json", "--keep", "--no-parent", "--bg", "--label", `${L.panel}=1`];
    if (link) args.push("--label", `${L.space}=${localId(space.id)}`);
    if (group) args.push("--label", `${L.group}=${group}`);
    if (space.machine) args.push("--on", space.machine);
    const dir = cwd || cwdFor(space);
    if (dir) args.push("--cwd", dir);
    const r = await hc(args);
    let address = null;
    try { address = JSON.parse(r.stdout).address ?? null; } catch { /* reported below */ }
    if (!address) {
      notify({ title: "Couldn't start a terminal", body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" });
      return null;
    }
    if (space.machine && !address.includes("/")) address = `${space.machine}/${address}`;
    setShared(SELECTED, address);
    return address;
  } finally {
    state.starting = false;
  }
}

/** Sets (or, with "" / null, removes) labels on a terminal. */
export async function label(address, pairs) {
  const r = await hc(["label", address, ...Object.entries(pairs).map(([k, v]) => `${k}=${v ?? ""}`)]);
  if (r.code !== 0) {
    notify({ title: "Couldn't update the terminal", body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" });
  }
  return r.code === 0;
}

/** Links a terminal with a space, or unlinks it (space null). It stays in the panel. */
export async function associate(t, space) {
  const ok = await label(t.address, { [L.panel]: "1", [L.space]: space ? localId(space.id) : "" });
  if (ok && space) setShared(BY_SPACE, { ...bySpace(), [space.id]: t.address });
  return ok;
}

/** Unlinks terminals whose space is gone (this computer only, once its layout has loaded).
 *  They stay in the panel. */
export function sweepOrphans() {
  const here = machines().find((m) => m.name === null);
  if (here?.layout !== "ready") return;
  const ids = new Set(spaces().filter((s) => !s.machine).map((s) => s.id));
  if (!ids.size) return;
  for (const t of sessions({ windowed: true })) {
    const sp = t.labels?.[L.space];
    if (sp && !machineOf(t.address) && !ids.has(sp)) label(t.address, { [L.panel]: "1", [L.space]: "" });
  }
}

// ---- Requests ---------------------------------------------------------------------------
//
// Menus, pickers and window title bars are short-lived overlays: their tasks are cancelled
// when they close, so they can't await `hc`. They post a request instead, and the panel's
// bar copy (alive while the panel is in the layout) carries it out.

export function request(op, args = {}) {
  const seq = (Number(shared(REQ)?.seq) || 0) + 1;
  setShared(REQ, { seq, op, ...args });
}

export const lastRequest = () => shared(REQ) ?? null;

// ---- Moving terminals out of the panel ---------------------------------------------

const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

/** Makes the terminal a regular Herdr tab ("Move Terminal into Editor Area"): in its
 *  linked space, else the shown one. Only a space on the terminal's own machine fits. */
export async function moveToTab(t, cx) {
  const shown = activeSpace();
  const space = spaceOf(t) ?? ((shown?.machine ?? null) === machineOf(t.address) ? shown : null);
  if (!space) {
    notify({ title: "Can't move this terminal here", body: "It runs on another machine than this space.", level: "warning" });
    return;
  }
  const tab = `tb${hex(32)}`;
  const ok = await label(t.address, {
    "herdr.space": localId(space.id),
    "herdr.tab": tab,
    [L.panel]: "", [L.space]: "", [L.group]: "", [L.window]: "",
  });
  if (!ok) return;
  markUnseen(t.address, false);
  const id = space.machine ? `${space.machine}/${tab}` : tab;
  const name = t.labels?.[L.name];
  for (let i = 0; i < 30; i++) {
    const made = spaces().find((s) => s.id === space.id)?.tabs.find((x) => x.id === id);
    if (made) {
      if (!space.active) run("space.select", { id: space.id });
      run("tab.select", { id });
      if (name) run("tab.rename", { id, name });
      return;
    }
    await cx.sleep(100);
  }
}

/** Opens the terminal in its own window ("Move Terminal into New Window"). */
export async function moveToWindow(t) {
  if (!(await label(t.address, { [L.window]: "1" }))) return;
  openOverlay({
    kind: "window",
    key: `drawer-${t.address}`,
    keep: true,
    width: 760,
    height: 460,
    layout: {
      type: "column",
      children: [
        { type: "block", size: { px: 34 }, content: { mod: "drawer", props: { role: "titlebar", terminal: t.address } } },
        { type: "block", content: { terminal: t.address } },
      ],
    },
  });
}

/** Brings a windowed terminal back into the panel. */
export async function moveToPanel(t) {
  if (!(await label(t.address, { [L.window]: "" }))) return;
  setSelected(t.address);
  run("layout.show", { id: DRAWER });
}
