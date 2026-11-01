import test from "node:test";
import assert from "node:assert/strict";
import {
  activateSurvey,
  addSurvey,
  createLibrary,
  LEGACY_KEY,
  LIBRARY_KEY,
  loadLibrary,
  mergeFloorTemplates,
  saveLibrary,
  serializeLibrary,
  updateActiveSurvey,
  validateLibrary,
} from "../src/lib/library.ts";
import {
  createSurvey,
  exportCSV,
  summarizeReadings,
  validateSurvey,
  type Reading,
  type Survey,
} from "../src/lib/survey.ts";

const image = "data:image/png;base64,QUJDRA==";
function floor(name: string): Survey {
  return {
    ...createSurvey(),
    name,
    floorplan: image,
    floorplanView: {
      x: 30,
      y: 130,
      width: 700,
      height: 600,
      sourceWidth: 1536,
      sourceHeight: 1024,
    },
    scaleConfirmed: false,
    planNote: "Approximate reconstruction; not to scale.",
    templateId: name,
  };
}
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("switching floors retains independent walls, routers, and active edits", () => {
  const first = floor("First floor"),
    second = floor("Second floor");
  let library = addSurvey(createLibrary(first), second);
  library = updateActiveSurvey(library, (survey) => ({
    ...survey,
    router: { x: 0.6, y: 0.4 },
    walls: [{ id: "upstairs-wall", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }],
  }));
  library = activateSurvey(library, first.id);
  library = updateActiveSurvey(library, (survey) => ({
    ...survey,
    name: "Downstairs",
  }));
  assert.equal(library.activeId, first.id);
  assert.equal(library.surveys[0]!.name, "Downstairs");
  assert.equal(library.surveys[0]!.walls.length, 0);
  assert.equal(library.surveys[0]!.router, null);
  assert.equal(library.surveys[1]!.walls.length, 1);
  assert.deepEqual(library.surveys[1]!.router, { x: 0.6, y: 0.4 });
  assert.equal(
    first.name,
    "First floor",
    "Updates do not mutate the original state",
  );
  assert.throws(() => activateSurvey(library, "missing"), /not found/);
  assert.throws(
    () => updateActiveSurvey(library, (s) => ({ ...s, id: "changed" })),
    /identifier/,
  );
});

test("legacy surveys migrate without deleting the previous browser backup", () => {
  const store = storage(),
    legacy = createSurvey();
  legacy.name = "Existing house map";
  const raw = JSON.stringify(legacy);
  store.setItem(LEGACY_KEY, raw);
  const library = loadLibrary(store);
  assert.deepEqual(library.surveys, [legacy]);
  saveLibrary(store, library);
  assert.equal(store.getItem(LEGACY_KEY), raw);
  assert.deepEqual(loadLibrary(store), library);
  store.setItem(LIBRARY_KEY, "invalid new storage");
  assert.deepEqual(loadLibrary(store).surveys, [legacy]);
  assert.equal(store.getItem(LIBRARY_KEY), "invalid new storage");
});

test("shared plan pixels are saved only once and hydrate with separate floor views", () => {
  const store = storage(),
    first = floor("First floor"),
    second = floor("Second floor");
  second.floorplanView = { ...second.floorplanView!, x: 810, width: 704 };
  const library = addSurvey(createLibrary(first), second);
  saveLibrary(store, library);
  const raw = store.getItem(LIBRARY_KEY)!;
  assert.equal(serializeLibrary(library), raw);
  assert.equal(raw.split(image).length - 1, 1);
  const packed = JSON.parse(raw);
  assert.equal(Object.keys(packed.assets).length, 1);
  assert.deepEqual(
    packed.surveys.map((s: { floorplan: unknown }) => s.floorplan),
    [{ asset: "image-0" }, { asset: "image-0" }],
  );
  assert.deepEqual(validateLibrary(packed), library);
  assert.deepEqual(loadLibrary(store), library);
  assert.deepEqual(
    validateLibrary(JSON.parse(JSON.stringify(library))),
    library,
  );
});

test("quota failures retain the previous library and surface an error", () => {
  const store = storage(),
    library = createLibrary(floor("First floor"));
  saveLibrary(store, library);
  const before = store.getItem(LIBRARY_KEY);
  const fullStorage = {
    setItem: () => {
      throw new DOMException("Full", "QuotaExceededError");
    },
  };
  assert.throws(
    () => saveLibrary(fullStorage, addSurvey(library, floor("Second floor"))),
    /Full/,
  );
  assert.equal(store.getItem(LIBRARY_KEY), before);
});

