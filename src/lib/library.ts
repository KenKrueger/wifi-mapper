import { createSurvey, validateSurvey, type Survey } from "./survey.ts";

export const LIBRARY_KEY = "fieldnote-library-v2";
export const LEGACY_KEY = "fieldnote-survey-v1";
const MAX_SURVEYS = 40;

export interface SurveyLibrary {
  version: 2;
  activeId: string;
  surveys: Survey[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid survey library.");
  return value as Record<string, unknown>;
}

export function createLibrary(survey: Survey = createSurvey()): SurveyLibrary {
  const validated = validateSurvey(survey);
  return { version: 2, activeId: validated.id, surveys: [validated] };
}

/** Accept both portable libraries and the image-deduplicated browser format. */
export function validateLibrary(value: unknown): SurveyLibrary {
  const library = object(value);
  if (library.version !== 2)
    throw new Error("Unsupported survey library version.");
  if (
    !Array.isArray(library.surveys) ||
    library.surveys.length < 1 ||
    library.surveys.length > MAX_SURVEYS
  )
    throw new Error("A library must contain between 1 and 40 surveys.");
  const assets = library.assets === undefined ? {} : object(library.assets);
  if (Object.keys(assets).length > MAX_SURVEYS)
    throw new Error("Too many floor plan images.");
  for (const [id, data] of Object.entries(assets)) {
    if (
      !/^image-\d+$/.test(id) ||
      typeof data !== "string" ||
      data.length > 3_000_000 ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(data)
    )
      throw new Error("Invalid saved floor plan image.");
  }
  const surveys = library.surveys.map((value) => {
    const survey = object(value);
    let floorplan = survey.floorplan;
    if (floorplan !== null && typeof floorplan === "object") {
      const reference = object(floorplan);
      if (
        typeof reference.asset !== "string" ||
        !Object.hasOwn(assets, reference.asset)
      )
        throw new Error("A saved floor plan image is missing.");
      floorplan = assets[reference.asset];
    }
    return validateSurvey({ ...survey, floorplan });
  });
  if (new Set(surveys.map((s) => s.id)).size !== surveys.length)
    throw new Error("Survey library contains duplicate identifiers.");
  if (
    typeof library.activeId !== "string" ||
    !surveys.some((s) => s.id === library.activeId)
  )
    throw new Error("The active survey is missing from the library.");
  return { version: 2, activeId: library.activeId, surveys };
}

/** Read legacy storage without replacing or deleting the original backup. */
export function loadLibrary(storage: Pick<Storage, "getItem">): SurveyLibrary {
  try {
    const saved = storage.getItem(LIBRARY_KEY);
    if (saved) return validateLibrary(JSON.parse(saved));
  } catch {
    /* A valid legacy survey may still be recoverable below. */
  }
  try {
    const legacy = storage.getItem(LEGACY_KEY);
    if (legacy) return createLibrary(validateSurvey(JSON.parse(legacy)));
  } catch {
    /* The caller gets an empty map; unreadable backups are retained. */
  }
  return createLibrary();
}

/** A self-contained backup with shared image pixels stored only once. */
export function serializeLibrary(value: SurveyLibrary): string {
  const library = validateLibrary(value);
  const assets: Record<string, string> = {};
  const imageIds = new Map<string, string>();
  const surveys = library.surveys.map((survey) => {
    if (survey.floorplan === null) return survey;
    let id = imageIds.get(survey.floorplan);
    if (!id) {
      id = `image-${imageIds.size}`;
      imageIds.set(survey.floorplan, id);
      assets[id] = survey.floorplan;
    }
    return { ...survey, floorplan: { asset: id } };
  });
  return JSON.stringify({ ...library, surveys, assets });
}

/** Save both floors in one atomic browser storage update. */
export function saveLibrary(
  storage: Pick<Storage, "setItem">,
  value: SurveyLibrary,
): void {
  // localStorage.setItem is atomic: a quota failure retains the last save.
  storage.setItem(LIBRARY_KEY, serializeLibrary(value));
}

export function addSurvey(
  library: SurveyLibrary,
  survey: Survey,
  activate = true,
): SurveyLibrary {
  const validated = validateSurvey(survey);
  const exists = library.surveys.some((s) => s.id === validated.id);
  if (!exists && library.surveys.length >= MAX_SURVEYS)
    throw new Error(
      "This library has 40 surveys. Export a backup before removing one.",
    );
  return {
    version: 2,
    activeId: activate ? validated.id : library.activeId,
    surveys: exists
      ? library.surveys.map((s) => (s.id === validated.id ? validated : s))
      : [...library.surveys, validated],
  };
}

/** Add new default floors without moving saved points onto revised artwork. */
export function mergeFloorTemplates(
  library: SurveyLibrary,
  floors: Survey[],
  allowReplacePlaceholder = false,
): SurveyLibrary {
  const knownIds = new Set(library.surveys.map((survey) => survey.id));
  const missing: Survey[] = [];
  for (const floor of floors) {
    // Stable survey IDs identify defaults; templateId may change with artwork.
    if (knownIds.has(floor.id)) continue;
    const validated = validateSurvey(floor);
    missing.push(validated);
    knownIds.add(validated.id);
  }
  if (!missing.length) return library;

  const only = library.surveys[0];
  const replacePlaceholder =
    allowReplacePlaceholder &&
    library.surveys.length === 1 &&
    only.name === "My home" &&
    only.width === 14 &&
    only.height === 10 &&
    only.createdAt === only.updatedAt &&
    only.scaleConfirmed === undefined &&
    only.floorplanView === undefined &&
    only.planNote === undefined &&
    only.templateId === undefined &&
    only.measurements.length === 0 &&
    only.walls.length === 0 &&
    only.floorplan === null &&
    only.router === null;
  const existing = replacePlaceholder ? [] : library.surveys;
  if (existing.length + missing.length > MAX_SURVEYS)
    throw new Error(
      "Adding these floor plans would exceed 40 surveys. Export a backup before removing one.",
    );
  return {
    ...library,
    activeId: replacePlaceholder ? missing[0]!.id : library.activeId,
    surveys: [...existing, ...missing],
  };
}

export function activateSurvey(
  library: SurveyLibrary,
  id: string,
): SurveyLibrary {
  if (!library.surveys.some((s) => s.id === id))
    throw new Error("Survey not found.");
  return { ...library, activeId: id };
}

export function updateActiveSurvey(
  library: SurveyLibrary,
  updater: (survey: Survey) => Survey,
): SurveyLibrary {
  const active = library.surveys.find((s) => s.id === library.activeId);
  if (!active) throw new Error("Survey not found.");
  const updated = validateSurvey(updater(active));
  if (updated.id !== active.id)
    throw new Error("Updating a survey cannot change its identifier.");
  return {
    ...library,
    surveys: library.surveys.map((s) => (s.id === active.id ? updated : s)),
  };
}
