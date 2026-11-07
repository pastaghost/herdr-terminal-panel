// A VS Code-style terminal panel below the tab area, with one list of terminals shared by
// every space. A terminal can be linked with a space; switching to that space selects it.
//
// Layout (layouts/main-drawer.json):
//   { "id": "drawer", "type": "column", children: [
//       { "id": "drawer-bar", "type": "block", "content": { "mod": "drawer" } },
//       { "id": "drawer-body", "type": "row", children: [
//           { "id": "drawer-term", ... the selected terminal, or its split group as a row },
//           { "id": "drawer-side", "type": "block", "content": { "mod": "drawer", "props": { "role": "list" } } } ] } ] }
//
// Roles (props().role):
//   (none)    the header bar. Owns the logic: keeps `drawer-term` on the selected terminal
//             (sessions.js syncLayout), selects a space's linked terminal on arrival,
//             watches agent status and alerts, takes key commands, carries out requests.
//   list      the terminal list docked on the right; right-click a row for its menu.
//   empty     what `drawer-term` shows when there's no terminal.
//   menu      the right-click menu (popup), props { terminal }.
//   color, icon, rename   the menu's pickers, props { terminal }.
//   titlebar  the title bar of a terminal moved into its own window, props { terminal }.
//
// Key commands (keys.json, "drawer.<command>"): new, split, next, prev, kill.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import {
  theme, run, props, shared, setShared, layout, nextCommand, openOverlay, closeOverlay, keys,
  focused, notify, playSound, window as appWindow,
} from "herdr";
import {
  L, DRAWER, ASSETS, RESTORE_PX, COLORS, ICON_NAMES, ATTENTION,
  activeSpace, findNode, drawerHidden, terminal, spaceOf, linkedTo, sessions, groups, groupKey,
  selected, setSelected, arriveIn, sessionName, iconOf, colorOf, statusOf, markUnseen,
  inSync, syncLayout, shownTerminals, focusWhenShown, waitHidden, repairLayout, dying, newSession, label, associate, sweepOrphans,
  state, request, lastRequest, moveToTab, moveToWindow, moveToPanel,
} from "./sessions.js";

const ITEM_H = 30;
const SEP_H = 9;

/** The right-click menu for terminal `t`, shown in `space`. */
function menuItems(t, space) {
  const linkedHere = t && linkedTo(t, space);
  return [
    { id: "split", label: "Split Terminal", command: "drawer.split" },
    { id: "toTab", label: "Move Terminal into Editor Area" },
    { id: "toWindow", label: "Move Terminal into New Window" },
    { sep: true },
    ...(space
      ? [linkedHere
        ? { id: "unlink", label: `Remove Association with ‘${space.name}’` }
        : { id: "link", label: `Associate with ‘${space.name}’` }]
      : []),
    { id: "color", label: "Change Color…" },
    { id: "icon", label: "Change Icon…" },
    { id: "rename", label: "Rename…" },
    { sep: true },
    { id: "kill", label: "Kill Terminal", command: "drawer.kill" },
  ];
}

/** "cmd-\\" -> "⌘\\", for menu hints. */
function keyHint(command) {
  const k = keys().find((b) => b.section === "global" && b.action === command)?.keys;
  if (!k) return "";
  const sym = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", backspace: "⌫", enter: "↩" };
  return k.split("-").map((p) => sym[p] ?? p.toUpperCase()).join("");
}

