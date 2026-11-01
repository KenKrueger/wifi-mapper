import {
  LIBRARY_KEY,
  loadLibrary,
  serializeLibrary,
  validateLibrary,
  type SurveyLibrary,
} from "./library.ts";

type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export type ExclusiveLock = <T>(action: () => T) => Promise<T>;

export class LibraryConflictError extends Error {
  constructor() {
    super(
      "Another tab saved changes. Export this tab's changes before loading the saved collection.",
    );
  }
}

/** Each tab owns a snapshot; comparison and write run under one origin-wide lock. */
export function createLibraryPersistence(
  storage: StorageAccess,
  withLock?: ExclusiveLock,
) {
  let expected: string | null = null;
  let unreadable = false;
  let generation = 0;
  function read(): SurveyLibrary {
    unreadable = false;
    try {
      expected = storage.getItem(LIBRARY_KEY);
      if (expected !== null) return validateLibrary(JSON.parse(expected));
    } catch {
      // Keep an unreadable collection intact, even if a legacy fallback loads.
      unreadable = true;
    }
    return loadLibrary({
      getItem: (key) => (key === LIBRARY_KEY ? null : storage.getItem(key)),
    });
  }
  const initial = read();
  return {
    initial,
    async save(value: SurveyLibrary, isCurrent = () => true): Promise<boolean> {
      const queuedGeneration = generation;
      if (!withLock)
        throw new Error(
          "Automatic saving needs a current browser. Export a backup to keep your changes.",
        );
      return withLock(() => {
        if (queuedGeneration !== generation || !isCurrent()) return false;
        if (unreadable)
          throw new Error(
            "Saved data could not be read. Export your changes, then restore an all-floors backup to recover. The original has been preserved.",
          );
        if (storage.getItem(LIBRARY_KEY) !== expected)
          throw new LibraryConflictError();
        const next = serializeLibrary(value);
        if (next !== expected) storage.setItem(LIBRARY_KEY, next);
        // Advance only after a successful write; quota failures remain retryable.
        expected = next;
        return true;
      });
    },
    // Only the explicitly confirmed all-floor restore can replace damaged data.
    // Offer the original download first; failed downloads leave the guard in place.
    authorizeRestore(archiveUnreadable: (raw: string) => void): void {
      if (!unreadable) return;
      if (storage.getItem(LIBRARY_KEY) !== expected)
        throw new LibraryConflictError();
      if (expected !== null) archiveUnreadable(expected);
      generation++;
      unreadable = false;
    },
    reload(): SurveyLibrary {
      const raw = storage.getItem(LIBRARY_KEY);
      // Validate before accepting a new baseline or discarding the in-memory copy.
      const next = raw === null
        ? loadLibrary(storage)
        : validateLibrary(JSON.parse(raw));
      generation++;
      expected = raw;
      unreadable = false;
      return next;
    },
  };
}
