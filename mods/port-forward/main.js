// Port tunnels: finds dev-server URLs on remote terminals, opens a local
// ssh -L per (machine, port), and drops it when the terminal that printed it ends.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import * as herdr from "herdr";
import {
  exec, focused, hc, machines, notify, props, setShared,
  shared, spaces, terminals, theme, window,
} from "herdr";
import {
  forward, lane, lastLine, logName, normalizeState, portsFromLsof, portsFromSs, portsIn, released,
  tunnelName, watchOf,
} from "./tunnels.js";

const KEY = "port-forward";
const WAIT_SECS = 25;
const WAIT_FAILURES = 3;
const DEBOUNCE_MS = 2000;
const LISTEN_BACKOFF_MS = [1000, 2000, 4000];
const LOCAL_PORT_TRIES = 20;
const LISTEN_TRIES = 20;
const LISTEN_POLL_MS = 300;
const KILL_MS = 200;
const TUNNEL_PREFIX = "pf-tunnel-";

const read = () => normalizeState(shared(KEY));

// Shared state changes only when its normalized value does.
function write(next) {
  const current = read();
  const wanted = normalizeState(next);
  if (JSON.stringify(current) !== JSON.stringify(wanted)) setShared(KEY, wanted);
}

const sleep = (ms) => exec("sleep", [String(ms / 1000)]);

function parseJson(text) {
  try {
    return JSON.parse(String(text ?? "").trim());
  } catch {
    return null;
  }
}

