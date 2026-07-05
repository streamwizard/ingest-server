import { trackHostSystemSample } from "@repo/metrics";

// Periodic host CPU/RAM/bandwidth sampler for this ingest node, mirroring the
// /proc-based technique obs-instance-manager uses for its own host metrics
// (see obs-instance-manager/src/services/metrics.ts) — reimplemented locally
// since these are separate repos with no shared package between them.

async function readProcStatCpuLine(): Promise<{ idle: number; total: number }> {
  const text = await Bun.file("/proc/stat").text();
  const cpuLine = text.split("\n").find((line) => line.startsWith("cpu "));
  if (!cpuLine) throw new Error("Could not read cpu line from /proc/stat");

  const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { idle: idle + iowait, total };
}

async function getCpuPercent(): Promise<number> {
  const first = await readProcStatCpuLine();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await readProcStatCpuLine();

  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

async function getMemMb(): Promise<{ usedMb: number; totalMb: number }> {
  const text = await Bun.file("/proc/meminfo").text();
  const lines = Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split(":") as [string, string];
        return [key.trim(), parseInt(value.trim(), 10)];
      }),
  );

  const totalKb = lines["MemTotal"] ?? 0;
  const availableKb = lines["MemAvailable"] ?? 0;
  return {
    usedMb: Math.round((totalKb - availableKb) / 1024),
    totalMb: Math.round(totalKb / 1024),
  };
}

const IGNORED_INTERFACE_PREFIXES = ["lo", "docker", "veth", "br-"];

async function readNetDevTotals(): Promise<{ rxBytes: number; txBytes: number }> {
  const text = await Bun.file("/proc/net/dev").text();
  let rxBytes = 0;
  let txBytes = 0;

  for (const line of text.split("\n").slice(2)) {
    const [ifaceRaw, statsRaw] = line.split(":");
    if (!ifaceRaw || !statsRaw) continue;
    const iface = ifaceRaw.trim();
    if (IGNORED_INTERFACE_PREFIXES.some((prefix) => iface.startsWith(prefix))) continue;

    const fields = statsRaw.trim().split(/\s+/).map(Number);
    const [rx = 0, , , , , , , , tx = 0] = fields;
    rxBytes += rx;
    txBytes += tx;
  }

  return { rxBytes, txBytes };
}

let lastNet: { rxBytes: number; txBytes: number; at: number } | null = null;

async function sampleHostSystem(): Promise<{
  cpuPct: number;
  mem: { usedMb: number; totalMb: number };
  rxBytesPerSec: number;
  txBytesPerSec: number;
}> {
  const [cpuPct, mem, net] = await Promise.all([getCpuPercent(), getMemMb(), readNetDevTotals()]);

  const now = Date.now();
  let rxBytesPerSec = 0;
  let txBytesPerSec = 0;
  if (lastNet) {
    const dtSec = (now - lastNet.at) / 1000;
    if (dtSec > 0) {
      rxBytesPerSec = Math.max(0, (net.rxBytes - lastNet.rxBytes) / dtSec);
      txBytesPerSec = Math.max(0, (net.txBytes - lastNet.txBytes) / dtSec);
    }
  }
  lastNet = { rxBytes: net.rxBytes, txBytes: net.txBytes, at: now };

  return { cpuPct, mem, rxBytesPerSec, txBytesPerSec };
}

export function startSystemMetricsSampler(nodeId: string, intervalMs = 10_000): void {
  setInterval(() => {
    sampleHostSystem()
      .then(({ cpuPct, mem, rxBytesPerSec, txBytesPerSec }) => {
        trackHostSystemSample(nodeId, {
          cpu_pct: cpuPct,
          mem_used_mb: mem.usedMb,
          mem_total_mb: mem.totalMb,
          rx_bytes_per_sec: rxBytesPerSec,
          tx_bytes_per_sec: txBytesPerSec,
        });
      })
      .catch(() => {
        // never let metrics collection crash the process
      });
  }, intervalMs);
}
