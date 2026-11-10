// This node's own credentials. rest-api knows which node is calling from
// NODE_API_KEY, so none of these take a node id.
import { StreamwizardApi, nullOnStatus } from "./client";

export interface WsToken {
  /** Short-lived token for one role=ingest-node upgrade. It names this node, and only rest-api can sign it. */
  token: string;
  /** ws-server base URL, e.g. wss://ws.example.com. */
  ws_server_url: string;
}

/**
 * A fresh token for the ws-server socket. It only has to be valid at the
 * upgrade, so the socket client asks for a new one before every dial. Returns
 * null when this environment has no ws-server configured (404); any other
 * failure throws.
 */
export async function getWsToken(): Promise<WsToken | null> {
  return nullOnStatus(404, () => StreamwizardApi.post<WsToken>("/api/ingest-nodes/me/ws-token"));
}
