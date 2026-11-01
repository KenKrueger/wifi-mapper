export interface Reading {
  timestamp: string;
  source: "corewlan";
  status: "connected" | "disconnected" | "wifi_off" | "unavailable" | "error";
  interface: string | null;
  ssid: string | null;
  bssid: string | null;
  rssi: number | null;
  noise: number | null;
  snr: number | null;
  txRate: number | null;
  channel: number | null;
  band: string | null;
  message: string | null;
}
export interface Point {
  x: number;
  y: number;
}
export interface Measurement extends Point {
  id: string;
  label: string;
  timestamp: string;
  rssi: number | null;
  noise: number | null;
  snr: number | null;
  txRate: number | null;
  channel: number | null;
  band: string | null;
  ssid: string | null;
  bssid: string | null;
  count: number;
  min: number | null;
  max: number | null;
  status: "measured" | "disconnected";
  readings: Reading[];
}
export interface Wall {
  id: string;
  a: Point;
  b: Point;
}
export interface FloorplanView {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}
export interface Survey {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
  measurements: Measurement[];
  walls: Wall[];
  floorplan: string | null;
  router: Point | null;
  floorplanView?: FloorplanView;
  scaleConfirmed?: boolean;
  planNote?: string;
  templateId?: string;
}

const validRssi = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= -127 && v < 0;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function quality(rssi: number | null): {
  label: string;
  color: string;
  description: string;
} {
  if (rssi === null || !validRssi(rssi))
    return {
      label: "No signal",
      color: "#a8a29e",
      description: "No usable signal measurement.",
    };
  if (rssi >= -55)
    return {
      label: "Excellent",
      color: "#35b995",
      description: "Strong signal with plenty of headroom.",
    };
  if (rssi >= -67)
    return {
      label: "Good",
      color: "#82b957",
      description: "A useful signal target for calls and everyday use.",
    };
  if (rssi >= -70)
    return {
      label: "Fair",
      color: "#e4bd55",
      description: "Less headroom; performance may vary.",
    };
  if (rssi >= -80)
    return {
      label: "Weak",
      color: "#e58b55",
      description: "Weak coverage; interruptions are more likely.",
    };
  return {
    label: "Dead spot",
    color: "#d86465",
    description: "Very weak coverage; connection may be unreliable.",
  };
}

export function isFreshReading(reading: Reading, now = Date.now()): boolean {
  const age = now - Date.parse(reading.timestamp);
  return Number.isFinite(age) && age >= -1_000 && age <= 5_000;
}

export function canCombineReadings(first: Reading, next: Reading): boolean {
  return (["interface", "ssid", "bssid"] as const).every(
    (key) =>
      first[key] === null || next[key] === null || first[key] === next[key],
  );
}

