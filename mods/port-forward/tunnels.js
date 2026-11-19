// Pure helpers for the port-forward mod: screen text, listener output, and the
// shared state's canonical shape. No herdr imports, so this file runs under
// plain node for tests.

const URL = /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):(\d{2,5})/gi;

/** Ports a terminal's screen advertises, in order, once per port. */
export function portsIn(text) {
  const ports = [];
  const re = new RegExp(URL.source, URL.flags);
  for (const match of String(text ?? "").matchAll(re)) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.includes(port)) continue;
    ports.push(port);
  }
  return ports;
}

/** Listening TCP ports from `ss -ltnH`. The fourth column is the local address;
 *  the last one is the peer, whose port is `*`, so reading the line's last colon
 *  finds no port. */
export function portsFromSs(text) {
  const ports = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/);
    const local = fields.length >= 4 ? fields[3] : "";
    const match = local.match(/:(\d+)$/) ?? line.match(/:(\d+)\b/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

/** Listening TCP ports from `lsof -nP -iTCP -sTCP:LISTEN`. */
export function portsFromLsof(text) {
  const ports = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/) ?? line.match(/TCP\s+\S*:(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

/** The `-L` value `ssh` and `hc ls` show for a tunnel. */
export function forward(tunnel) {
  return `127.0.0.1:${tunnel.localPort}:localhost:${tunnel.remotePort}`;
}

/** A terminal name hc accepts: 1-32 of a-z 0-9 - _. */
export function tunnelName(machine, localPort) {
  const name = `pf-tunnel-${machine}-${localPort}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return name.slice(0, 32).replace(/-+$/, "");
}

/** An id made safe for a file name. */
export function logName(id) {
  return String(id).replace(/[^\w.-]+/g, "_");
}

/** The last non-empty line of a log, capped for shared state. */
export function lastLine(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

function canonicalTunnel(t) {
  return {
    id: t.id,
    machine: t.machine,
    remotePort: t.remotePort,
    localPort: t.localPort,
    tunnelTerminal: t.tunnelTerminal ?? null,
    url: t.url,
    terminal: t.terminal ?? null,
    source: t.source,
    state: t.state,
    error: typeof t.error === "string" ? t.error : null,
  };
}

function isTunnel(t) {
  return Boolean(t) && typeof t === "object"
    && typeof t.id === "string" && typeof t.machine === "string"
    && Number.isFinite(t.remotePort) && Number.isFinite(t.localPort)
    && (t.tunnelTerminal == null || typeof t.tunnelTerminal === "string")
    && typeof t.url === "string" && (t.terminal == null || typeof t.terminal === "string")
    && (t.source === "auto" || t.source === "manual")
    && (t.state === "up" || t.state === "error");
}

/** The shared value, with invalid entries dropped and every key in one order. */
export function normalizeState(raw) {
  const tunnels = Array.isArray(raw?.tunnels) ? raw.tunnels.filter(isTunnel).map(canonicalTunnel) : [];
  const dismissed = Array.isArray(raw?.dismissed) ? raw.dismissed.filter((id) => typeof id === "string") : [];
  return { tunnels, dismissed: [...new Set(dismissed)] };
}

/** What a terminal needs watching for. An agent is read when its state or turn
 *  changes (its `msg` changes on every tool call, so it stays out of the key);
 *  a program is waited on for output. */
export function watchOf(term) {
  const status = term?.status;
  if (!status) return { kind: "program", key: null };
  return { kind: "agent", key: `${status.state}|${term.turn}` };
}

/** Ids `prev` showed that neither `next` nor any other terminal's set shows now. */
export function released(prev, next, others) {
  const rest = [...others];
  return [...prev].filter((id) => !next.has(id) && !rest.some((set) => set.has(id)));
}

/** Runs tasks one at a time in call order; a failed task does not stop the next. */
export function lane() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}
