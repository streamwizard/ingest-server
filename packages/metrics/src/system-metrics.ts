import { Point } from "@influxdata/influxdb-client";
import { pushPoint } from "./influx-client";

// Host-level resource samples for an ingest node (CPU/RAM/bandwidth). One
// point per sample per node — tagged so dashboards can chart a single box's
// timeline or compare across the fleet.

export interface HostSystemSample {
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
  /** Root filesystem usage; omitted when the sampler couldn't stat it. */
  disk_used_pct?: number;
}

export function trackHostSystemSample(nodeId: string, sample: HostSystemSample): void {
  const point = new Point("host_system").tag("node_id", nodeId);

  for (const [key, value] of Object.entries(sample)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      point.floatField(key, value);
    }
  }

  pushPoint(point);
}