export function summarizeReadings(
  readings: Reading[],
  position: Point,
  label = "",
  now = Date.now(),
): Measurement {
  point(position);
  const unique = [
    ...new Map(
      readings
        .filter((r) => r.source === "corewlan" && isFreshReading(r, now))
        .filter((r) =>
          r.status === "connected"
            ? validRssi(r.rssi)
            : r.status === "disconnected" || r.status === "wifi_off",
        )
        .map((r) => [r.timestamp, r]),
    ).values(),
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (!unique.length)
    throw new Error(
      "No fresh Wi-Fi measurements. Wait for the native sensor to reconnect.",
    );
  // Compare every known identity, including changes hidden by an intermediate redacted reading.
  for (const key of ["interface", "ssid", "bssid"] as const) {
    if (new Set(unique.map((r) => r[key]).filter((v) => v !== null)).size > 1) {
      throw new Error(
        "The Wi-Fi connection changed during this capture. Stay still and try again.",
      );
    }
  }
  const connected = unique.filter((r) => r.status === "connected");
  if (connected.length && connected.length !== unique.length)
    throw new Error(
      "Wi-Fi disconnected during this capture. Try again once the signal settles.",
    );
  const last = unique[unique.length - 1]!;
  const signals = connected.map((r) => r.rssi!);
  const values = (key: "noise" | "snr" | "txRate") =>
    connected
      .map((r) => r[key])
      .filter((v): v is number => v !== null && Number.isFinite(v));
  return {
    id: crypto.randomUUID(),
    ...position,
    label: label.slice(0, 120),
    timestamp: last.timestamp,
    rssi: median(signals),
    noise: median(values("noise")),
    snr: median(values("snr")),
    txRate: median(values("txRate")),
    channel: connected.length ? last.channel : null,
    band: connected.length ? last.band : null,
    ssid: last.ssid,
    bssid: last.bssid,
    count: unique.length,
    min: signals.length ? Math.min(...signals) : null,
    max: signals.length ? Math.max(...signals) : null,
    status: connected.length ? "measured" : "disconnected",
    readings: unique,
  };
}

/** Local IDW estimate. Confidence expresses spatial support, not statistical accuracy. */
export function interpolateAt(
  x: number,
  y: number,
  measurements: Measurement[],
  width: number,
  height: number,
  radiusMeters = 4,
): { rssi: number; confidence: number } | null {
  if (
    ![x, y, width, height, radiusMeters].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    radiusMeters <= 0
  )
    return null;
  let weighted = 0,
    weights = 0,
    nearest = Infinity,
    nearestDisconnected = Infinity;
  for (const m of measurements) {
    const distance = Math.hypot((x - m.x) * width, (y - m.y) * height);
    if (m.status === "disconnected") {
      nearestDisconnected = Math.min(nearestDisconnected, distance);
      continue;
    }
    if (!validRssi(m.rssi) || distance > radiusMeters) continue;
    nearest = Math.min(nearest, distance);
    const weight = 1 / Math.max(distance * distance, 0.000001);
    weighted += m.rssi * weight;
    weights += weight;
  }
  if (!weights || nearestDisconnected < nearest) return null;
  return {
    rssi: weighted / weights,
    confidence: Math.max(0, 1 - nearest / radiusMeters),
  };
}

export function createSurvey(): Survey {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: "My home",
    width: 14,
    height: 10,
    createdAt: now,
    updatedAt: now,
    measurements: [],
    walls: [],
    floorplan: null,
    router: null,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a survey object.");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 120): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid or overly long survey text.");
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Invalid survey number.");
  return value;
}
function nullableNumber(value: unknown, min: number, max: number) {
  return value === null ? null : number(value, min, max);
}
function nullableString(value: unknown, max = 120) {
  return value === null ? null : string(value, max);
}
function date(value: unknown) {
  const text = string(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text)))
    throw new Error("Invalid survey timestamp.");
  return text;
}
function point(value: unknown): Point {
  const p = object(value);
  return { x: number(p.x, 0, 1), y: number(p.y, 0, 1) };
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("Invalid or overly large survey collection.");
  return value;
}
function reading(value: unknown): Reading {
  const r = object(value);
  if (
    r.source !== "corewlan" ||
    !["connected", "disconnected", "wifi_off", "unavailable", "error"].includes(
      r.status as string,
    )
  )
    throw new Error("Invalid reading source or status.");
  const result: Reading = {
    timestamp: date(r.timestamp),
    source: "corewlan",
    status: r.status as Reading["status"],
    interface: nullableString(r.interface),
    ssid: nullableString(r.ssid, 256),
    bssid: nullableString(r.bssid),
    rssi: nullableNumber(r.rssi, -127, -0.01),
    noise: nullableNumber(r.noise, -150, -0.01),
    snr: nullableNumber(r.snr, -150, 150),
    txRate: nullableNumber(r.txRate, 0, 100_000),
    channel: nullableNumber(r.channel, 1, 233),
    band: nullableString(r.band),
    message: nullableString(r.message, 2_000),
  };
  if (
    result.status === "connected" ? result.rssi === null : result.rssi !== null
  )
    throw new Error("Reading status does not match its signal.");
  return result;
}

