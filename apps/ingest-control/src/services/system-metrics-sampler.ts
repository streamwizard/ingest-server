import { trackHostSystemSample } from "@repo/metrics";
import { wsBroadcastClient } from "../lib/ws-broadcast";

// Periodic host CPU/RAM/bandwidth sampler for this ingest node, mirroring the
// /proc-based technique obs-instance-manager uses for its own host metrics
// (see obs-instance-manager/src/services/metrics.ts) — reimplemented locally
// since these are separate repos with no shared package between them.

async function readProcStatCpuLine(): Promise<{ idle: number; total: number; steal: number }> {
  const text = await Bun.file("/proc/stat").text();
  const cpuLine = text.split("\n").find((line) => line.startsWith("cpu "));
  if (!cpuLine) throw new Error("Could not read cpu line from /proc/stat");

  const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { idle: idle + iowait, total, steal };
}

// Busy % and steal % over the same 100ms sample. Steal is CPU time the
// hypervisor gave to other VMs while ours wanted to run — sustained non-zero
// steal means the box is being throttled by a noisy neighbour, which CPU%
// alone can't reveal.
async function getCpuStats(): Promise<{ cpuPct: number; stealPct: number }> {
  const first = await readProcStatCpuLine();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await readProcStatCpuLine();

  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  const stealDelta = second.steal - first.steal;
  if (totalDelta <= 0) return { cpuPct: 0, stealPct: 0 };
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return {
    cpuPct: clamp((1 - idleDelta / totalDelta) * 100),
    stealPct: clamp((stealDelta / totalDelta) * 100),
  };
}