export default class PortForward extends View {
  init(_props, cx) {
    this.chip = null;
    this.formError = "";
    this.formBusy = false;
    this.portFocused = false;
    this.machineTargets = null;

    this.active = false;
    this.watches = new Map();
    this.shownBy = new Map();
    this.gens = 0;
    this.cleaning = false;
    this.readLane = lane();
    this.tunnelLane = lane();

    this.portInput = InputState.new({ placeholder: "3000" });
    this.portInput.on("change", (_e, cx) => { this.formError = ""; cx.notify(); });
    this.portInput.on("submit", (_e, cx) => this.add(cx));
    this.portInput.on("focus", (_e, cx) => { this.portFocused = true; cx.notify(); });
    this.portInput.on("blur", (_e, cx) => { this.portFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();

    // `checking` arrived after 0.1.14; without it the check would sweep tunnels.
    if (herdr.checking?.()) return;
    // A copy opened with mod.open only renders; the layout's copy owns the tunnels.
    if (props()?.overlay) return;

    cx.spawn(async (cx) => {
      await this.adopt();
      await this.sweep();
      this.active = true;
      this.sync(cx);
      cx.notify();
    });
  }

  close() {
    this.active = false;
    this.watches.clear();
  }

  // Adopts tunnels whose ssh terminal survived a reload; forgets the rest.
  async adopt() {
    const current = read();
    const all = terminals();
    if (!all.length) return;
    const live = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const keep = current.tunnels.filter((t) => {
      const term = live.get(t.tunnelTerminal);
      return Boolean(term) && Array.isArray(term.argv) && term.argv.includes(forward(t));
    });
    if (keep.length !== current.tunnels.length) write({ ...current, tunnels: keep });
  }

  // A tunnel terminal no record knows about is from a build that died mid-start.
  // Herdr before 0.1.15 runs init for real during a check, with empty shared state:
  // then every live tunnel looks unknown, so sweeping waits for a real workspace.
  async sweep() {
    if (shared(KEY) === undefined) return;
    const known = new Set(read().tunnels.map((t) => t.tunnelTerminal));
    for (const term of terminals()) {
      if (term.state === "live" && typeof term.name === "string"
        && term.name.startsWith(TUNNEL_PREFIX) && !known.has(term.address)) {
        await this.kill(term.address);
      }
    }
  }

  // The one place that follows live data. Render calls it on every change, so it
  // only diffs: new or changed terminals start work, vanished ones stop it.
  sync(cx) {
    if (!this.active) return;
    const all = terminals();
    const live = all.filter((t) => t.state === "live" && typeof t.address === "string");
    const liveSet = new Set(live.map((t) => t.address));
    const ready = new Set(machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name));
    const remote = new Map();
    for (const term of live) {
      const slash = term.address.indexOf("/");
      if (slash > 0 && ready.has(term.address.slice(0, slash))) remote.set(term.address, term);
    }

    const gone = [];
    for (const address of [...this.watches.keys()]) {
      if (remote.has(address)) continue;
      this.watches.delete(address);
      gone.push(address);
    }

    const starts = [];
    for (const [address, term] of remote) {
      const { kind, key } = watchOf(term);
      const watch = this.watches.get(address);
      if (!watch || watch.kind !== kind) {
        const machine = address.slice(0, address.indexOf("/"));
        const fresh = { machine, kind, key, phase: "idle", gen: ++this.gens };
        this.watches.set(address, fresh);
        starts.push([address, fresh]);
      } else if (kind === "agent" && watch.key !== key) {
        watch.key = key;
        if (watch.phase === "idle") starts.push([address, watch]);
      }
    }

    for (const [address, watch] of starts) {
      cx.spawn(async () => {
        try {
          if (watch.kind === "agent") await this.followAgent(address, watch);
          else await this.followProgram(address, watch);
        } catch (error) {
          console.error("port-forward: watch", address, error);
        }
      });
    }

    for (const address of gone) this.forget(address);

    if (all.length && !this.cleaning && this.endedTunnels(liveSet).length) {
      this.cleaning = true;
      cx.spawn(async () => {
        try {
          await this.tunnelLane(() => this.cleanup());
        } catch (error) {
          console.error("port-forward: cleanup", error);
        } finally {
          this.cleaning = false;
        }
      });
    }
  }

  current(address, watch) {
    return this.active && this.watches.get(address)?.gen === watch.gen;
  }

  // An agent is read once per state or turn change; a change that lands mid-read
  // makes the loop read again.
  async followAgent(address, watch) {
    while (this.current(address, watch)) {
      const key = watch.key;
      watch.phase = "reading";
      await this.scanTerminal(address, watch);
      if (watch.key === key) break;
    }
    watch.phase = "idle";
  }

  // Waits for any "://" the terminal prints. The pause before each read lets a
  // server's burst of URL lines land first and keeps chatty logs from looping fast.
  // A terminal whose wait ends for any other reason is parked, not retried: it is
  // gone or blocked, and sync would only start the same wait again.
  async followProgram(address, watch) {
    watch.phase = "reading";
    await this.scanTerminal(address, watch);
    let failures = 0;
    while (this.current(address, watch)) {
      watch.phase = "waiting";
      let result = null;
      try {
        result = await hc(["wait", address, "--output", "://", "--timeout", String(WAIT_SECS), "--json"]);
      } catch {}
      if (!this.current(address, watch)) return;
      const reason = result?.code === 0 ? parseJson(result.stdout)?.reason : null;
      if (reason === "timeout") {
        failures = 0;
        continue;
      }
      if (reason !== "output") {
        if (reason || ++failures >= WAIT_FAILURES) break;
        await sleep(DEBOUNCE_MS * failures);
        continue;
      }
      failures = 0;
      await sleep(DEBOUNCE_MS);
      if (!this.current(address, watch)) return;
      watch.phase = "reading";
      await this.scanTerminal(address, watch);
    }
    if (this.current(address, watch)) watch.phase = "idle";
  }

  async scanTerminal(address, watch) {
    const screen = await this.readLane(() => hc(["read", address, "--lines", "40"])).catch(() => null);
    if (!this.current(address, watch) || !screen || screen.code !== 0) return;

    const ports = portsIn(screen.stdout);
    this.shown(address, new Set(ports.map((port) => `${watch.machine}:${port}`)));
    for (const remotePort of ports) {
      if (!this.current(address, watch)) return;
      try {
        await this.consider({ machine: watch.machine, remotePort, terminal: address }, address, watch);
      } catch (error) {
        console.error("port-forward: tunnel", `${watch.machine}:${remotePort}`, error);
      }
    }
  }

  // A dismissal ends once no terminal shows its URL any more.
  shown(address, ids) {
    const prev = this.shownBy.get(address) ?? new Set();
    this.shownBy.set(address, ids);
    const others = [...this.shownBy].filter(([a]) => a !== address).map(([, set]) => set);
    this.release(released(prev, ids, others));
  }

  forget(address) {
    const prev = this.shownBy.get(address);
    if (!prev) return;
    this.shownBy.delete(address);
    this.release(released(prev, new Set(), this.shownBy.values()));
  }

  release(ids) {
    if (!ids.length) return;
    const next = read();
    next.dismissed = next.dismissed.filter((id) => !ids.includes(id));
    write(next);
  }

  wanted(id) {
    const now = read();
    return !now.tunnels.some((t) => t.id === id) && !now.dismissed.includes(id);
  }

  // A server prints its URL before it listens, so a closed port is retried
  // with backoff for this one candidate and then left until the next event.
  async consider(candidate, address, watch) {
    const id = `${candidate.machine}:${candidate.remotePort}`;
    for (let attempt = 0; ; attempt++) {
      if (!this.wanted(id)) return;
      if (await this.listening(candidate.machine, candidate.remotePort)) break;
      if (attempt >= LISTEN_BACKOFF_MS.length) return;
      await sleep(LISTEN_BACKOFF_MS[attempt]);
      if (!this.current(address, watch)) return;
    }
    await this.tunnelLane(() => this.openAuto(candidate, id));
  }

  async openAuto(candidate, id) {
    if (!this.wanted(id)) return;
    const tunnel = await this.createTunnel({ ...candidate, source: "auto" });
    const next = read();
    // A × during the ssh start must win over the tunnel that just came up.
    if (next.dismissed.includes(id) || next.tunnels.some((t) => t.id === id)) {
      await this.kill(tunnel.tunnelTerminal);
      return;
    }
    next.tunnels = [...next.tunnels.filter((t) => t.id !== id), tunnel];
    write(next);
    if (tunnel.state === "up") {
      notify({
        title: "Tunnel ready",
        body: `${candidate.machine}:${candidate.remotePort} → localhost:${tunnel.localPort}`,
      });
    }
  }

  // The source terminal ending closes the tunnel, and so does the ssh terminal
  // dying on its own: the record would otherwise stay "up" with nothing behind it.
  endedTunnels(liveSet) {
    return read().tunnels.filter((t) =>
      (t.terminal && !liveSet.has(t.terminal)) || (t.tunnelTerminal && !liveSet.has(t.tunnelTerminal)));
  }

  async cleanup() {
    const all = terminals();
    if (!all.length) return;
    const liveSet = new Set(all.filter((t) => t.state === "live").map((t) => t.address));
    const ended = [];
    for (const tunnel of this.endedTunnels(liveSet)) {
      // The terminal list can trail a tunnel that just started; ask the core before killing it.
      if (liveSet.has(tunnel.terminal) || !tunnel.terminal) {
        const got = await hc(["get", tunnel.tunnelTerminal, "--json"]).catch(() => null);
        if (got?.code === 0 && parseJson(got.stdout)?.state === "live") continue;
      }
      ended.push(tunnel);
    }
    for (const tunnel of ended) await this.kill(tunnel.tunnelTerminal);
    if (!ended.length) return;
    const ids = new Set(ended.map((t) => t.id));
    const next = read();
    next.tunnels = next.tunnels.filter((t) => !ids.has(t.id));
    write(next);
  }

  // A port `ss` cannot see may still be there: a machine without ss or lsof is not a reason to skip.
  async listening(machine, port) {
    try {
      const ss = await exec("ss", ["-ltnH"], { on: machine });
      if (ss.code === 0) return portsFromSs(ss.stdout).has(port);
    } catch {}
    try {
      const lsof = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { on: machine });
      if (lsof.code === 0) return portsFromLsof(lsof.stdout).has(port);
    } catch {}
    return true;
  }

