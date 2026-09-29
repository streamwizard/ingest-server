import { InfluxDB, Point, WriteApi } from "@influxdata/influxdb-client";

// Every ingest node writes into the "ingest-nodes" bucket; the environment is
// picked by INFLUXDB_ORG (streamwizard-dev / -staging / -prod).
const BUCKET = "ingest-nodes";

let writeApi: WriteApi | null = null;
let isConfigured = false;

function init(): void {
  if (isConfigured) return;
  isConfigured = true;

  const { INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG } = process.env;
  if (!INFLUXDB_URL || !INFLUXDB_TOKEN || !INFLUXDB_ORG) return;

  try {
    const client = new InfluxDB({ url: INFLUXDB_URL, token: INFLUXDB_TOKEN });
    writeApi = client.getWriteApi(INFLUXDB_ORG, BUCKET, "ms", {
      batchSize: 50,
      flushInterval: 2000,
      maxRetries: 3,
      retryJitter: 200,
    });
  } catch {
    writeApi = null;
  }
}

export function pushPoint(point: Point): void {
  try {
    init();
    if (!writeApi) return;
    writeApi.writePoint(point);
  } catch {
    // never throw from metrics code
  }
}

export function isMetricsEnabled(): boolean {
  const { INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG } = process.env;
  return !!(INFLUXDB_URL && INFLUXDB_TOKEN && INFLUXDB_ORG);
}

export async function closeInflux(): Promise<void> {
  if (writeApi) {
    try {
      await writeApi.close();
    } catch {
      // ignore close errors
    }
    writeApi = null;
  }
}