/** Reconstruct whitelisted fields; importing a file never executes or trusts its content. */
export function validateSurvey(value: unknown): Survey {
  const s = object(value);
  if (s.version !== 1) throw new Error("Unsupported survey version.");
  const measurements = array(s.measurements, 3_000).map((value) => {
    const m = object(value);
    if (m.status !== "measured" && m.status !== "disconnected")
      throw new Error("Invalid measurement status.");
    const result: Measurement = {
      id: string(m.id),
      label: string(m.label),
      ...point(m),
      timestamp: date(m.timestamp),
      rssi: nullableNumber(m.rssi, -127, -0.01),
      noise: nullableNumber(m.noise, -150, -0.01),
      snr: nullableNumber(m.snr, -150, 150),
      txRate: nullableNumber(m.txRate, 0, 100_000),
      channel: nullableNumber(m.channel, 1, 233),
      band: nullableString(m.band),
      ssid: nullableString(m.ssid, 256),
      bssid: nullableString(m.bssid),
      count: number(m.count, 1, 120),
      min: nullableNumber(m.min, -127, -0.01),
      max: nullableNumber(m.max, -127, -0.01),
      status: m.status,
      readings: array(m.readings, 120).map(reading),
    };
    if (
      !Number.isInteger(result.count) ||
      result.count !== result.readings.length ||
      new Set(result.readings.map((r) => r.timestamp)).size !== result.count
    )
      throw new Error("Measurement sample count is inconsistent.");
    const signals = result.readings
      .filter((r) => r.status === "connected")
      .map((r) => r.rssi!);
    if (result.status === "measured") {
      if (
        signals.length !== result.count ||
        result.rssi !== median(signals) ||
        result.min !== Math.min(...signals) ||
        result.max !== Math.max(...signals)
      )
        throw new Error("Measurement summary does not match its readings.");
    } else if (
      result.rssi !== null ||
      result.min !== null ||
      result.max !== null ||
      result.readings.some(
        (r) => r.status !== "disconnected" && r.status !== "wifi_off",
      )
    ) {
      throw new Error("Disconnected measurements cannot contain a signal.");
    }
    for (const key of ["interface", "ssid", "bssid"] as const) {
      if (
        new Set(result.readings.map((r) => r[key]).filter((v) => v !== null))
          .size > 1
      )
        throw new Error("Measurement mixes different Wi-Fi connections.");
    }
    return result;
  });
  const walls = array(s.walls, 500).map((value) => {
    const w = object(value);
    return { id: string(w.id), a: point(w.a), b: point(w.b) };
  });
  if (
    new Set(measurements.map((m) => m.id)).size !== measurements.length ||
    new Set(walls.map((w) => w.id)).size !== walls.length
  )
    throw new Error("Survey contains duplicate identifiers.");
  const floorplan = nullableString(s.floorplan, 3_000_000);
  if (
    floorplan !== null &&
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(floorplan)
  )
    throw new Error("Floor plan must be a PNG, JPEG, or WebP image.");
  const optional: Pick<
    Survey,
    "floorplanView" | "scaleConfirmed" | "planNote" | "templateId"
  > = {};
  if (s.floorplanView !== undefined) {
    if (floorplan === null)
      throw new Error("A floor plan view requires an image.");
    const view = object(s.floorplanView);
    const sourceWidth = number(view.sourceWidth, 1, 16_384);
    const sourceHeight = number(view.sourceHeight, 1, 16_384);
    if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight))
      throw new Error("Invalid floor plan image dimensions.");
    const x = number(view.x, 0, sourceWidth - 1);
    const y = number(view.y, 0, sourceHeight - 1);
    optional.floorplanView = {
      x,
      y,
      width: number(view.width, 1, sourceWidth - x),
      height: number(view.height, 1, sourceHeight - y),
      sourceWidth,
      sourceHeight,
    };
  }
  if (s.scaleConfirmed !== undefined) {
    if (typeof s.scaleConfirmed !== "boolean")
      throw new Error("Invalid survey scale confirmation.");
    optional.scaleConfirmed = s.scaleConfirmed;
  }
  if (s.planNote !== undefined) optional.planNote = string(s.planNote, 2_000);
  if (s.templateId !== undefined) optional.templateId = string(s.templateId);
  return {
    version: 1,
    id: string(s.id),
    name: string(s.name),
    width: number(s.width, 1, 200),
    height: number(s.height, 1, 200),
    createdAt: date(s.createdAt),
    updatedAt: date(s.updatedAt),
    measurements,
    walls,
    floorplan,
    router: s.router === null ? null : point(s.router),
    ...optional,
  };
}

export function exportCSV(survey: Survey): string {
  const unscaled = survey.scaleConfirmed === false;
  const headers = [
    "Point",
    unscaled ? "X (plan %)" : "X (m)",
    unscaled ? "Y (plan %)" : "Y (m)",
    "Status",
    "RSSI (dBm)",
    "Noise (dBm)",
    "SNR (dB)",
    "Link rate (Mbps)",
    "Channel",
    "Band",
    "SSID",
    "BSSID",
    "Samples",
    "Minimum (dBm)",
    "Maximum (dBm)",
    "Timestamp",
  ];
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    // Only text is escaped: negative numeric RSSI values stay usable as numbers.
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text))
      text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows = survey.measurements.map((m) => [
    m.label,
    +(m.x * (unscaled ? 100 : survey.width)).toFixed(2),
    +(m.y * (unscaled ? 100 : survey.height)).toFixed(2),
    m.status,
    m.rssi,
    m.noise,
    m.snr,
    m.txRate,
    m.channel,
    m.band,
    m.ssid,
    m.bssid,
    m.count,
    m.min,
    m.max,
    m.timestamp,
  ]);
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") +
    "\r\n"
  );
}
