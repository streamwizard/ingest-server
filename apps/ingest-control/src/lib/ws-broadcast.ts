import type { BotOutboundMessage, BotPongMessage } from "@repo/types";
import { env } from "./env";

// Pushes live events into ws-server's room system as a "bot" client, the same
// mechanism the Discord bot uses to fan out overlay events. Mirrors
// apps/streamwizard-bot/src/overlay-ws-client.ts.
//
// Reconnection is deliberately paranoid: the socket is send-only apart from
// heartbeat pongs, so a half-open TCP connection looks OPEN forever, and a
// redial that fails without firing `close` would otherwise end the retry
// chain. A watchdog interval owns liveness instead of trusting socket events.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
/** Three missed pings before the connection is declared dead. */
const PONG_TIMEOUT_MS = 45_000;
const DIAL_TIMEOUT_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 5_000;

class WsBroadcastClient {
  private ws: WebSocket | null = null;
  private delay = BASE_DELAY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private dialedAt = 0;
  /** Last proof the current connection is alive: open event or any inbound message. */
  private lastAliveAt = 0;
  // Until the server has ponged once this process, the pong deadline is not
  // enforced — an updated node talking to a not-yet-redeployed ws-server
  // (which drops pings as malformed) must not flap every PONG_TIMEOUT_MS.
  private serverSupportsPong = false;

  connect(): void {
    if (!env.WS_SERVER_URL) return;
    this.stopping = false;
    this.dial();
    this.watchdog ??= setInterval(() => this.checkHealth(), WATCHDOG_INTERVAL_MS);
    this.pingTimer ??= setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  send(message: BotOutboundMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Open and, once the server has proven it pongs, heartbeat-fresh.
   * Reported into host_system as `ws_broadcast_connected` for the alerter. */
  isConnected(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    if (!this.serverSupportsPong) return true;
    return Date.now() - this.lastAliveAt <= PONG_TIMEOUT_MS;
  }

  private dial(): void {
    // `source` labels this connection in ws-server's monitor view and metrics
    // — identity only, authorization still rides the Bearer header.
    const source = encodeURIComponent(`ingest-node:${env.INGEST_NODE_ID}`);
    const ws = new WebSocket(`${env.WS_SERVER_URL}/ws?role=bot&source=${source}`, {
      // @ts-expect-error Bun WebSocket supports headers in options
      headers: { Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
    });
    this.ws = ws;
    this.dialedAt = Date.now();

    // Every handler ignores sockets we've already replaced, so a stale
    // socket's late events can't touch current state or double-schedule.
    ws.onopen = () => {
      if (ws !== this.ws) return;
      console.log("[ws-broadcast] connected");
      this.delay = BASE_DELAY_MS;
      this.lastAliveAt = Date.now();
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      this.lastAliveAt = Date.now();
      try {
        const msg = JSON.parse(String(event.data)) as BotPongMessage;
        if (msg.kind === "pong") this.serverSupportsPong = true;
      } catch {
        // Any inbound traffic already counts as liveness.
      }
    };

    ws.onclose = () => {
      if (ws !== this.ws || this.stopping) return;
      console.log("[ws-broadcast] disconnected");
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
    if (this.stopping) return;
    const now = Date.now();

    // Retry chain died (e.g. a failed dial that never fired `close`).
    if ((this.ws === null || this.ws.readyState === WebSocket.CLOSED) && this.retryTimer === null) {
      console.log("[ws-broadcast] socket closed with no retry pending — redialing");
      this.teardownAndReconnect();
      return;
    }

    // Handshake hung.
    if (this.ws?.readyState === WebSocket.CONNECTING && now - this.dialedAt > DIAL_TIMEOUT_MS) {
      console.log("[ws-broadcast] dial timeout — redialing");
      this.teardownAndReconnect();
      return;
    }

    // Half-open: still OPEN but the server stopped answering pings.
    if (this.ws?.readyState === WebSocket.OPEN && this.serverSupportsPong && now - this.lastAliveAt > PONG_TIMEOUT_MS) {
      console.log(`[ws-broadcast] heartbeat timeout (no pong for ${now - this.lastAliveAt}ms) — redialing`);
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
    console.log(`[ws-broadcast] retrying in ${wait}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.dial();
    }, wait);
    this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
  }
}

export const wsBroadcastClient = new WsBroadcastClient();
