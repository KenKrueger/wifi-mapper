import { validateLibrary, type SurveyLibrary } from "./library.ts";
import { validateSurvey, type Survey } from "./survey.ts";

/** Restore every schema-valid backup we export, including large floor collections. */
export async function readSurveyBackup(
  file: Pick<File, "text">,
): Promise<SurveyLibrary | Survey> {
  const data: unknown = JSON.parse(await file.text());
  return data !== null &&
    typeof data === "object" &&
    "version" in data &&
    data.version === 2
    ? validateLibrary(data)
    : validateSurvey(data);
}
