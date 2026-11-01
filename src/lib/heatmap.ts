import type { Measurement, Survey } from "./survey.ts";

type HeatmapPoint = Pick<Measurement, "x" | "y" | "rssi" | "status">;
type Estimate = { rssi: number; confidence: number } | null;

/** Reuse a canvas when only labels, walls, the router, or image pixels change. */
export function heatmapKey(survey: Survey, radius: number): string {
  const aspect = survey.floorplanView
    ? survey.floorplanView.height / survey.floorplanView.width
    : survey.height / survey.width;
  return JSON.stringify([
    survey.width,
    survey.height,
    aspect,
    radius,
    survey.measurements.map(({ x, y, rssi, status }) => [x, y, rssi, status]),
  ]);
}

/** Prepare local spatial buckets once per paint, then query only nearby points. */
export function createHeatmapSampler(
  measurements: readonly HeatmapPoint[],
  width: number,
  height: number,
  radiusMeters = 4,
): (x: number, y: number) => Estimate {
  if (
    ![width, height, radiusMeters].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    radiusMeters <= 0
  )
    return () => null;

  const buckets = new Map<string, HeatmapPoint[]>();
  for (const point of measurements) {
    if (
      point.status !== "disconnected" &&
      (typeof point.rssi !== "number" ||
        !Number.isFinite(point.rssi) ||
        point.rssi < -127 ||
        point.rssi >= 0)
    )
      continue;
    const key = `${Math.floor((point.x * width) / radiusMeters)},${Math.floor((point.y * height) / radiusMeters)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }
  if (!buckets.size) return () => null;

  const radiusSquared = radiusMeters * radiusMeters;
  return (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const cellX = Math.floor((x * width) / radiusMeters);
    const cellY = Math.floor((y * height) / radiusMeters);
    let weighted = 0,
      weights = 0,
      nearest = Infinity,
      nearestDisconnected = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const bucket = buckets.get(`${cellX + ox},${cellY + oy}`);
        if (!bucket) continue;
        for (const point of bucket) {
          const dx = (x - point.x) * width;
          const dy = (y - point.y) * height;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared > radiusSquared) continue;
          if (point.status === "disconnected") {
            nearestDisconnected = Math.min(nearestDisconnected, distanceSquared);
            continue;
          }
          nearest = Math.min(nearest, distanceSquared);
          const weight = 1 / Math.max(distanceSquared, 0.000001);
          weighted += point.rssi! * weight;
          weights += weight;
        }
      }
    }
    if (!weights || nearestDisconnected < nearest) return null;
    return {
      rssi: weighted / weights,
      confidence: Math.max(0, 1 - Math.sqrt(nearest) / radiusMeters),
    };
  };
}
