// HTTP client for the panel's rest-api (`/api/ingest-nodes/*`). Every database
// read and write this node does goes through here, and so does the token for
// its ws-server socket: the node holds no database or ws-server credentials of
// its own, only NODE_API_KEY, which rest-api uses to know which node is
// calling. The per-domain modules next to this file are the only ones that
// should import it.
import axios from "axios";

// Read straight from process.env rather than lib/env so the client can be
// loaded on its own in tests. lib/env still requires both at startup.
const apiUrl = process.env.REST_API_URL;
const nodeApiKey = process.env.NODE_API_KEY;

if (!apiUrl || !nodeApiKey) {
  throw new Error("REST_API_URL and NODE_API_KEY must be set");
}

// Everything here is small JSON, so no request has a reason to run long. The
// timeout matters most for authorize: the media plane gives up on its own
// control call after INGEST_CONTROL_TIMEOUT (5s by default), so a hung
// rest-api request must fail before that, not after.
const REQUEST_TIMEOUT_MS = 4_000;

export const StreamwizardApi = axios.create({
  baseURL: apiUrl,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${nodeApiKey}`,
  },
});

StreamwizardApi.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url;
    console.warn("[rest-api] request failed", { status, url, message: error.message });
    return Promise.reject(error);
  },
);

/** Runs a request and turns the given status into null; any other failure still throws. */
export async function nullOnStatus<T>(status: number, request: () => Promise<{ data: T }>): Promise<T | null> {
  try {
    const res = await request();
    return res.data;
  } catch (err: any) {
    if (err?.response?.status === status) return null;
    throw err;
  }
}

/**
 * One URL path segment for a rest-api call. Session ids reach this client from
 * the media plane's request bodies and route params, so a raw "/" or ".." would
 * otherwise change which rest-api route is called (with this node's API key).
 * Encodes the value and refuses the segments that encoding leaves meaningful.
 */
export function pathSegment(value: string): string {
  if (!value || value === "." || value === "..") {
    throw new Error("invalid rest-api path segment");
  }
  return encodeURIComponent(value);
}
