import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { normalizeReading, emptyReading, Telemetry } from "./telemetry.mjs";
import { createServer, isLocalRequest } from "./index.mjs";

const measuredAt = "2026-11-01T14:00:00.000Z";
const now = Date.parse(measuredAt);
const reading = {
  ...emptyReading("connected", null, measuredAt),
  interface: "en0",
  ssid: null,
  bssid: null,
  rssi: -72,
  noise: -91,
  snr: 100,
  txRate: 300,
  channel: 149,
  band: "5 GHz",
};

test("real RSSI remains available with redacted identity; SNR comes from the radio values", () => {
  const normalized = normalizeReading(reading, now);
  assert.equal(normalized.status, "connected");
  assert.equal(normalized.rssi, -72);
  assert.equal(normalized.ssid, null);
  assert.equal(normalized.snr, 19);
  assert.equal(normalized.timestamp, measuredAt);
});

test("zero, positive, non-numeric and missing RSSI cannot become successful measurements", () => {
  for (const rssi of [0, 1, -128, NaN, Infinity, "-45", null, undefined]) {
    const normalized = normalizeReading({ ...reading, rssi }, now);
    assert.equal(normalized.status, "error");
    assert.equal(normalized.rssi, null);
    assert.equal(normalized.txRate, null);
  }
});

test("invalid noise does not manufacture a signal-to-noise ratio", () => {
  for (const noise of [0, NaN, null]) {
    const normalized = normalizeReading({ ...reading, noise }, now);
    assert.equal(normalized.rssi, -72);
    assert.equal(normalized.noise, null);
    assert.equal(normalized.snr, null);
  }
});

test("disconnection and reader errors never retain cached signal or network metrics", () => {
  for (const status of ["disconnected", "wifi_off", "unavailable", "error"]) {
    const normalized = normalizeReading(
      { ...reading, status, ssid: "test-network" },
      now,
    );
    assert.equal(normalized.status, status);
    for (const key of [
      "rssi",
      "noise",
      "snr",
      "txRate",
      "channel",
      "ssid",
      "bssid",
      "band",
    ]) {
      assert.equal(normalized[key], null);
    }
  }
});

test("stale, future, malformed and wrong-source native frames are rejected", () => {
  assert.throws(() => normalizeReading(reading, now + 10_001), /stale/);
  assert.throws(() => normalizeReading(reading, now - 5_001), /timestamp/);
  assert.throws(() =>
    normalizeReading({ ...reading, timestamp: "not a date" }, now),
  );
  assert.throws(() => normalizeReading({ ...reading, source: "random" }, now));
  assert.throws(() => normalizeReading(null, now));
});

test("reader failure preserves measurement timestamp while clearing measurement data", () => {
  const telemetry = new Telemetry();
  telemetry.publish(reading);
  telemetry.fail("reader stopped");
  assert.equal(telemetry.current.timestamp, measuredAt);
  assert.equal(telemetry.current.rssi, null);
  assert.equal(telemetry.current.status, "error");
  telemetry.stop();
});

test("Host, Origin and browser fetch metadata block remote-page reads and DNS rebinding", () => {
  const allowed = { host: "127.0.0.1:4318", origin: "http://127.0.0.1:4318" };
  assert.equal(isLocalRequest({ headers: allowed }, 4318), true);
  assert.equal(
    isLocalRequest({ headers: { host: "localhost:4318" } }, 4318),
    true,
  );
  for (const headers of [
    { ...allowed, host: "evil.test:4318" },
    { ...allowed, origin: "https://evil.test" },
    { ...allowed, origin: "null" },
    { host: "127.0.0.1:4318", "sec-fetch-site": "cross-site" },
    { host: "127.0.0.1:9999" },
    {},
  ])
    assert.equal(isLocalRequest({ headers }, 4318), false);
});

test("HTTP API returns real frames, SSE updates, rejects writes and unknown API routes", async () => {
  const telemetry = new EventEmitter();
  telemetry.current = reading;
  telemetry.stop = () => {};
  const app = await createServer({ telemetry, port: 0 });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const controller = new AbortController();
  try {
    const response = await fetch(`${url}/api/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), reading);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.app, "fieldnote-wifi-mapper");
    assert.equal(health.source, "corewlan");
    assert.equal(
      (await fetch(`${url}/api/status`, { method: "POST" })).status,
      405,
    );
    assert.equal((await fetch(`${url}/api/not-real`)).status, 404);
    assert.equal(
      (
        await fetch(`${url}/api/status`, {
          headers: { Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    const stream = await fetch(`${url}/api/stream`, {
      signal: controller.signal,
    });
    assert.equal(
      stream.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    const reader = stream.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: reading/);
    assert.match(first, /"rssi":-72/);
    telemetry.emit("reading", { ...reading, rssi: -80 });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /"rssi":-80/);
    controller.abort();
  } finally {
    controller.abort();
    await app.close();
  }
});