test("floor metadata roundtrips and rejects invalid or out-of-bounds views", () => {
  const valid = floor("First floor");
  assert.deepEqual(validateSurvey(JSON.parse(JSON.stringify(valid))), valid);
  const legacy = createSurvey();
  assert.deepEqual(validateSurvey(legacy), legacy);
  assert.throws(
    () => validateSurvey({ ...valid, floorplan: null }),
    /requires an image/,
  );
  assert.throws(
    () => validateSurvey({ ...valid, scaleConfirmed: "yes" }),
    /scale/,
  );
  assert.throws(
    () => validateSurvey({ ...valid, planNote: "x".repeat(2001) }),
    /text/,
  );
  for (const badView of [
    { ...valid.floorplanView, x: -1 },
    { ...valid.floorplanView, width: 0 },
    { ...valid.floorplanView, width: 1600 },
    { ...valid.floorplanView, sourceWidth: 16385 },
    { ...valid.floorplanView, sourceHeight: 1.2 },
    { ...valid.floorplanView, height: NaN },
  ])
    assert.throws(() => validateSurvey({ ...valid, floorplanView: badView }));
});

test("library import rejects missing images, duplicate IDs, invalid active floor, and excess surveys", () => {
  const library = createLibrary(floor("First floor"));
  assert.throws(
    () => validateLibrary({ ...library, surveys: [] }),
    /between 1 and 40/,
  );
  assert.throws(
    () =>
      validateLibrary({
        ...library,
        surveys: [library.surveys[0], library.surveys[0]],
      }),
    /duplicate/,
  );
  assert.throws(
    () => validateLibrary({ ...library, activeId: "missing" }),
    /active survey/,
  );
  assert.throws(
    () =>
      validateLibrary({
        ...library,
        surveys: [{ ...library.surveys[0], floorplan: { asset: "missing" } }],
      }),
    /image is missing/,
  );
  assert.throws(
    () =>
      validateLibrary({
        ...library,
        assets: { "image-0": "https://remote/image.png" },
      }),
    /image/,
  );
  assert.throws(
    () =>
      validateLibrary({
        ...library,
        assets: JSON.parse('{"__proto__":"bad"}'),
      }),
    /image/,
  );
  const full = {
    ...library,
    surveys: Array.from({ length: 40 }, () => createSurvey()),
  };
  full.activeId = full.surveys[0]!.id;
  assert.throws(() => addSurvey(full, createSurvey()), /40 surveys/);
  const updated = addSurvey(
    full,
    { ...full.surveys[0]!, name: "Updated" },
    false,
  );
  assert.equal(updated.surveys.length, 40);
  assert.equal(updated.activeId, full.activeId);
  assert.equal(updated.surveys[0]!.name, "Updated");
});

test("unscaled CSV uses plan percentages instead of invented metric distances", () => {
  const survey = floor("First floor"),
    now = Date.now();
  const reading: Reading = {
    timestamp: new Date(now).toISOString(),
    source: "corewlan",
    status: "connected",
    interface: "en0",
    ssid: null,
    bssid: null,
    rssi: -65,
    noise: -90,
    snr: 25,
    txRate: 144,
    channel: 36,
    band: "5 GHz",
    message: null,
  };
  survey.measurements.push(
    summarizeReadings([reading], { x: 0.25, y: 0.75 }, "Spot", now),
  );
  const relative = exportCSV(survey);
  assert.ok(relative.includes('"X (plan %)","Y (plan %)"'));
  assert.ok(relative.includes('"Spot","25","75"'));
  const metric = exportCSV({ ...survey, scaleConfirmed: true });
  assert.ok(metric.includes('"X (m)","Y (m)"'));
  assert.ok(metric.includes('"Spot","3.5","7.5"'));
});