// 1-minute load average. System-wide (not namespaced), so this is the host's
// figure whether we read our own /proc or the host netns under pid:host.
async function getLoadAvg1(): Promise<number> {
  const text = await Bun.file("/proc/loadavg").text();
  return Number(text.trim().split(/\s+/)[0]) || 0;
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

// Where to read interface byte counters from. Defaults to this process's own
// /proc/net/dev — correct on bare metal / host networking. In the split-
// container deploy the SRT ingest lands in ingest-media's network namespace,
// invisible here, so docker-compose sets HOST_NET_DEV=/proc/1/net/dev (with
// pid:host) to read the host root netns and see the real NIC counters.
const NET_DEV_PATH = process.env.HOST_NET_DEV || "/proc/net/dev";

// Physical-NIC only. Loopback and Docker plumbing (docker0, bridges, veth
// pairs) are skipped; overlay/tunnel devices (tailscale, WireGuard, tun/tap)
// are skipped too so their traffic isn't double-counted against the encrypted
// bytes already flowing over the physical interface. Matters most when reading
// the host netns, where all of these are present.
const IGNORED_INTERFACE_PREFIXES = ["lo", "docker", "veth", "br-", "tailscale", "wg", "tun", "tap"];

async function readNetDevTotals(): Promise<{
  rxBytes: number;
  txBytes: number;
  tsRxBytes: number;
  tsTxBytes: number;
}> {
  const text = await Bun.file(NET_DEV_PATH).text();
  let rxBytes = 0;
  let txBytes = 0;
  let tsRxBytes = 0;
  let tsTxBytes = 0;

  for (const line of text.split("\n").slice(2)) {
    const [ifaceRaw, statsRaw] = line.split(":");
    if (!ifaceRaw || !statsRaw) continue;
    const iface = ifaceRaw.trim();

    const fields = statsRaw.trim().split(/\s+/).map(Number);
    const [rx = 0, , , , , , , , tx = 0] = fields;

    // Tailscale gets its own counters (the OBS output pull rides it) but stays
    // out of the physical totals — its bytes already appear on the NIC as
    // encrypted WireGuard traffic, so counting it here too would double it.
    if (iface.startsWith("tailscale")) {
      tsRxBytes += rx;
      tsTxBytes += tx;
      continue;
    }
    if (IGNORED_INTERFACE_PREFIXES.some((prefix) => iface.startsWith(prefix))) continue;

    rxBytes += rx;
    txBytes += tx;
  }

  return { rxBytes, txBytes, tsRxBytes, tsTxBytes };
}

let lastNet: { rxBytes: number; txBytes: number; tsRxBytes: number; tsTxBytes: number; at: number } | null = null;

// Root filesystem usage the way df computes it: used / (used + available),
// with "available" being the non-root-reserved blocks. Inside the container
// this stats the overlay mount, which reports the backing host disk.
async function getDiskUsedPct(): Promise<number | undefined> {
  try {
    const { statfs } = await import("node:fs/promises");
    const stats = await statfs("/");
    const used = stats.blocks - stats.bfree;
    const denominator = used + stats.bavail;
    if (denominator <= 0) return undefined;
    return (used / denominator) * 100;
  } catch {
    return undefined;
  }
}

async function sampleHostSystem(): Promise<{
  cpuPct: number;
  stealPct: number;
  loadAvg1: number;
  mem: { usedMb: number; totalMb: number };
  rxBytesPerSec: number;
  txBytesPerSec: number;
  tsRxBytesPerSec: number;
  tsTxBytesPerSec: number;
  diskUsedPct: number | undefined;
}> {
  const [{ cpuPct, stealPct }, loadAvg1, mem, net, diskUsedPct] = await Promise.all([
    getCpuStats(),
    getLoadAvg1(),
    getMemMb(),
    readNetDevTotals(),
    getDiskUsedPct(),
  ]);

  const now = Date.now();
  let rxBytesPerSec = 0;
  let txBytesPerSec = 0;
  let tsRxBytesPerSec = 0;
  let tsTxBytesPerSec = 0;
  if (lastNet) {
    const dtSec = (now - lastNet.at) / 1000;
    if (dtSec > 0) {
      rxBytesPerSec = Math.max(0, (net.rxBytes - lastNet.rxBytes) / dtSec);
      txBytesPerSec = Math.max(0, (net.txBytes - lastNet.txBytes) / dtSec);
      tsRxBytesPerSec = Math.max(0, (net.tsRxBytes - lastNet.tsRxBytes) / dtSec);
      tsTxBytesPerSec = Math.max(0, (net.tsTxBytes - lastNet.tsTxBytes) / dtSec);
    }
  }
  lastNet = { rxBytes: net.rxBytes, txBytes: net.txBytes, tsRxBytes: net.tsRxBytes, tsTxBytes: net.tsTxBytes, at: now };

  return { cpuPct, stealPct, loadAvg1, mem, rxBytesPerSec, txBytesPerSec, tsRxBytesPerSec, tsTxBytesPerSec, diskUsedPct };
}

export function startSystemMetricsSampler(nodeId: string, intervalMs = 10_000): void {
  setInterval(() => {
    sampleHostSystem()
      .then((s) => {
        trackHostSystemSample(nodeId, {
          cpu_pct: s.cpuPct,
          cpu_steal_pct: s.stealPct,
          load_avg_1: s.loadAvg1,
          mem_used_mb: s.mem.usedMb,
          mem_total_mb: s.mem.totalMb,
          rx_bytes_per_sec: s.rxBytesPerSec,
          tx_bytes_per_sec: s.txBytesPerSec,
          tailscale_rx_bytes_per_sec: s.tsRxBytesPerSec,
          tailscale_tx_bytes_per_sec: s.tsTxBytesPerSec,
          ...(s.diskUsedPct !== undefined ? { disk_used_pct: s.diskUsedPct } : {}),
        });

        // Realtime path: network fields only — cpu/mem/disk deliberately stay
        // InfluxDB-only. Fire-and-forget like every other broadcast; a closed
        // socket just means this 10s sample is skipped.
        wsBroadcastClient.send({
          kind: "node_metrics",
          payload: {
            node_id: nodeId,
            ts: Date.now(),
            rx_bytes_per_sec: s.rxBytesPerSec,
            tx_bytes_per_sec: s.txBytesPerSec,
            tailscale_rx_bytes_per_sec: s.tsRxBytesPerSec,
            tailscale_tx_bytes_per_sec: s.tsTxBytesPerSec,
          },
        });
      })
      .catch(() => {
        // never let metrics collection crash the process
      });
  }, intervalMs);
}
