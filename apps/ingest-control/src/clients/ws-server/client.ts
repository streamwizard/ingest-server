// This node's socket to ws-server (role=ingest-node), which carries the live
// stats the auto-switcher acts on. rest-api is deliberately not on this path:
// it only signs the token for each dial, so a rest-api restart doesn't cut an
// open socket, and live streams don't look silent (and get switched offline)
// while rest-api is down.
//
// The token is short-lived and names this node; ws-server reads the node from
// it and the user from the session rest-api registered. The node holds no
// credential that works for any other node or user.
//
// Reconnection is deliberately paranoid: the socket is send-only apart from
// heartbeat pongs, so a half-open TCP connection looks OPEN forever, and a
// redial that fails without firing `close` would otherwise end the retry
// chain. A watchdog interval owns liveness instead of trusting socket events.
import type { IngestNodeOutboundMessage } from "@repo/types";
import { getWsToken } from "../streamwizard-api/nodes";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
/** Three missed pings before the connection is declared dead. */
const PONG_TIMEOUT_MS = 45_000;
const DIAL_TIMEOUT_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 5_000;

/** `disabled`: rest-api says this environment has no ws-server, so there is nothing to connect to. */
export type WsConnectionState = "disabled" | "connected" | "disconnected";

class WsServerClient {
  private ws: WebSocket | null = null;
  private delay = BASE_DELAY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  /** True while a dial is fetching its token, before a socket exists. */
  private dialing = false;
  private disabled = false;
  private dialedAt = 0;
  /** Last proof the current connection is alive: open event or any inbound message. */
  private lastAliveAt = 0;

  connect(): void {
    this.stopping = false;
    void this.dial();
    this.watchdog ??= setInterval(() => this.checkHealth(), WATCHDOG_INTERVAL_MS);
    this.pingTimer ??= setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  /** For tests and shutdown. */
  close(): void {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = this.watchdog = this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  send(message: IngestNodeOutboundMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Reported into host_system as `ws_broadcast_connected` for the alerter. */
  state(): WsConnectionState {
    if (this.disabled) return "disabled";
    if (this.ws?.readyState !== WebSocket.OPEN) return "disconnected";
    return Date.now() - this.lastAliveAt <= PONG_TIMEOUT_MS ? "connected" : "disconnected";
  }

  private async dial(): Promise<void> {
    if (this.dialing || this.stopping) return;
    this.dialing = true;
    let auth: Awaited<ReturnType<typeof getWsToken>>;
    try {
      auth = await getWsToken();
    } catch {
      // The rest-api client already logged why.
      this.dialing = false;
      this.scheduleReconnect();
      return;
    }
    this.dialing = false;
    if (this.stopping) return;

    if (!auth) {
      if (!this.disabled) console.log("[ws-server] not configured for this environment; live push is off");
      this.disabled = true;
      // Check again now and then, so configuring ws-server later needs no node restart.
      this.delay = MAX_DELAY_MS;
      this.scheduleReconnect();
      return;
    }
    this.disabled = false;

    const ws = new WebSocket(`${auth.ws_server_url}/ws?role=ingest-node`, {
      // @ts-expect-error Bun WebSocket supports headers in options
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    this.ws = ws;
    this.dialedAt = Date.now();

    // Every handler ignores sockets we've already replaced, so a stale
    // socket's late events can't touch current state or double-schedule.
    ws.onopen = () => {
      if (ws !== this.ws) return;
      console.log("[ws-server] connected");
      this.delay = BASE_DELAY_MS;
      this.lastAliveAt = Date.now();
    };

    // The only thing ws-server sends this socket is a pong, and any inbound
    // message is proof of life, so there is nothing to parse.
    ws.onmessage = () => {
      if (ws !== this.ws) return;
      this.lastAliveAt = Date.now();
    };

    ws.onclose = () => {
      if (ws !== this.ws || this.stopping) return;
      console.log("[ws-server] disconnected");
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  private sendPing(): void {
    this.send({ kind: "ping", ts: Date.now() });
  }

  /** Liveness authority: recovers every state socket events can strand us in. */
  private checkHealth(): void {
    if (this.stopping || this.dialing) return;
    const now = Date.now();

    // Retry chain died (e.g. a failed dial that never fired `close`).
    if ((this.ws === null || this.ws.readyState === WebSocket.CLOSED) && this.retryTimer === null) {
      console.log("[ws-server] socket closed with no retry pending — redialing");
      this.teardownAndReconnect();
      return;
    }

    // Handshake hung.
    if (this.ws?.readyState === WebSocket.CONNECTING && now - this.dialedAt > DIAL_TIMEOUT_MS) {
      console.log("[ws-server] dial timeout — redialing");
      this.teardownAndReconnect();
      return;
    }

    // Half-open: still OPEN but the server stopped answering pings.
    if (this.ws?.readyState === WebSocket.OPEN && now - this.lastAliveAt > PONG_TIMEOUT_MS) {
      console.log(`[ws-server] heartbeat timeout (no pong for ${now - this.lastAliveAt}ms) — redialing`);
      this.teardownAndReconnect();
    }
  }

  private teardownAndReconnect(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Closing an already-dead socket may throw; the socket is abandoned either way.
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.retryTimer !== null) return;
    // ±20% jitter so a fleet dropped by one server restart doesn't redial in lockstep.
    const wait = Math.round(this.delay * (0.8 + Math.random() * 0.4));
    if (!this.disabled) console.log(`[ws-server] retrying in ${wait}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.dial();
    }, wait);
    this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
  }
}

export const wsServerClient = new WsServerClient();
