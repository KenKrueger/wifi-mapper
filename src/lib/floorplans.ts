import { createSurvey, type Survey } from "./survey";

// These viewports retain the supplied artwork's full geometry. The unchanged
// attachment stays local; browser storage uses a full-resolution WebP copy.
const plans = [
  {
    id: "home-first-floor-v1",
    templateId: "home-first-floor-layout-v2",
    name: "First floor",
    x: 8,
    y: 163,
    width: 566,
    height: 522,
  },
  {
    id: "home-second-floor-v1",
    templateId: "home-second-floor-layout-v2",
    name: "Second floor",
    x: 596,
    y: 158,
    width: 556,
    height: 523,
  },
  {
    id: "home-basement-v1",
    templateId: "home-basement-v1",
    name: "Basement",
    x: 1184,
    y: 140,
    width: 344,
    height: 621,
  },
] as const;
export const HOME_FLOOR_IDS: readonly string[] = plans.map((plan) => plan.id);

let imagePromise: Promise<string> | undefined;

async function readLocalPlan(): Promise<string> {
  const response = await fetch("/local-floorplans/home-with-basement.png", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error("The supplied floor plan is not available locally.");
  }
  const blob = await response.blob();
  if (!/^image\/(png|jpeg|webp)$/.test(blob.type) || blob.size > 4_000_000) {
    throw new Error("The local floor-plan image is invalid or too large.");
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  if (image.naturalWidth !== 1536 || image.naturalHeight !== 1024) {
    throw new Error(
      "The supplied floor plan has changed size. Upload it as a new plan instead.",
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Could not prepare the local floor-plan image.");
  context.drawImage(image, 0, 0);
  for (const quality of [0.9, 0.82, 0.72]) {
    const data = canvas.toDataURL("image/webp", quality);
    if (!data.startsWith("data:image/webp;base64,")) {
      throw new Error(
        "This browser cannot store the floor plan as WebP. Use a current browser.",
      );
    }
    if (data.length <= 700_000) return data;
  }
  throw new Error(
    "The local floor plan could not be compressed within the survey storage limit.",
  );
}

export async function loadHomeFloors(): Promise<Survey[]> {
  // A single image string is shared by all floors; library persistence also
  // deduplicates it, so the original is stored only once in local storage.
  imagePromise ??= readLocalPlan().catch((error) => {
    imagePromise = undefined;
    throw error;
  });
  const floorplan = await imagePromise;
  return plans.map((plan) => ({
    ...createSurvey(),
    id: plan.id,
    templateId: plan.templateId,
    name: plan.name,
    floorplan,
    floorplanView: {
      x: plan.x,
      y: plan.y,
      width: plan.width,
      height: plan.height,
      sourceWidth: 1536,
      sourceHeight: 1024,
    },
    // These values preserve the artwork's aspect ratio only. They are not
    // physical dimensions; metric UI remains hidden until the user sets scale.
    width: 10,
    height: (10 * plan.height) / plan.width,
    scaleConfirmed: false,
    planNote:
      "Approximate reconstruction · not to scale. Verify room positions and dimensions on site.",
  }));
}
