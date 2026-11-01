import test from "node:test";
import assert from "node:assert/strict";
import { createLibraryPersistence, LibraryConflictError, type ExclusiveLock } from "../src/lib/persistence.ts";
import { createLibrary, addSurvey, activateSurvey, loadLibrary, saveLibrary, updateActiveSurvey, LIBRARY_KEY } from "../src/lib/library.ts";
import { createSurvey, summarizeReadings, type Reading } from "../src/lib/survey.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
function lock(): ExclusiveLock {
  let queue = Promise.resolve();
  return <T>(action: () => T): Promise<T> => {
    const result = queue.then(action);
    queue = result.then(() => {}, () => {});
    return result;
  };
}
function measured() {
  const now = Date.now();
  const reading: Reading = {
    timestamp: new Date(now).toISOString(), source: "corewlan", status: "connected",
    interface: "en0", ssid: "Test", bssid: null, rssi: -60, noise: -90, snr: 30,
    txRate: 100, channel: 36, band: "5 GHz", message: null,
  };
  return summarizeReadings([reading], { x: 0.5, y: 0.5 }, "Desk", now);
}

test("stale floor navigation cannot overwrite another tab's new measurement", async () => {
  const store = storage(), mutex = lock();
  saveLibrary(store, addSurvey(createLibrary(), createSurvey()));
  const a = createLibraryPersistence(store, mutex);
  const b = createLibraryPersistence(store, mutex);
  const edited = updateActiveSurvey(a.initial, (s) => ({ ...s, measurements: [measured()] }));
  await a.save(edited);
  const stale = activateSurvey(b.initial, b.initial.surveys[0]!.id);
  await assert.rejects(b.save(stale), LibraryConflictError);
  assert.deepEqual(loadLibrary(store), edited);
  assert.deepEqual(b.reload(), edited);
  await b.save(activateSurvey(edited, edited.surveys[0]!.id));
  assert.equal(loadLibrary(store).surveys.flatMap((s) => s.measurements).length, 1);
});

test("simultaneous saves serialize their compare and write; only one stale writer succeeds", async () => {
  const store = storage(), mutex = lock();
  saveLibrary(store, createLibrary());
  const a = createLibraryPersistence(store, mutex), b = createLibraryPersistence(store, mutex);
  const first = updateActiveSurvey(a.initial, (s) => ({ ...s, name: "Tab A" }));
  const second = updateActiveSurvey(b.initial, (s) => ({ ...s, name: "Tab B" }));
  const results = await Promise.allSettled([a.save(first), b.save(second)]);
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  assert.deepEqual(loadLibrary(store), first);
});

test("cancelled saves and queued pre-reload saves never reach storage", async () => {
  const store = storage(), mutex = lock();
  saveLibrary(store, createLibrary());
  const session = createLibraryPersistence(store, mutex);
  const original = store.getItem(LIBRARY_KEY);
  const edit = updateActiveSurvey(session.initial, (s) => ({ ...s, name: "Unsaved" }));
  assert.equal(await session.save(edit, () => false), false);
  const pending = session.save(edit);
  session.reload();
  assert.equal(await pending, false);
  assert.equal(store.getItem(LIBRARY_KEY), original);
});

test("quota failures preserve the last save and allow a later retry", async () => {
  const store = storage();
  saveLibrary(store, createLibrary());
  let full = true;
  const limited = { ...store, setItem(key: string, value: string) {
    if (full) throw new DOMException("Full", "QuotaExceededError");
    store.setItem(key, value);
  } };
  const session = createLibraryPersistence(limited, lock());
  const edit = updateActiveSurvey(session.initial, (s) => ({ ...s, name: "Retry" }));
  await assert.rejects(session.save(edit), /Full/);
  assert.deepEqual(loadLibrary(store), session.initial);
  full = false;
  assert.equal(await session.save(edit), true);
  assert.deepEqual(loadLibrary(store), edit);
});

test("unavailable locks and unreadable stored collections cannot be overwritten", async () => {
  const store = storage();
  const unavailable = createLibraryPersistence(store);
  await assert.rejects(unavailable.save(unavailable.initial), /current browser/);
  assert.equal(store.getItem(LIBRARY_KEY), null);
  store.setItem(LIBRARY_KEY, "unreadable original");
  const damaged = createLibraryPersistence(store, lock());
  await assert.rejects(damaged.save(damaged.initial), /preserved/);
  assert.throws(() => damaged.reload());
  assert.equal(store.getItem(LIBRARY_KEY), "unreadable original");
});

test("saving an unchanged snapshot does not repeat the storage write", async () => {
  const store = storage();
  saveLibrary(store, createLibrary());
  let writes = 0;
  const session = createLibraryPersistence({ ...store, setItem(key, value) {
    writes++; store.setItem(key, value);
  } }, lock());
  await session.save(session.initial);
  await session.save(session.initial);
  assert.equal(writes, 0);
});

test("confirmed restore archives corrupt data before allowing a valid replacement", async () => {
  const store = storage();
  store.setItem(LIBRARY_KEY, "damaged original");
  const session = createLibraryPersistence(store, lock());
  const restored = createLibrary();
  await assert.rejects(session.save(restored), /preserved/);
  assert.throws(() => session.authorizeRestore(() => { throw new Error("download failed"); }));
  await assert.rejects(session.save(restored), /preserved/);
  const archived: string[] = [];
  session.authorizeRestore((raw) => archived.push(raw));
  assert.equal(store.getItem(LIBRARY_KEY), "damaged original");
  await session.save(restored);
  assert.deepEqual(archived, ["damaged original"]);
  assert.deepEqual(loadLibrary(store), restored);
});

test("recovery cannot overwrite a newer collection or commit queued fallback state", async () => {
  const store = storage(), mutex = lock();
  store.setItem(LIBRARY_KEY, "damaged original");
  const session = createLibraryPersistence(store, mutex);
  const pending = session.save(session.initial);
  session.authorizeRestore(() => {});
  assert.equal(await pending, false);
  assert.equal(store.getItem(LIBRARY_KEY), "damaged original");

  const other = createLibraryPersistence(store, mutex);
  saveLibrary(store, createLibrary());
  assert.throws(() => other.authorizeRestore(() => {}), LibraryConflictError);
});
