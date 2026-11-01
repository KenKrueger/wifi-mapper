import test from "node:test";
import assert from "node:assert/strict";
import {
  canCombineReadings,
  createSurvey,
  exportCSV,
  interpolateAt,
  isFreshReading,
  quality,
  summarizeReadings,
  validateSurvey,
} from "../src/lib/survey.ts";
import type { Reading } from "../src/lib/survey.ts";

const now = Date.parse("2026-11-01T12:00:00Z");
const reading = (age = 0, overrides: Partial<Reading> = {}): Reading => ({
  timestamp: new Date(now - age).toISOString(),
  source: "corewlan",
  status: "connected",
  interface: "en0",
  ssid: "Home",
  bssid: "aa:bb:cc:dd:ee:ff",
  rssi: -65,
  noise: -95,
  snr: 30,
  txRate: 144,
  channel: 36,
  band: "5 GHz",
  message: null,
  ...overrides,
});

test("quality follows signal boundaries and never treats missing RSSI as measured", () => {
  assert.equal(quality(-55).label, "Excellent");
  assert.equal(quality(-67).label, "Good");
  assert.equal(quality(-70).label, "Fair");
  assert.equal(quality(-80).label, "Weak");
  assert.equal(quality(-81).label, "Dead spot");
  for (const rssi of [null, 0, NaN, Infinity])
    assert.equal(quality(rssi).label, "No signal");
});

test("stale, malformed, and implausibly future timestamps are not live", () => {
  assert.ok(isFreshReading(reading(5_000), now));
  assert.ok(!isFreshReading(reading(5_001), now));
  assert.ok(!isFreshReading(reading(-2_000), now));
  assert.ok(!isFreshReading(reading(0, { timestamp: "broken" }), now));
});

test("capture uses median, filters stale/invalid values, and deduplicates streamed snapshots", () => {
  const sample = reading(1_000, { rssi: -66 });
  const measurement = summarizeReadings(
    [
      reading(7_000, { rssi: -20 }),
      reading(3_000, { rssi: 0 }),
      sample,
      sample,
      reading(2_000, { rssi: -64 }),
      reading(0, { rssi: -99 }),
    ],
    { x: 0.3, y: 0.6 },
    "Office",
    now,
  );
  assert.equal(measurement.rssi, -66);
  assert.equal(measurement.count, 3);
  assert.equal(measurement.min, -99);
  assert.equal(measurement.max, -64);
  assert.equal(measurement.timestamp, reading().timestamp);
  assert.throws(
    () => summarizeReadings([reading(9_000)], { x: 0, y: 0 }, "", now),
    /No fresh/,
  );
});

test("capture retains known network identifiers when the first or last samples are redacted", () => {
  for (const knownAt of [0, 3]) {
    const samples = Array.from({ length: 4 }, (_, index) =>
      reading((3 - index) * 1_000, {
        ssid: index === knownAt ? "Home" : null,
        bssid: index === knownAt ? "aa:bb:cc:dd:ee:ff" : null,
      }),
    );
    const measurement = summarizeReadings(samples, { x: 0, y: 0 }, "", now);
    assert.equal(measurement.ssid, "Home");
    assert.equal(measurement.bssid, "aa:bb:cc:dd:ee:ff");
    assert.deepEqual(measurement.readings, samples);
    assert.equal(measurement.timestamp, reading().timestamp);
    const survey = { ...createSurvey(), measurements: [measurement] };
    assert.deepEqual(validateSurvey(JSON.parse(JSON.stringify(survey))), survey);
  }

  const fullyRedacted = summarizeReadings(
    [reading(0, { ssid: null, bssid: null })],
    { x: 0, y: 0 },
    "",
    now,
  );
  assert.equal(fullyRedacted.ssid, null);
  assert.equal(fullyRedacted.bssid, null);
});

test("network changes are rejected even through redacted readings", () => {
  const changed = reading(0, { bssid: "bb:bb:cc:dd:ee:ff" });
  assert.ok(!canCombineReadings(reading(), changed));
  assert.ok(
    canCombineReadings(reading(), reading(0, { ssid: null, bssid: null })),
  );
  for (const [key, value] of [
    ["interface", "en1"],
    ["ssid", "Hotspot"],
    ["bssid", "bb:bb:cc:dd:ee:ff"],
  ] as const) {
    assert.throws(
      () =>
        summarizeReadings(
          [
            reading(3_000),
            reading(2_000, { interface: null, ssid: null, bssid: null }),
            reading(1_000, { [key]: value }),
            reading(0, { interface: null, ssid: null, bssid: null }),
          ],
          { x: 0, y: 0 },
          "",
          now,
        ),
      /connection changed/,
    );
  }
});

