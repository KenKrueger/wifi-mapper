import assert from "node:assert/strict";
import test from "node:test";
import { createHeatmapSampler, heatmapKey } from "../src/lib/heatmap.ts";
import {
  createSurvey,
  interpolateAt,
  type Measurement,
} from "../src/lib/survey.ts";

function point(x: number, y: number, rssi: number | null): Measurement {
  return {
    x,
    y,
    rssi,
    status: rssi === null ? "disconnected" : "measured",
  } as Measurement;
}

function sameEstimate(
  actual: ReturnType<ReturnType<typeof createHeatmapSampler>>,
  expected: ReturnType<typeof interpolateAt>,
) {
  if (expected === null) assert.equal(actual, null);
  else {
    assert.notEqual(actual, null);
    assert.ok(Math.abs(actual!.rssi - expected.rssi) < 1e-10);
    assert.ok(Math.abs(actual!.confidence - expected.confidence) < 1e-10);
  }
}

test("prepared heatmap matches the reference across unequal dimensions and radii", () => {
  let seed = 23;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const points = Array.from({ length: 180 }, (_, i) =>
    point(random(), random(), i % 13 === 0 ? null : -30 - random() * 90),
  );
  for (const [width, height, radius] of [
    [14, 10, 4],
    [3, 70, 1],
    [90, 4, 8],
  ]) {
    const sample = createHeatmapSampler(points, width, height, radius);
    for (let i = 0; i < 1200; i++) {
      const x = random() * 1.2 - 0.1;
      const y = random() * 1.2 - 0.1;
      sameEstimate(
        sample(x, y),
        interpolateAt(x, y, points, width, height, radius),
      );
    }
  }
});

test("prepared heatmap keeps radius boundaries and disconnected masking", () => {
  const points = [point(0.2, 0.5, -50), point(0.6, 0.5, null)];
  const sample = createHeatmapSampler(points, 10, 10, 2);
  for (const x of [0, 0.2, 0.3, 0.4, 0.400001, 0.6, 1]) {
    sameEstimate(sample(x, 0.5), interpolateAt(x, 0.5, points, 10, 10, 2));
  }
  const coincident = [point(0.5, 0.5, -60), point(0.5, 0.5, null)];
  sameEstimate(
    createHeatmapSampler(coincident, 10, 10)(0.5, 0.5),
    interpolateAt(0.5, 0.5, coincident, 10, 10),
  );
});

test("empty, disconnected-only, invalid signal and invalid geometry stay blank", () => {
  for (const points of [
    [],
    [point(0.5, 0.5, null)],
    [point(0.5, 0.5, 0)],
    [point(0.5, 0.5, NaN)],
  ]) {
    assert.equal(createHeatmapSampler(points, 10, 10)(0.5, 0.5), null);
  }
  const points = [point(0.5, 0.5, -60)];
  for (const [width, height, radius] of [
    [0, 10, 4],
    [10, -1, 4],
    [10, 10, 0],
    [Infinity, 10, 4],
  ]) {
    assert.equal(
      createHeatmapSampler(points, width, height, radius)(0.5, 0.5),
      null,
    );
  }
  const sample = createHeatmapSampler(points, 10, 10);
  assert.equal(sample(NaN, 0.5), null);
  assert.equal(sample(0.5, Infinity), null);
  assert.equal(sample(Number.MAX_VALUE, 0.5), null);
});

test("rendering key ignores annotations and detects every heatmap input", () => {
  const survey = {
    ...createSurvey(),
    measurements: [point(0.5, 0.5, -60)],
  };
  const key = heatmapKey(survey, 4);
  assert.equal(key, heatmapKey({
    ...survey,
    name: "Renamed",
    measurements: survey.measurements.map((m) => ({
      ...m,
      label: "Renamed point",
    })),
    walls: [{ id: "wall", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }],
    router: { x: 0.3, y: 0.3 },
    floorplan: "data:image/png;base64,QUJDRA==",
  }, 4));
  assert.notEqual(key, heatmapKey(survey, 5));
  for (const change of [
    { width: 20 },
    { height: 20 },
    { floorplanView: {
      x: 0, y: 0, width: 100, height: 20, sourceWidth: 100, sourceHeight: 100,
    } },
  ]) {
    assert.notEqual(key, heatmapKey({ ...survey, ...change }, 4));
  }
  for (const change of [
    { x: 0.4 }, { y: 0.4 }, { rssi: -70 }, { status: "disconnected" as const },
  ]) {
    assert.notEqual(key, heatmapKey({
      ...survey,
      measurements: survey.measurements.map((m) => ({ ...m, ...change })),
    }, 4));
  }
});