test("revised defaults retain saved floor images and readings while adding the basement", () => {
  const first = floor("First floor"),
    second = floor("Second floor"),
    basement = floor("Basement");
  const now = Date.now();
  const reading: Reading = {
    timestamp: new Date(now).toISOString(),
    source: "corewlan",
    status: "connected",
    interface: "en0",
    ssid: null,
    bssid: null,
    rssi: -74,
    noise: -91,
    snr: 17,
    txRate: 144,
    channel: 36,
    band: "5 GHz",
    message: null,
  };
  first.measurements = [
    summarizeReadings([reading], { x: 0.2, y: 0.7 }, "Desk", now),
  ];
  first.router = { x: 0.6, y: 0.5 };
  first.walls = [
    { id: "saved-wall", a: { x: 0.1, y: 0.2 }, b: { x: 0.9, y: 0.2 } },
  ];
  first.width = 12;
  first.scaleConfirmed = true;
  second.router = { x: 0.4, y: 0.3 };
  const library = addSurvey(createLibrary(first), second);
  const original = JSON.stringify(library);
  const revised = [first, second].map((survey) => ({
    ...survey,
    templateId: `${survey.templateId}-v2`,
    floorplan: "data:image/webp;base64,VVBEQVRF",
    measurements: [],
    walls: [],
    router: null,
    floorplanView: {
      ...survey.floorplanView!,
      x: 8,
      y: 163,
      width: 566,
      height: 522,
    },
  }));
  const merged = mergeFloorTemplates(library, [...revised, basement]);
  assert.equal(merged.activeId, second.id);
  assert.equal(merged.surveys.length, 3);
  assert.equal(merged.surveys[0], library.surveys[0]);
  assert.equal(merged.surveys[1], library.surveys[1]);
  assert.deepEqual(merged.surveys.slice(0, 2), library.surveys);
  assert.deepEqual(merged.surveys[2], basement);
  assert.equal(JSON.stringify(library), original);
  assert.equal(mergeFloorTemplates(merged, [...revised, basement]), merged);
  assert.equal(mergeFloorTemplates(merged, []), merged);
});

test("default placeholder replacement is opt-in and preserves configured or saved maps", () => {
  const defaults = [
    floor("First floor"),
    floor("Second floor"),
    floor("Basement"),
  ];
  const placeholder = createLibrary();
  const kept = mergeFloorTemplates(placeholder, defaults);
  assert.equal(kept.surveys[0], placeholder.surveys[0]);
  assert.equal(kept.activeId, placeholder.activeId);
  assert.equal(kept.surveys.length, 4);
  const replaced = mergeFloorTemplates(placeholder, defaults, true);
  assert.deepEqual(replaced.surveys, defaults);
  assert.equal(replaced.activeId, defaults[0]!.id);
  for (const changes of [
    { width: 20 },
    { height: 8 },
    { scaleConfirmed: false },
    { scaleConfirmed: true },
    { name: "My configured home" },
    { planNote: "Keep this map" },
    { updatedAt: "2020-01-01T00:00:00.000Z" },
    { router: { x: 0.5, y: 0.5 } },
    { floorplan: image },
  ]) {
    const configured = createLibrary({ ...createSurvey(), ...changes });
    const result = mergeFloorTemplates(configured, defaults, true);
    assert.equal(result.surveys[0], configured.surveys[0]);
    assert.equal(result.activeId, configured.activeId);
  }
  const saved = storage();
  saveLibrary(saved, placeholder);
  const restored = loadLibrary(saved);
  assert.equal(
    mergeFloorTemplates(restored, defaults).activeId,
    restored.activeId,
  );
});

test("template merge validates missing floors, deduplicates IDs, and fails atomically at capacity", () => {
  const library = createLibrary(floor("Existing floor"));
  const added = floor("Basement");
  const merged = mergeFloorTemplates(library, [added, added]);
  assert.equal(merged.surveys.length, 2);
  assert.equal(merged.activeId, library.activeId);
  assert.throws(
    () => mergeFloorTemplates(library, [{ ...added, width: NaN }]),
    /number/,
  );
  const almostFull = {
    ...library,
    surveys: [
      ...library.surveys,
      ...Array.from({ length: 38 }, () => createSurvey()),
    ],
  };
  const snapshot = JSON.stringify(almostFull);
  assert.throws(
    () => mergeFloorTemplates(almostFull, [added, floor("Another floor")]),
    /exceed 40/,
  );
  assert.equal(JSON.stringify(almostFull), snapshot);
  assert.equal(almostFull.surveys.length, 39);
  assert.equal(mergeFloorTemplates(almostFull, [added]).surveys.length, 40);
});
