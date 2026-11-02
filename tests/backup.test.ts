import test from "node:test";
import assert from "node:assert/strict";
import { readSurveyBackup } from "../src/lib/backup.ts";
import { createLibrary, addSurvey, serializeLibrary } from "../src/lib/library.ts";
import { createSurvey } from "../src/lib/survey.ts";

test("all-floor backups larger than 8 MB restore through the same reader as the UI", async () => {
  let library = createLibrary();
  for (const char of ["A", "B", "C"]) {
    library = addSurvey(library, { ...createSurvey(), floorplan: `data:image/png;base64,${char.repeat(2_800_000)}` });
  }
  const file = new File([serializeLibrary(library)], "all-floors.json");
  assert.ok(file.size > 8_000_000);
  assert.deepEqual(await readSurveyBackup(file), library);
});

test("single floors still restore and malformed or schema-invalid backups are rejected", async () => {
  const survey = createSurvey();
  assert.deepEqual(await readSurveyBackup(new Blob([JSON.stringify(survey)])), survey);
  for (const data of ["not json", "null", JSON.stringify({ ...survey, width: -1 }), JSON.stringify({ version: 2, surveys: [] })]) {
    await assert.rejects(readSurveyBackup(new Blob([data])));
  }
});
