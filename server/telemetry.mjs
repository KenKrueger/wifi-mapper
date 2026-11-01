import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildNative } from "../scripts/build-native.mjs";

const statuses = new Set([
  "connected",
  "disconnected",
  "wifi_off",
  "unavailable",
  "error",
]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const dbm = (value) =>
  finite(value) && value >= -127 && value < 0 ? value : null;
const label = (value) =>
  typeof value === "string" && value.length <= 512 ? value : null;

export function emptyReading(
  status,
  message,
  timestamp = new Date().toISOString(),
) {
  return {
    timestamp,
    source: "corewlan",
    status,
    interface: null,
    ssid: null,
    bssid: null,
    rssi: null,
    noise: null,
    snr: null,
    txRate: null,
    channel: null,
    band: null,
    message,
  };
}

// Defensive boundary between native output and the browser. Zero is an OS error,
// never an exceptionally good reading. Non-connected states carry no old metrics.
export function normalizeReading(raw, now = Date.now()) {
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.source !== "corewlan" ||
    !statuses.has(raw.status)
  ) {
    throw new Error("Invalid native measurement.");
  }
  const measuredAt = Date.parse(raw.timestamp);
  if (
    !Number.isFinite(measuredAt) ||
    measuredAt > now + 5_000 ||
    now - measuredAt > 10_000
  ) {
    throw new Error("Native measurement timestamp is invalid or stale.");
  }
  const output = emptyReading(
    raw.status,
    label(raw.message),
    new Date(measuredAt).toISOString(),
  );
  output.interface = label(raw.interface);
  if (raw.status !== "connected") return output;
  output.rssi = dbm(raw.rssi);
  if (output.rssi === null) {
    output.status = "error";
    output.message = "macOS did not return a valid signal reading.";
    return output;
  }
  output.ssid = label(raw.ssid);
  output.bssid = label(raw.bssid);
  output.noise = dbm(raw.noise);
  output.snr = output.noise === null ? null : output.rssi - output.noise;
  output.txRate = finite(raw.txRate) && raw.txRate > 0 ? raw.txRate : null;
  output.channel =
    Number.isInteger(raw.channel) && raw.channel > 0 && raw.channel <= 233
      ? raw.channel
      : null;
  output.band = ["2.4 GHz", "5 GHz", "6 GHz"].includes(raw.band)
    ? raw.band
    : null;
  return output;
}

export class Telemetry extends EventEmitter {
  current = emptyReading("unavailable", "Starting the native Wi-Fi reader…");
  child = null;
  stopped = false;
  lastOutputAt = 0;
  retry = null;
  watchdog = null;
  binary = null;

  publish(reading) {
    this.current = reading;
    this.emit("reading", reading);
  }

  fail(message) {
    // Preserve the last timestamp so loss of telemetry cannot look like a new
    // successful hardware measurement, even to a client reconnecting later.
    this.publish(emptyReading("error", message, this.current.timestamp));
  }

  async start() {
    if (process.platform !== "darwin") {
      this.publish(
        emptyReading(
          "unavailable",
          "Real Wi-Fi measurements currently require a Mac. Run this app on your Mac laptop.",
        ),
      );
      return;
    }
    try {
      this.binary = await buildNative();
    } catch {
      this.fail(
        "The native reader could not be built. Install Apple Command Line Tools with xcode-select --install, then restart this app.",
      );
      return;
    }
    if (!this.stopped) this.launch();
  }

  launch() {
    if (this.stopped) return;
    const child = spawn(this.binary, [], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.child = child;
    this.lastOutputAt = Date.now();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.stopped || this.child !== child) return;
      try {
        if (line.length > 16_384)
          throw new Error("Native output exceeded its limit.");
        const reading = normalizeReading(JSON.parse(line));
        this.lastOutputAt = Date.now();
        this.publish(reading);
      } catch {
        this.fail(
          "The native reader returned an invalid measurement. Waiting for a fresh reading.",
        );
      }
    });
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastOutputAt > 6_000) {
        this.fail(
          "Wi-Fi measurements stopped updating. Restarting the native reader…",
        );
        child.kill("SIGKILL");
      }
    }, 1_000);
    this.watchdog.unref();
    const ended = () => {
      if (this.child !== child) return;
      clearInterval(this.watchdog);
      lines.close();
      this.child = null;
      if (!this.stopped) {
        this.fail("The native reader stopped. Reconnecting in a moment…");
        this.retry = setTimeout(() => this.launch(), 3_000);
        this.retry.unref();
      }
    };
    child.once("error", ended);
    child.once("exit", ended);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.watchdog);
    this.child?.kill();
    this.child = null;
  }
}
