"use client";

import { useEffect, useState } from "react";
import { useSensorHealthStore } from "@/stores/sensor-health-store";
import { useSensorHealthUpdates } from "@/hooks/useSensorHealthUpdates";
import type { SensorHealth } from "@vektor/shared";

// REQ-1.8's drop-rate alert threshold: "alert fires if any source drops
// > 1% of packets". This panel is the visual surface for that — it
// highlights the row rather than firing a separate alert, since alert-svc
// (Phase 5) owns actual alert dispatch.
const DROP_RATE_ALERT_THRESHOLD = 0.01;

const STATUS_COLORS: Record<SensorHealth["status"], string> = {
  ONLINE: "#22c55e",
  DEGRADED: "#eab308",
  OFFLINE: "#ef4444",
};

function formatRelativeTime(iso: string, now: number): string {
  const deltaSeconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.round(deltaSeconds / 60)}m ago`;
  return `${Math.round(deltaSeconds / 3600)}h ago`;
}

/** FE-003: the ingestion health dashboard (REQ-1.8) — per-source status, latency, drop rate. */
export function SensorHealthPanel() {
  useSensorHealthUpdates((event, error) => console.warn(`[SensorHealthPanel] invalid ${event} payload`, error));
  const sensors = useSensorHealthStore((s) => s.sensors);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const rows = Array.from(sensors.values()).sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));

  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        background: "var(--background)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
        minWidth: 260,
        maxHeight: 240,
        overflowY: "auto",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Sensor Health</div>
      {rows.length === 0 ? (
        <div style={{ opacity: 0.6 }}>No sensors reporting</div>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {rows.map((sensor) => {
              const dropRateAlert = sensor.drop_rate > DROP_RATE_ALERT_THRESHOLD;
              return (
                <tr key={sensor.sensor_id}>
                  <td style={{ padding: "2px 6px 2px 0" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: STATUS_COLORS[sensor.status],
                        marginRight: 6,
                      }}
                    />
                    {sensor.sensor_id}
                  </td>
                  <td style={{ padding: "2px 6px", textAlign: "right" }}>{sensor.latency_ms}ms</td>
                  <td
                    style={{
                      padding: "2px 6px",
                      textAlign: "right",
                      color: dropRateAlert ? STATUS_COLORS.OFFLINE : undefined,
                      fontWeight: dropRateAlert ? 600 : undefined,
                    }}
                  >
                    {(sensor.drop_rate * 100).toFixed(1)}%
                  </td>
                  <td style={{ padding: "2px 0 2px 6px", opacity: 0.6, textAlign: "right" }}>
                    {formatRelativeTime(sensor.last_heartbeat, now)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