function iconButton(t, id, icon, onClick, { size = 14, color } = {}) {
  return div()
    .id(id)
    .flex_none()
    .p(4)
    .rounded(5)
    .text_color(color ?? t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(svg(icon.includes("/") ? icon : `${ASSETS}/${icon}.svg`).size(size));
}

/** The person is looking at this terminal: it's shown in the open panel of a focused window. */
function looking(address) {
  return appWindow().active && !drawerHidden() && shownTerminals().includes(address);
}

export default class Drawer extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "bar";
    this.hover = null;
    if (this.role === "bar") this.initBar(cx);
    if (["menu", "color", "icon"].includes(this.role)) {
      this.at = 0;
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
    if (this.role === "rename") this.initRename(cx);
  }

  // ---- The bar copy: logic ------------------------------------------------------------

  initBar(cx) {
    this.syncQueued = false;
    this.lastSeq = Number(lastRequest()?.seq) || 0;
    this.lastSpace = activeSpace()?.id ?? null;
    this.prevStatus = new Map(); // address -> last status seen, for alerts
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        await this.command(c, cx);
        cx.notify();
      }
    });
    cx.timer.every(60000, () => sweepOrphans());
    // A copy doesn't render while hidden or while the window is in the background, but its
    // timers run: alerts, requests from menus and keeping the terminal area in step must
    // work then too. tick only reads live data the app already holds; it writes the layout
    // file only when something changed.
    cx.timer.every(500, (cx) => this.tick(cx, activeSpace()));
    // Puts the layout back together if Herdr dropped part of it (sessions.js repairLayout).
    cx.timer.every(3000, (cx) => cx.spawn(async () => { await repairLayout(); }));
  }

  async command(c, cx) {
    const space = activeSpace();
    const list = sessions();
    const sel = selected(list);
    if (c === "new") return space && this.create(space, cx);
    if (c === "split" && sel) return this.split(sel, cx);
    if (c === "kill" && sel) return this.kill(sel, cx);
    if ((c === "next" || c === "prev") && list.length > 1) {
      const i = list.indexOf(sel);
      this.select(list[(i + (c === "next" ? 1 : -1) + list.length) % list.length].address, cx);
    }
  }

  /** Carries out what a menu, picker or window title bar asked for. */
  async handle(req, cx) {
    const t = terminal(req.terminal);
    if (!t) return;
    switch (req.op) {
      case "split": return this.split(t, cx);
      case "toTab": return moveToTab(t, cx);
      case "toWindow": return moveToWindow(t);
      case "toPanel": await moveToPanel(t); await syncLayout(); return focusWhenShown(t.address, cx);
      case "link": return associate(t, activeSpace());
      case "unlink": return associate(t, null);
      case "kill": return this.kill(t, cx);
      case "color": return label(t.address, { [L.color]: req.value });
      case "icon": return label(t.address, { [L.icon]: req.value === "terminal" ? "" : req.value });
      case "rename": return label(t.address, { [L.name]: req.value });
    }
  }

  create(space, cx, opts) {
    run("layout.show", { id: DRAWER });
    cx.spawn(async (cx) => {
      const address = await newSession(space, opts);
      if (!address) return;
      cx.notify();
      // The new terminal reaches terminals() a moment later; render syncs the panel then.
      await focusWhenShown(address, cx);
    });
  }

  /** A new terminal beside `t`, in its split group, starting where `t` is, on its machine,
   *  linked with the same space. */
  async split(t, cx) {
    const space = spaceOf(t) ?? activeSpace();
    if (!space) return;
    if (!t.labels?.[L.group]) await label(t.address, { [L.group]: t.address });
    this.create(space, cx, { group: groupKey(t), cwd: t.foreground?.cwd ?? t.cwd, link: Boolean(spaceOf(t)) });
  }

  select(address, cx) {
    setSelected(address);
    cx.spawn(async (cx) => {
      await syncLayout();
      await focusWhenShown(address, cx);
    });
  }

  /** Kills a panel terminal. The panel stops showing it first: when a terminal shown in a
   *  layout block exits, Herdr drops the block and rewrites the layout file (see
   *  sessions.js repairLayout). */
  kill(t, cx) {
    const list = sessions();
    const rest = list.filter((x) => x.address !== t.address);
    if (selected(list)?.address === t.address && rest.length) {
      // Next: another terminal in its split group, else its neighbour in the list.
      const mate = rest.find((x) => groupKey(x) === groupKey(t));
      const i = list.findIndex((x) => x.address === t.address);
      setSelected((mate ?? rest[Math.min(i, rest.length - 1)]).address);
    }
    dying.add(t.address);
    markUnseen(t.address, false);
    cx.spawn(async (cx) => {
      try {
        await syncLayout();
        await waitHidden(t.address, cx);
        run("terminal.kill", { terminal: t.address });
        if (!rest.length) this.hidePanel();
        await cx.sleep(2000);
      } finally {
        dying.delete(t.address);
      }
    });
  }

  /** Alerts for panel agents: a sound and a notification when one needs the person or
   *  finishes while they aren't looking. Panel terminals aren't Herdr panes, so Herdr's
   *  own alerts don't cover them. */
  watchStatus(list) {
    const live = new Set();
    for (const t of list) {
      live.add(t.address);
      const now = t.status ?? null;
      const before = this.prevStatus.get(t.address);
      this.prevStatus.set(t.address, now);
      const name = sessionName(t);
      const where = spaceOf(t)?.name;
      if (before === undefined || before === now) {
        if (looking(t.address)) markUnseen(t.address, false);
        continue;
      }
      if ((now === "blocked" || now === "error") && !looking(t.address)) {
        this.alert(t, "blocked", now === "error" ? `${name} hit an error` : `${name} needs you`, where);
      } else if (before === "working" && (now === "done" || now === "idle")) {
        if (looking(t.address)) continue;
        markUnseen(t.address, true);
        this.alert(t, "done", `${name} finished`, where);
      }
    }
    for (const a of this.prevStatus.keys()) if (!live.has(a)) this.prevStatus.delete(a);
  }

  alert(t, kind, title, where) {
    playSound(kind);
    // With the panel hidden, clicking the notification opens it on this terminal. With it
    // open, the badge in the list shows which one; the panel doesn't switch by itself.
    if (drawerHidden()) setShared(ATTENTION, t.address);
    notify({
      title,
      body: where ? `Terminal panel · ${where}` : "Terminal panel",
      level: kind === "blocked" ? "warning" : "success",
      icon: iconOf(t),
      action: { name: "layout.show", args: { id: DRAWER } },
    });
  }

  /** When the panel opens after an alert that came while it was hidden (its notification
   *  was clicked, or ⌃`), it shows that terminal, unless the person is typing in another
   *  panel terminal. */
  followAttention(list) {
    const a = shared(ATTENTION);
    if (!a || drawerHidden()) return false;
    const t = list.find((x) => x.address === a);
    if (!t || !statusOf(t)) { setShared(ATTENTION, null); return false; }
    const typingHere = shownTerminals().includes(focused()?.terminal);
    if (typingHere) return false;
    setShared(ATTENTION, null);
    if (selected(list)?.address === a) return false;
    setSelected(a);
    return true;
  }

  /** Keeps the panel in step: carries out new requests, selects the linked terminal on
   *  arriving in a space, alerts, starts a terminal when there's none and the panel is
   *  open, and keeps the terminal area on the selection. Deferred out of render. */
  tick(cx, space) {
    const req = lastRequest();
    if (req && Number(req.seq) > this.lastSeq) {
      this.lastSeq = Number(req.seq);
      cx.spawn(async (cx) => {
        try { await this.handle(req, cx); } catch (e) { console.log(`[drawer] ${req.op} failed: ${e}`); }
        cx.notify();
      });
    }
    const list = sessions();
    if (space && space.id !== this.lastSpace) {
      this.lastSpace = space.id;
      arriveIn(space);
    }
    this.watchStatus(list);
    this.followAttention(list);
    const needsSession = Boolean(space) && !list.length && !drawerHidden()
      && !state.starting && !state.autoStarted;
    if ((!needsSession && inSync()) || this.syncQueued) return;
    this.syncQueued = true;
    cx.spawn(async (cx) => {
      try {
        if (needsSession) await newSession(space);
        await syncLayout();
      } finally {
        this.syncQueued = false;
      }
      cx.notify();
    });
  }

  /** Maximized: the panel takes a huge weight so the tab area above shrinks to nothing.
   *  Not by hiding the tab area: a key can hide the panel while this mod isn't running,
   *  which would leave the column empty. This way hiding the panel always gives the
   *  space back to the tabs. */
  maximized() {
    return findNode(layout(), DRAWER)?.size?.weight != null;
  }

  toggleMaximized() {
    if (this.maximized()) {
      run("layout.resize", { id: DRAWER, px: Number(shared(RESTORE_PX)) || 260 });
    } else {
      const px = findNode(layout(), DRAWER)?.size?.px;
      if (px) setShared(RESTORE_PX, px);
      run("layout.resize", { id: DRAWER, weight: 1000 });
    }
  }

  hidePanel() {
    run("layout.hide", { id: DRAWER });
  }

  // ---- Views ----------------------------------------------------------------------------

  /** The header across the whole panel: "Terminal" as VS Code's active panel tab on the
   *  left, actions on the right. */
  renderBar(t, space) {
    const max = this.maximized();
    return h_flex()
      .id("drawer-bar")
      .size_full()
      .pl(8)
      .pr(6)
      .gap(2)
      .items_center()
      .bg(t.background)
      .text_size(13)
      .child(div().flex_none().px(9).py(3).rounded(5).bg(t.selected).text_color(t.foreground).child("Terminal"))
      .child(div().flex_1())
      .when(Boolean(space), (el) => el.child(iconButton(t, "drawer-new", "plus", (cx) => this.create(space, cx))))
      .child(div().flex_none().w(1).h(16).mx(4).bg(t.border))
      .child(iconButton(t, "drawer-max", max ? "restore" : "maximize", () => this.toggleMaximized()))
      .child(iconButton(t, "drawer-hide", "x", () => this.hidePanel()));
  }

  openMenu(s) {
    const items = menuItems(s, activeSpace());
    const height = 10 + items.reduce((h, it) => h + (it.sep ? SEP_H : ITEM_H), 0);
    openOverlay({ mod: "drawer", kind: "popup", width: 300, height, props: { role: "menu", terminal: s.address } });
  }

  /** Agent status at the end of a row: spinner, "Needs you" or a done dot. */
  statusBadge(t, s) {
    const st = statusOf(s);
    if (st === "working") return svg(`${ASSETS}/spinner.svg`).size(12).flex_none().text_color(t.working).spin(900);
    if (st === "blocked" || st === "error") {
      return div().flex_none().px(6).h(18).flex().items_center().rounded(5)
        .bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked)
        .child(st === "error" ? "Error" : "Needs you");
    }
    if (st === "done") return div().flex_none().size(7).rounded(4).bg(t.done);
    return null;
  }

  /** The link marker: a link icon for this space's terminals, plus the space's name for
   *  another space's. */
  linkTag(t, s, space) {
    const other = spaceOf(s);
    if (!other) return null;
    const here = other.id === space?.id;
    return h_flex().flex_none().max_w(96).gap(3).items_center().text_size(11)
      .text_color(here ? t.accent : t.dim)
      .child(svg(`${ASSETS}/link.svg`).size(11).flex_none())
      .when(!here, (el) => el.child(div().truncate().child(other.name)));
  }

  /** The terminal list docked on the panel's right, as in VS Code: split groups drawn as a
   *  tree, icon and name per row, status and link at the end, split and trash on hover, a
   *  menu on right-click. */
  renderList(t, space) {
    const list = sessions();
    const sel = selected(list);
    const shownGroup = sel ? groupKey(sel) : null;
    const rows = [];
    for (const group of groups(list)) {
      group.forEach((s, i) => {
        const on = sel?.address === s.address;
        const inShown = groupKey(s) === shownGroup;
        const hot = this.hover === s.address;
        const tree = group.length < 2 ? null : i === 0 ? "┌" : i === group.length - 1 ? "└" : "├";
        const color = colorOf(s, t);
        const badge = this.statusBadge(t, s);
        const tag = hot ? null : this.linkTag(t, s, space);
        rows.push(h_flex()
          .id(`drawer-row-${s.address}`)
          .w_full()
          .h(26)
          .pl(tree ? 2 : 8)
          .pr(4)
          .gap(6)
          .items_center()
          .rounded(5)
          .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(!on, (el) => el.text_color(inShown ? t.foreground : t.muted).hover((st) => st.bg(t.hover)))
          .on_hover((h, cx) => { this.hover = h ? s.address : (this.hover === s.address ? null : this.hover); cx.notify(); })
          .on_click((_e, cx) => this.select(s.address, cx))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(s); })
          .when(Boolean(tree), (el) => el.child(div().flex_none().w(10).text_color(t.dim).child(tree)))
          .child(svg(iconOf(s)).size(14).flex_none().text_color(color ?? (on ? t.foreground : t.muted)))
          .child(div().flex_1().min_w(0).truncate().child(sessionName(s)))
          .when(Boolean(badge), (el) => el.child(badge))
          .when(Boolean(tag), (el) => el.child(tag))
          .when(hot, (el) => el
            .child(iconButton(t, `drawer-split-${s.address}`, "split", (cx) => this.split(s, cx), { size: 13 }))
            .child(iconButton(t, `drawer-kill-${s.address}`, "trash", (cx) => this.kill(s, cx), { size: 13 }))));
      });
    }
    return v_flex()
      .id("drawer-list")
      .size_full()
      .bg(t.background)
      .text_size(13)
      .px(6)
      .pt(2)
      .gap(1)
      .overflow_y_scrollbar()
      .children(rows);
  }

  renderEmpty(t) {
    const space = activeSpace();
    const busy = state.starting;
    return v_flex()
      .id("drawer-empty")
      .size_full()
      .items_center()
      .justify_center()
      .gap(10)
      .bg(t.background)
      .text_size(12)
      .text_color(t.dim)
      .child(busy ? "Starting a terminal…" : "No terminals")
      .when(Boolean(space) && !busy, (el) => el.child(h_flex()
        .id("drawer-empty-new")
        .gap(6).px(10).py(5).rounded(6).border(1).border_color(t.border)
        .text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.create(space, cx))
        .child(svg(`${ASSETS}/plus.svg`).size(13))
        .child("New terminal")));
  }

  // ---- The right-click menu and its pickers ---------------------------------------

  close() {
    closeOverlay(props().overlay);
  }

  choose(it) {
    const p = props();
    this.close();
    if (it.id === "color") openOverlay({ mod: "drawer", kind: "popup", width: 190, height: 10 + COLORS.length * ITEM_H, props: { role: "color", terminal: p.terminal } });
    else if (it.id === "icon") openOverlay({ mod: "drawer", kind: "popup", width: 4 * 40 + 18, height: Math.ceil(ICON_NAMES.length / 4) * 40 + 18, props: { role: "icon", terminal: p.terminal } });
    else if (it.id === "rename") openOverlay({ mod: "drawer", kind: "dialog", width: 380, height: 176, props: { role: "rename", terminal: p.terminal } });
    else request(it.id, { terminal: p.terminal });
  }

  /** Arrow keys, Enter and Esc for a list of `n` choices. */
  listKeys(e, cx, n, pick) {
    if (e.key === "down") this.at = (this.at + 1) % n;
    else if (e.key === "up") this.at = (this.at + n - 1) % n;
    else if (e.key === "enter") pick(this.at);
    else if (e.key === "escape") this.close();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  menuRow(t, id, i, content, onClick) {
    return h_flex()
      .id(id)
      .h(ITEM_H)
      .px(10)
      .gap(9)
      .items_center()
      .rounded(6)
      .when(this.at === i, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { if (h) { this.at = i; cx.notify(); } })
      .on_click(() => onClick())
      .children(content);
  }

  renderMenu(t) {
    const menu = menuItems(terminal(props().terminal), activeSpace());
    const items = menu.filter((it) => !it.sep);
    return v_flex()
      .id("drawer-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.listKeys(e, cx, items.length, (i) => this.choose(items[i])))
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .children(menu.map((it) => {
        if (it.sep) return div().mx(8).my(4).h(1).bg(t.border);
        const i = items.indexOf(it);
        const hint = it.command ? keyHint(it.command) : "";
        return this.menuRow(t, `drawer-mi-${it.id}`, i, [
          div().flex_1().min_w(0).truncate().child(it.label),
          ...(hint ? [div().flex_none().text_size(12).text_color(t.dim).child(hint)] : []),
        ], () => this.choose(it));
      }));
  }

  renderColors(t) {
    const p = props();
    const now = terminal(p.terminal)?.labels?.[L.color] ?? "";
    const pick = (i) => { this.close(); request("color", { terminal: p.terminal, value: COLORS[i][0] }); };
    return v_flex()
      .id("drawer-colors")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.listKeys(e, cx, COLORS.length, pick))
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .children(COLORS.map(([value, key, name], i) => this.menuRow(t, `drawer-color-${i}`, i, [
        div().flex_none().size(10).rounded(5).bg(key ? t[key] : t.foreground),
        div().flex_1().child(name),
        ...(value === now ? [svg(`${ASSETS}/icons/check.svg`).size(13).text_color(t.dim)] : []),
      ], () => pick(i))));
  }

  renderIcons(t) {
    const p = props();
    const s = terminal(p.terminal);
    const now = s?.labels?.[L.icon] || "terminal";
    const color = s ? colorOf(s, t) : null;
    const pick = (i) => { this.close(); request("icon", { terminal: p.terminal, value: ICON_NAMES[i] }); };
    return h_flex()
      .id("drawer-icons")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "right") this.at = (this.at + 1) % ICON_NAMES.length;
        else if (e.key === "left") this.at = (this.at + ICON_NAMES.length - 1) % ICON_NAMES.length;
        else if (e.key === "down") this.at = Math.min(this.at + 4, ICON_NAMES.length - 1);
        else if (e.key === "up") this.at = Math.max(this.at - 4, 0);
        else if (e.key === "enter") pick(this.at);
        else if (e.key === "escape") this.close();
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .w_full()
      .p(9)
      .flex_wrap()
      .bg(t.popover)
      .children(ICON_NAMES.map((name, i) => div()
        .id(`drawer-icon-${name}`)
        .size(40)
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .when(name === now, (el) => el.border(1).border_color(t.accent))
        .when(this.at === i, (el) => el.bg(t.selected))
        .hover((st) => st.bg(t.hover))
        .on_hover((h, cx) => { if (h) { this.at = i; cx.notify(); } })
        .on_click(() => pick(i))
        .child(svg(`${ASSETS}/icons/${name}.svg`).size(18).text_color(color ?? t.foreground))));
  }

  initRename(cx) {
    const t = terminal(props()?.terminal);
    this.text = t?.labels?.[L.name] ?? "";
    this.input = InputState.new({ value: this.text, placeholder: t ? sessionName(t) : "" });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submitRename());
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submitRename() {
    const p = props();
    this.close();
    request("rename", { terminal: p.terminal, value: this.text.trim() });
  }

  renderRename(t) {
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex()
      .id("drawer-rename")
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full()
      .p(18)
      .gap(8)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child("Rename terminal"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8))
      .child(div().text_size(11.5).text_color(t.dim).child("Leave empty to go back to the program's name."))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button("drawer-rn-cancel", "Cancel", false, () => this.close()))
        .child(button("drawer-rn-save", "Rename", true, () => this.submitRename())));
  }

  /** A windowed terminal's title bar: dragging it moves the window. */
  renderTitlebar(t) {
    const p = props();
    const s = terminal(p.terminal);
    const color = s ? colorOf(s, t) : null;
    const badge = s ? this.statusBadge(t, s) : null;
    return h_flex()
      .id("drawer-titlebar")
      .size_full()
      .pl(12)
      .pr(6)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .text_size(13)
      .text_color(t.foreground)
      .child(svg(s ? iconOf(s) : `${ASSETS}/icons/terminal.svg`).size(14).flex_none().text_color(color ?? t.muted))
      .child(div().flex_1().min_w(0).truncate().child(s ? sessionName(s) : "Terminal"))
      .when(Boolean(badge), (el) => el.child(badge))
      .child(iconButton(t, "drawer-win-panel", "panel", () => {
        this.close();
        run("layout.show", { id: DRAWER });
        request("toPanel", { terminal: p.terminal });
      }))
      .child(iconButton(t, "drawer-win-kill", "trash", () => run("terminal.kill", { terminal: p.terminal })));
  }

  render(cx) {
    const t = theme();
    switch (this.role) {
      case "empty": return this.renderEmpty(t);
      case "list": return this.renderList(t, activeSpace());
      case "menu": return this.renderMenu(t);
      case "color": return this.renderColors(t);
      case "icon": return this.renderIcons(t);
      case "rename": return this.renderRename(t);
      case "titlebar": return this.renderTitlebar(t);
    }
    const space = activeSpace();
    this.tick(cx, space);
    return this.renderBar(t, space);
  }
}