  async target(machine) {
    let entry = (await this.targets()).get(machine);
    if (!entry) {
      this.machineTargets = null;
      entry = (await this.targets()).get(machine);
    }
    if (!entry) throw new Error(`Unknown machine ${machine}.`);
    if (entry.via) throw new Error("machine uses a custom connection");
    if (typeof entry.target !== "string" || !entry.target) throw new Error(`Machine ${machine} has no ssh target.`);
    return entry.target;
  }

  async targets() {
    if (this.machineTargets) return this.machineTargets;
    const result = await hc(["machine", "ls", "--json"]);
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || "hc machine ls failed.");
    const parsed = parseJson(result.stdout);
    if (!parsed) throw new Error("hc machine ls returned no JSON.");
    this.machineTargets = new Map((parsed.machines ?? []).map((m) => [m.name, m]));
    return this.machineTargets;
  }

  // Tries local ports from the remote one. Only a busy local port moves on; any
  // other ssh failure is reported once and left for the person to close.
  async createTunnel({ machine, remotePort, terminal, source }) {
    const id = `${machine}:${remotePort}`;
    const base = {
      id,
      machine,
      remotePort,
      localPort: remotePort,
      tunnelTerminal: null,
      url: `http://localhost:${remotePort}`,
      terminal,
      source,
      state: "error",
      error: null,
    };

    let target;
    try {
      target = await this.target(machine);
    } catch (error) {
      return { ...base, error: String(error?.message ?? error) };
    }

    let failure = "No free local port.";
    for (let attempt = 0; attempt < LOCAL_PORT_TRIES; attempt++) {
      const localPort = remotePort + attempt;
      if (localPort > 65535) break;
      const name = tunnelName(machine, localPort);

      let started;
      try {
        started = await hc([
          "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", name, "--",
          "ssh", "-N",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "BatchMode=yes",
          "-o", "ServerAliveInterval=15",
          "-o", "ServerAliveCountMax=3",
          "-L", `127.0.0.1:${localPort}:localhost:${remotePort}`,
          target,
        ]);
      } catch (error) {
        return { ...base, error: String(error?.message ?? error) };
      }
      if (started.code !== 0) return { ...base, error: lastLine(started.stderr) || "hc run failed." };

      const address = parseJson(started.stdout)?.address;
      if (!address) return { ...base, error: "hc run did not report a terminal." };

      const ready = await this.waitListening(localPort);
      const got = await hc(["get", address, "--json"]).catch(() => null);
      const term = got?.code === 0 ? parseJson(got.stdout) : null;
      if (ready && term?.state === "live") {
        return {
          ...base,
          localPort,
          tunnelTerminal: address,
          url: `http://localhost:${localPort}`,
          state: "up",
          error: null,
        };
      }

      const screen = await hc(["read", address]).catch(() => null);
      const text = screen?.stdout ?? "";
      await this.kill(address);
      if (/Address already in use/i.test(text)) {
        failure = lastLine(text);
        continue;
      }
      return { ...base, error: lastLine(text) || "ssh exited before the tunnel came up." };
    }

    return { ...base, error: failure };
  }

  // ssh reports a live terminal before its forward is listening; a record written
  // that early gives a link that cannot connect yet. Wait for the local listener.
  async waitListening(port) {
    for (let attempt = 0; attempt < LISTEN_TRIES; attempt++) {
      let res;
      try {
        res = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
      } catch {
        return true;
      }
      if (res.code === 0 && res.stdout.trim()) return true;
      await sleep(LISTEN_POLL_MS);
    }
    return false;
  }

  async kill(address) {
    if (!address) return;
    try {
      await hc(["kill", address]);
    } catch {}
    await sleep(KILL_MS);
    try {
      await hc(["rm", address]);
    } catch {}
  }

  async addManual(machine, remotePort) {
    const id = `${machine}:${remotePort}`;
    const existing = read().tunnels.find((t) => t.id === id);
    if (existing?.state === "up") return "That tunnel is already open.";
    if (existing) await this.kill(existing.tunnelTerminal);

    const cleaned = read();
    cleaned.tunnels = cleaned.tunnels.filter((t) => t.id !== id);
    cleaned.dismissed = cleaned.dismissed.filter((d) => d !== id);
    write(cleaned);

    const tunnel = await this.createTunnel({ machine, remotePort, terminal: null, source: "manual" });
    if (tunnel.state !== "up") return tunnel.error || "Could not open the tunnel.";

    const next = read();
    next.tunnels = [...next.tunnels.filter((t) => t.id !== id), tunnel];
    write(next);
    return "";
  }

  remoteMachines() {
    return machines().filter((m) => m.name && m.layout === "ready");
  }

  selectedMachine() {
    const list = this.remoteMachines();
    const names = new Set(list.map((m) => m.name));
    if (this.chip && names.has(this.chip)) return this.chip;
    const space = spaces().find((s) => s.id === focused()?.space);
    if (space?.machine && names.has(space.machine)) return space.machine;
    return list[0]?.name ?? null;
  }

  add(cx) {
    if (this.formBusy) return;
    const machine = this.selectedMachine();
    if (!machine) {
      this.formError = "No connected machine.";
      return cx.notify();
    }
    const port = Number(this.portInput.value().trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.formError = "Port must be 1–65535.";
      return cx.notify();
    }

    this.formBusy = true;
    this.formError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const error = await this.tunnelLane(() => this.addManual(machine, port));
        if (error) this.formError = error;
        else this.portInput.set_value("");
      } catch (error) {
        this.formError = String(error);
      } finally {
        this.formBusy = false;
        cx.notify();
      }
    });
  }

  dismiss(tunnel, cx) {
    cx.spawn(async (cx) => {
      // Cleanup may have removed it already; never kill a terminal that is no longer ours.
      const current = read().tunnels.find((t) => t.id === tunnel.id);
      if (current) await this.kill(current.tunnelTerminal);
      const next = read();
      next.tunnels = next.tunnels.filter((t) => t.id !== tunnel.id);
      if (!next.dismissed.includes(tunnel.id)) next.dismissed.push(tunnel.id);
      write(next);
      cx.notify();
    });
  }

  open(tunnel) {
    const command = window()?.platform === "macos" ? "open" : "xdg-open";
    exec(command, [tunnel.url]).catch((error) => console.error("port-forward: open", error));
  }

  row(t, tunnel) {
    const up = tunnel.state === "up";
    const link = h_flex().id(`pf-open-${logName(tunnel.id)}`).flex_1().min_w(0).gap(6).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => this.open(tunnel))
      .child(div().w(7).h(7).flex_none().rounded(4).bg(up ? t.done : t.blocked))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(tunnel.machine))
      .child(div().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`localhost:${tunnel.localPort}`));

    return v_flex().gap(2)
      .child(h_flex().items_center().gap(6)
        .child(link)
        .child(h_flex().id(`pf-close-${logName(tunnel.id)}`).w(20).h(20).items_center().justify_center()
          .rounded(5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.dismiss(tunnel, cx))
          .child("×")))
      .when(Boolean(tunnel.error), (el) => el.child(
        div().pl(13).text_size(11).text_color(t.blocked).truncate().child(tunnel.error),
      ));
  }

  form(t) {
    const list = this.remoteMachines();
    const selected = this.selectedMachine();
    const chips = list.map((m) =>
      h_flex().id(`pf-machine-${logName(m.name)}`).h(22).px(7).items_center().rounded(5)
        .bg(m.name === selected ? t.selected : t.raised)
        .text_color(m.name === selected ? t.foreground : t.muted)
        .text_size(11).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.chip = m.name; this.formError = ""; cx.notify(); })
        .child(m.name));

    return v_flex().gap(6).pt(2)
      .child(list.length
        ? h_flex().gap(4).flex_wrap().children(chips)
        : div().text_size(11).text_color(t.dim).child("No connected machines."))
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.portInput).flex_1().h(28).px(8).rounded(6)
          .border(1).border_color(this.portFocused ? t.accent : t.input)
          .bg(t.background).text_size(12).text_color(t.foreground))
        .child(h_flex().id("pf-submit").h(28).px(10).items_center().rounded(6)
          .bg(t.solid).text_color(t.solid_foreground).text_size(11.5).font_medium()
          .cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => this.add(cx))
          .child(this.formBusy ? "…" : "Add")))
      .when(Boolean(this.formError), (el) => el.child(
        div().text_size(11).text_color(t.blocked).child(this.formError),
      ));
  }

  panelView(t, current) {
    return v_flex().id("port-forward-root").size_full().p(12).gap(10)
      .text_size(12).text_color(t.foreground)
      .child(h_flex().items_center().justify_between()
        .child(div().font_semibold().text_size(13).child("Port tunnels"))
        .child(div().text_size(10.5).text_color(t.dim).child(`${current.tunnels.length} open`)))
      .child(this.form(t))
      .when(current.tunnels.length > 0, (el) =>
        el.child(v_flex().gap(4).flex_1().min_h(0).overflow_y_scrollbar()
          .children(current.tunnels.map((tunnel) => this.row(t, tunnel)))))
      .when(current.tunnels.length === 0, (el) =>
        el.child(div().text_size(11).text_color(t.dim)
          .child("Tunnels appear here when a remote terminal prints a localhost URL.")));
  }

  render(cx) {
    if (props()?.overlay) return div();
    this.sync(cx);
    return this.panelView(theme(), read());
  }
}