test("disconnects remain null and service failures are not dead spots", () => {
  const disconnected = reading(0, {
    status: "disconnected",
    rssi: null,
    ssid: null,
    bssid: null,
  });
  const measurement = summarizeReadings(
    [disconnected],
    { x: 0, y: 0 },
    "",
    now,
  );
  assert.equal(measurement.status, "disconnected");
  assert.equal(measurement.rssi, null);
  assert.equal(measurement.min, null);
  assert.equal(measurement.noise, null);
  assert.throws(
    () =>
      summarizeReadings(
        [reading(1_000), disconnected],
        { x: 0, y: 0 },
        "",
        now,
      ),
    /disconnected during/,
  );
  assert.throws(
    () =>
      summarizeReadings(
        [reading(0, { status: "error", rssi: null })],
        { x: 0, y: 0 },
        "",
        now,
      ),
    /No fresh/,
  );
});

test("heat map interpolates locally in physical dimensions and leaves unsurveyed areas blank", () => {
  const left = summarizeReadings(
    [reading(0, { rssi: -50 })],
    { x: 0.1, y: 0.5 },
    "",
    now,
  );
  const right = summarizeReadings(
    [reading(0, { rssi: -80 })],
    { x: 0.5, y: 0.5 },
    "",
    now,
  );
  assert.equal(interpolateAt(0.1, 0.5, [left], 10, 10)?.rssi, -50);
  assert.equal(interpolateAt(0.3, 0.5, [left, right], 10, 10)?.rssi, -65);
  assert.equal(interpolateAt(1, 1, [left, right], 10, 10), null);
  assert.equal(interpolateAt(0.3, 0.5, [left], 100, 10), null);
  const lost = { ...right, status: "disconnected" as const, rssi: null };
  assert.equal(interpolateAt(0.5, 0.5, [left, lost], 10, 10), null);
});

test("survey import roundtrips real samples and rejects inconsistent or hostile input", () => {
  const survey = createSurvey();
  survey.measurements.push(
    summarizeReadings(
      [reading(0), reading(1_000)],
      { x: 0.5, y: 0.2 },
      "Hall",
      now,
    ),
  );
  survey.walls.push({ id: "wall-1", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
  assert.deepEqual(validateSurvey(JSON.parse(JSON.stringify(survey))), survey);
  assert.throws(() => validateSurvey({ ...survey, version: 2 }), /version/);
  assert.throws(() => validateSurvey({ ...survey, width: NaN }), /number/);
  assert.throws(
    () =>
      validateSurvey({
        ...survey,
        floorplan: "data:image/svg+xml;base64,AAAA",
      }),
    /Floor plan/,
  );
  assert.throws(
    () =>
      validateSurvey({
        ...survey,
        measurements: [{ ...survey.measurements[0], rssi: -20 }],
      }),
    /summary/,
  );
  assert.throws(
    () =>
      validateSurvey({
        ...survey,
        measurements: [survey.measurements[0], survey.measurements[0]],
      }),
    /duplicate/,
  );
  assert.throws(
    () => validateSurvey({ ...survey, router: { x: -0.1, y: 0 } }),
    /number/,
  );
  assert.throws(
    () =>
      validateSurvey({ ...survey, walls: Array(501).fill(survey.walls[0]) }),
    /large/,
  );
});

test("CSV preserves numeric dBm and neutralizes spreadsheet formulas in labels and networks", () => {
  const survey = createSurvey();
  survey.measurements.push(
    summarizeReadings(
      [reading(0, { ssid: '=HYPERLINK("bad")' })],
      { x: 0.5, y: 0.2 },
      "\t+cmd",
      now,
    ),
  );
  const csv = exportCSV(survey);
  assert.ok(csv.includes('"\'\t+cmd"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"-65"'));
  assert.ok(!csv.includes('"\'-65"'));
});
