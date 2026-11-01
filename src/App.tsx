import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CircleHelp,
  Crosshair,
  Download,
  House,
  ImagePlus,
  Layers2,
  MapPin,
  MousePointer2,
  Plus,
  Radio,
  Radar,
  Route,
  Ruler,
  ScanLine,
  Settings2,
  ShieldCheck,
  Trash2,
  Undo2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  canCombineReadings,
  createSurvey,
  exportCSV,
  interpolateAt,
  isFreshReading,
  quality,
  summarizeReadings,
  validateSurvey,
  type Point,
  type Reading,
  type Survey,
} from "./lib/survey";
import {
  activateSurvey,
  addSurvey,
  loadLibrary,
  mergeFloorTemplates,
  saveLibrary,
  serializeLibrary,
  updateActiveSurvey,
  validateLibrary,
  type SurveyLibrary,
} from "./lib/library";
import { HOME_FLOOR_IDS, loadHomeFloors } from "./lib/floorplans";

type Mode = "measure" | "walls" | "router";
type Capture = {
  position: Point;
  readings: Reading[];
  started: number;
  surveyId: string;
};
type Notice = { text: string; error?: boolean } | null;

function download(content: Blob | string, filename: string) {
  const url =
    typeof content === "string" ? content : URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  if (typeof content !== "string")
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function rgbFor(rssi: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [-95, [210, 85, 64]],
    [-80, [225, 126, 66]],
    [-70, [224, 183, 77]],
    [-60, [149, 180, 97]],
    [-45, [51, 137, 107]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (rssi <= stops[i][0]) {
      const a = stops[i - 1],
        b = stops[i];
      const t = Math.max(0, (rssi - a[0]) / (b[0] - a[0]));
      return a[1].map((v, j) => Math.round(v + (b[1][j] - v) * t)) as [
        number,
        number,
        number,
      ];
    }
  }
  return stops.at(-1)![1];
}
function paintHeatmap(
  canvas: HTMLCanvasElement,
  survey: Survey,
  radius: number,
) {
  const w = 240,
    h = Math.max(
      80,
      Math.min(
        600,
        Math.round(
          w *
            (survey.floorplanView
              ? survey.floorplanView.height / survey.floorplanView.width
              : survey.height / survey.width),
        ),
      ),
    );
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const value = interpolateAt(
        x / (w - 1),
        y / (h - 1),
        survey.measurements,
        survey.width,
        survey.height,
        radius,
      );
      if (!value) continue;
      const index = (y * w + x) * 4;
      const rgb = rgbFor(value.rssi);
      img.data[index] = rgb[0];
      img.data[index + 1] = rgb[1];
      img.data[index + 2] = rgb[2];
      img.data[index + 3] = Math.round(165 * value.confidence);
    }
  ctx.putImageData(img, 0, 0);
}

function Sparkline({ readings }: { readings: Reading[] }) {
  const values = readings.slice(-50);
  const y = (r: number) =>
    65 - ((Math.max(-95, Math.min(-30, r)) + 95) / 65) * 56;
  // Missing readings break the line; gaps never become fake signal measurements.
  const paths: string[] = [];
  let path = "";
  values.forEach((r, i) => {
    if (r.status !== "connected" || r.rssi === null) {
      if (path) paths.push(path);
      path = "";
      return;
    }
    path += `${path ? "L" : "M"}${(i * 250) / 49},${y(r.rssi)} `;
  });
  if (path) paths.push(path);
  return (
    <svg
      className="sparkline"
      viewBox="0 0 250 76"
      role="img"
      aria-label="Live signal history for the last 50 readings"
    >
      {[20, 43, 66].map((v) => (
        <line
          key={v}
          x1="0"
          y1={v}
          x2="250"
          y2={v}
          stroke="currentColor"
          opacity=".11"
          strokeDasharray="3 5"
        />
      ))}
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="#bdcf8d"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
      {values.length === 0 && (
        <text x="125" y="43" textAnchor="middle" fill="#b7c9bd" fontSize="11">
          Waiting for the Wi-Fi radio…
        </text>
      )}
    </svg>
  );
}

export default function App() {
  const [library, setLibrary] = useState<SurveyLibrary>(() =>
    loadLibrary(localStorage),
  );
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [hadSavedSurvey] = useState(() => {
    try {
      return Boolean(
        localStorage.getItem("fieldnote-library-v2") ||
        localStorage.getItem("fieldnote-survey-v1"),
      );
    } catch {
      return true;
    }
  });
  const survey = library.surveys.find(
    (floor) => floor.id === library.activeId,
  )!;
  const [reading, setReading] = useState<Reading | null>(null);
  const [history, setHistory] = useState<Reading[]>([]);
  const [streamOpen, setStreamOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<Mode>("measure");
  const [heatmap, setHeatmap] = useState(true);
  const [radius, setRadius] = useState(4);
  const [wallStart, setWallStart] = useState<Point | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const surveyRef = useRef(survey);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [newSurveyOpen, setNewSurveyOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const mapRef = useRef<SVGSVGElement>(null);
  const [mapScale, setMapScale] = useState(1);
  const heatRef = useRef<HTMLCanvasElement>(null);
  const floorInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const notify = (text: string, error = false) => setNotice({ text, error });
  function change(update: (old: Survey) => Survey) {
    setDirty(true);
    setLibrary((state) =>
      updateActiveSurvey(state, (old) => ({
        ...update(old),
        updatedAt: new Date().toISOString(),
      })),
    );
  }
  function stopCapture() {
    captureRef.current = null;
    setCapture(null);
  }
  useEffect(() => {
    surveyRef.current = survey;
  }, [survey]);
  useEffect(() => {
    if (!dirty) return;
    try {
      saveLibrary(localStorage, library);
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }, [library, dirty]);
  useEffect(() => {
    if (
      HOME_FLOOR_IDS.every((id) =>
        libraryRef.current.surveys.some((floor) => floor.id === id),
      )
    )
      return;
    let cancelled = false;
    void loadHomeFloors()
      .then((floors) => {
        if (cancelled) return;
        setLibrary(
          mergeFloorTemplates(libraryRef.current, floors, !hadSavedSurvey),
        );
        setDirty(true);
      })
      .catch((error) => {
        if (!cancelled)
          notify(
            error instanceof Error
              ? error.message
              : "Could not load your floor plan.",
            true,
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const revisedPlanId = ["home-first-floor-v1", "home-second-floor-v1"].find(
    (id) =>
      (survey.id === id || survey.templateId === id) &&
      !survey.templateId?.endsWith("layout-v2"),
  );
  async function useRevisedPlan() {
    if (!revisedPlanId || imageBusy || captureRef.current) return;
    setImageBusy(true);
    try {
      const floors = await loadHomeFloors();
      const template = floors.find((floor) => floor.id === revisedPlanId);
      if (!template) throw new Error("The revised floor plan is unavailable.");
      const next = {
        ...template,
        id: crypto.randomUUID(),
        name: `${template.name} · revised`,
      };
      setLibrary(addSurvey(libraryRef.current, next));
      setDirty(true);
      setSelected(null);
      setWallStart(null);
      setPointer(null);
      setNewSurveyOpen(false);
      setMode("measure");
      notify("Revised plan ready. Your previous survey is still saved.");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not load the revised plan.",
        true,
      );
    } finally {
      setImageBusy(false);
    }
  }
  function switchFloor(id: string) {
    if (captureRef.current || imageBusy) return;
    setLibrary((old) => activateSurvey(old, id));
    setDirty(true);
    setSelected(null);
    setWallStart(null);
    setPointer(null);
    setMode("measure");
  }
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const stream = new EventSource("/api/stream");
    stream.onopen = () => setStreamOpen(true);
    stream.onerror = () => {
      setStreamOpen(false);
      if (captureRef.current) {
        stopCapture();
        notify(
          "The local sensor disconnected. That measurement was not saved.",
          true,
        );
      }
    };
    const onReading = (event: MessageEvent) => {
      let next: Reading;
      try {
        next = JSON.parse(event.data);
      } catch {
        return;
      }
      setReading(next);
      setHistory((old) => [...old.slice(-59), next]);
      const current = captureRef.current;
      if (!current) return;
      if (
        !isFreshReading(next) ||
        Date.parse(next.timestamp) <= current.started ||
        current.readings.some((r) => r.timestamp === next.timestamp)
      )
        return;
      if (!["connected", "disconnected"].includes(next.status)) {
        stopCapture();
        notify("The radio is unavailable. No measurement was saved.", true);
        return;
      }
      if (
        current.readings.length &&
        !canCombineReadings(current.readings[0], next)
      ) {
        stopCapture();
        notify(
          "Your connection changed during this measurement. Stay still and try again.",
          true,
        );
        return;
      }
      const collected = { ...current, readings: [...current.readings, next] };
      captureRef.current = collected;
      setCapture(collected);
      if (collected.readings.length >= 4) {
        try {
          const measurement = summarizeReadings(
            collected.readings,
            collected.position,
            `Point ${surveyRef.current.measurements.length + 1}`,
          );
          if (surveyRef.current.id !== collected.surveyId)
            throw Error("The selected floor changed. Please measure again.");
          if (measurement.count !== 4)
            throw Error(
              "Some readings expired. Stay still and try again for four fresh samples.",
            );
          const network = surveyRef.current.measurements.find(
            (m) => m.ssid,
          )?.ssid;
          if (network && measurement.ssid && network !== measurement.ssid)
            throw Error(
              "Your Wi-Fi network changed. Start a new survey for this network.",
            );
          change((old) => ({
            ...old,
            measurements: [...old.measurements, measurement],
          }));
          setSelected(measurement.id);
          notify(
            measurement.rssi === null
              ? "Connection loss marked on your map."
              : `Point saved · ${measurement.rssi} dBm from ${measurement.count} real readings.`,
          );
        } catch (error) {
          notify(
            error instanceof Error
              ? error.message
              : "Could not save this measurement.",
            true,
          );
        }
        stopCapture();
      }
    };
    stream.addEventListener("reading", onReading as EventListener);
    return () => stream.close();
  }, []);
  useEffect(() => {
    if (capture && now - capture.started > 8000) {
      stopCapture();
      notify(
        "Not enough fresh readings. Check the sensor and try again.",
        true,
      );
    }
  }, [now, capture]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setWallStart(null);
        stopCapture();
        setHelp(false);
        setSettings(false);
        setExportOpen(false);
        setNewSurveyOpen(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (heatRef.current) paintHeatmap(heatRef.current, survey, radius);
  }, [survey, radius]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setMapScale(1000 / entry.contentRect.width);
    });
    if (mapRef.current) observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, []);

  const fresh = !!reading && streamOpen && isFreshReading(reading, now);
  const rssi = fresh && reading?.status === "connected" ? reading.rssi : null;
  const available =
    fresh &&
    !!reading &&
    ["connected", "disconnected"].includes(reading.status);
  const q = quality(rssi);
  const measurements = survey.measurements;
  const scaled = survey.scaleConfirmed !== false;
  const measured = measurements.filter((m) => m.rssi !== null);
  const weak = measurements.filter((m) => m.rssi === null || m.rssi < -70);
  const average = measured.length
    ? Math.round(
        measured.reduce((sum, m) => sum + m.rssi!, 0) / measured.length,
      )
    : null;
  const activePoint = measurements.find((m) => m.id === selected);
  const mapAspect = survey.floorplanView
    ? survey.floorplanView.width / survey.floorplanView.height
    : survey.width / survey.height;
  const mapHeight = 1000 / mapAspect;
  const mapStatus = capture
    ? `Hold still · ${capture.readings.length}/4 readings`
    : mode === "walls"
      ? wallStart
        ? "Click the end of this wall · Esc to cancel"
        : "Click two points to draw a wall"
      : mode === "router"
        ? "Click to mark your router’s location"
        : "Click your current location to measure";
  const sensorLabel = !streamOpen
    ? "Connecting to sensor"
    : !fresh
      ? "Waiting for fresh data"
      : reading?.status === "connected"
        ? "Live from your Mac"
        : reading?.status === "disconnected"
          ? "Wi-Fi connection lost"
          : reading?.status === "wifi_off"
            ? "Wi-Fi is switched off"
            : "Sensor unavailable";

  function location(event: React.MouseEvent<SVGSVGElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }
  function handleMap(point: Point, forceMeasure = false) {
    if (capture || imageBusy) return;
    if (!forceMeasure && mode === "walls") {
      if (survey.walls.length >= 500) {
        notify("This map has reached 500 walls.", true);
        return;
      }
      if (wallStart) {
        change((old) => ({
          ...old,
          walls: [
            ...old.walls,
            { id: crypto.randomUUID(), a: wallStart, b: point },
          ],
        }));
        setWallStart(null);
      } else setWallStart(point);
      return;
    }
    if (!forceMeasure && mode === "router") {
      change((old) => ({ ...old, router: point }));
      setMode("measure");
      notify("Router location marked.");
      return;
    }
    if (!available) {
      notify(
        "Waiting for live Wi-Fi readings. Run the local app with Wi-Fi enabled.",
        true,
      );
      return;
    }
    const previous = survey.measurements.find((m) => m.ssid)?.ssid;
    if (previous && reading?.ssid && previous !== reading.ssid) {
      notify(
        "You switched Wi-Fi networks. Start a new survey to keep the maps separate.",
        true,
      );
      return;
    }
    if (measurements.length >= 3000) {
      notify(
        "This survey has reached 3,000 points. Export it and start a new survey.",
        true,
      );
      return;
    }
    const next = {
      position: point,
      readings: [],
      started: Date.now(),
      surveyId: survey.id,
    };
    captureRef.current = next;
    setCapture(next);
    setSelected(null);
  }
  function undo() {
    if (capture) {
      stopCapture();
      return;
    }
    if (wallStart) {
      setWallStart(null);
      return;
    }
    if (mode === "walls") {
      change((old) => ({ ...old, walls: old.walls.slice(0, -1) }));
    } else {
      change((old) => ({
        ...old,
        measurements: old.measurements.slice(0, -1),
      }));
      setSelected(null);
    }
  }
  async function uploadFloor(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      notify("Choose a PNG, JPG, or WebP image.", true);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      notify("Please choose an image smaller than 20 MB.", true);
      return;
    }
    setImageBusy(true);
    const targetId = survey.id;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas
        .getContext("2d")!
        .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const data = canvas.toDataURL("image/webp", 0.82);
      if (data.length > 3_000_000)
        throw Error("This image is too detailed. Try a smaller floor plan.");
      setDirty(true);
      setLibrary((state) => ({
        ...state,
        surveys: state.surveys.map((old) =>
          old.id !== targetId
            ? old
            : {
                ...old,
                floorplan: data,
                floorplanView: {
                  x: 0,
                  y: 0,
                  width: canvas.width,
                  height: canvas.height,
                  sourceWidth: canvas.width,
                  sourceHeight: canvas.height,
                },
                planNote: undefined,
                templateId: undefined,
                scaleConfirmed: false,
                updatedAt: new Date().toISOString(),
                ...(!old.measurements.length && !old.walls.length
                  ? {
                      height: Math.max(
                        2,
                        Math.min(
                          100,
                          Math.round(
                            ((old.width * canvas.height) / canvas.width) * 10,
                          ) / 10,
                        ),
                      ),
                    }
                  : {}),
              },
        ),
      }));
      notify("Floor plan added. Set its real dimensions in Map settings.");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not read that image.",
        true,
      );
    } finally {
      setImageBusy(false);
    }
  }
  async function importSurvey(file: File) {
    try {
      if (file.size > 8_000_000) throw Error("Survey file is too large.");
      const data = JSON.parse(await file.text());
      const imported = data.version === 2 ? validateLibrary(data) : null;
      const loaded = imported ? null : validateSurvey(data);
      stopCapture();
      if (imported) {
        if (
          !window.confirm(
            "Restore all floors from this backup? This replaces the current floor collection.",
          )
        )
          return;
        setLibrary(imported);
      } else if (loaded) {
        const existing = libraryRef.current.surveys.find(
          (floor) => floor.id === loaded.id,
        );
        if (
          existing?.measurements.length &&
          !window.confirm(
            "Replace the saved version of this floor with the imported survey? Other floors will stay saved.",
          )
        )
          return;
        setLibrary(addSurvey(libraryRef.current, loaded));
      }
      setDirty(true);
      setSelected(null);
      setWallStart(null);
      setMode("measure");
      notify("Survey restored.");
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "That file is not a valid survey.",
        true,
      );
    }
  }
  async function exportMap() {
    try {
      const heatSnapshot = document.createElement("canvas");
      if (heatRef.current) {
        heatSnapshot.width = heatRef.current.width;
        heatSnapshot.height = heatRef.current.height;
        heatSnapshot.getContext("2d")!.drawImage(heatRef.current, 0, 0);
      }
      const c = document.createElement("canvas");
      const mapWidth = Math.min(1440, Math.round(3500 * mapAspect));
      c.width = Math.max(1200, mapWidth + 160);
      const h = Math.round(mapWidth / mapAspect);
      c.height = h + 300;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#f6f5f0";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#233c33";
      ctx.font = "bold 34px sans-serif";
      ctx.fillText(`Fieldnote / ${survey.name}`, 80, 65);
      ctx.font = "18px sans-serif";
      ctx.fillStyle = "#6b756d";
      ctx.fillText(
        `${measurements.length} measured points · ${scaled ? `${survey.width} × ${survey.height} m` : "Unscaled floor plan"} · ${new Date().toLocaleDateString()}`,
        80,
        100,
      );
      ctx.save();
      ctx.translate(80, 130);
      ctx.fillStyle = "#fffef9";
      ctx.fillRect(0, 0, mapWidth, h);
      if (survey.floorplan) {
        const img = new Image();
        img.src = survey.floorplan;
        await img.decode();
        const view = survey.floorplanView ?? {
          x: 0,
          y: 0,
          width: img.width,
          height: img.height,
        };
        const scale = Math.min(mapWidth / view.width, h / view.height);
        ctx.globalAlpha = 0.9;
        ctx.drawImage(
          img,
          view.x,
          view.y,
          view.width,
          view.height,
          (mapWidth - view.width * scale) / 2,
          (h - view.height * scale) / 2,
          view.width * scale,
          view.height * scale,
        );
        ctx.globalAlpha = 1;
      }
      if (heatmap) ctx.drawImage(heatSnapshot, 0, 0, mapWidth, h);
      ctx.strokeStyle = "#42574a";
      ctx.lineWidth = 5;
      survey.walls.forEach((w) => {
        ctx.beginPath();
        ctx.moveTo(w.a.x * mapWidth, w.a.y * h);
        ctx.lineTo(w.b.x * mapWidth, w.b.y * h);
        ctx.stroke();
      });
      measurements.forEach((m) => {
        const x = m.x * mapWidth,
          y = m.y * h;
        ctx.beginPath();
        ctx.arc(x, y, 18, 0, Math.PI * 2);
        ctx.fillStyle = quality(m.rssi).color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(m.rssi === null ? "×" : String(m.rssi), x, y + 5);
      });
      if (survey.router) {
        ctx.fillStyle = "#233c33";
        ctx.font = "bold 18px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          "⌂ Router",
          survey.router.x * mapWidth,
          survey.router.y * h,
        );
      }
      ctx.restore();
      ctx.textAlign = "left";
      ctx.fillStyle = "#6b756d";
      ctx.font = "17px sans-serif";
      ctx.fillText(
        "Green ≥ −67 dBm · Yellow −67 to −70 · Orange −70 to −80 · Red < −80 · × disconnected",
        80,
        h + 175,
      );
      ctx.fillText(
        scaled
          ? `Heat colors are estimates within ${radius} m of samples. Blank areas are unmeasured.`
          : "Heat colors are relative estimates. This plan is unscaled; no meter distances are implied.",
        80,
        h + 205,
      );
      if (survey.planNote) ctx.fillText(survey.planNote, 80, h + 235);
      c.toBlob((blob) => {
        if (blob) download(blob, "fieldnote-heatmap.png");
        else
          notify(
            "Image export failed. Export JSON to preserve this map.",
            true,
          );
      }, "image/png");
    } catch {
      notify("The map could not be exported. Try JSON or CSV instead.", true);
    }
    setExportOpen(false);
  }
  function exportFile(format: "json" | "csv") {
    download(
      new Blob(
        [
          format === "json"
            ? JSON.stringify(survey, null, 2)
            : exportCSV(survey),
        ],
        { type: format === "json" ? "application/json" : "text/csv" },
      ),
      `fieldnote-survey.${format}`,
    );
    setExportOpen(false);
  }
  function exportAllFloors() {
    download(
      new Blob([serializeLibrary(library)], { type: "application/json" }),
      "fieldnote-all-floors.json",
    );
    setExportOpen(false);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Fieldnote home">
          <span className="brand-symbol">
            <Radar size={25} />
          </span>
          <span>
            fieldnote<span className="brand-dot">.</span>
          </span>
          <span className="brand-divider" />
          <span className="brand-subtitle">WI-FI MAPPER</span>
        </a>
        <div className="topbar-right">
          <span className="local-badge">
            <span className="status-dot" />
            LOCAL & PRIVATE
          </span>
          <button
            className="icon-button help-button"
            onClick={() => setHelp(true)}
            aria-label="How to use Fieldnote"
          >
            <CircleHelp size={19} />
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              <span className="tiny-line" />A LITTLE FIELDWORK. BETTER WI-FI.
            </div>
            <h1>Your home, in signal.</h1>
            <p>Walk your space. Mark a spot. Find the gaps.</p>
          </div>
          <div className="heading-actions">
            <button
              className="button quiet"
              onClick={() => importInput.current?.click()}
              disabled={!!capture}
            >
              <ArrowUpFromLine size={16} />
              Open survey
            </button>
            <div className="dropdown">
              <button
                className="button primary"
                onClick={() => setExportOpen(!exportOpen)}
                aria-expanded={exportOpen}
              >
                <ArrowDownToLine size={16} />
                Export survey
                <ChevronDown size={14} />
              </button>
              {exportOpen && (
                <div className="dropdown-menu">
                  <button onClick={() => exportFile("json")}>
                    This floor <span>.json</span>
                  </button>
                  <button onClick={exportAllFloors}>
                    All floors backup <span>.json</span>
                  </button>
                  <button onClick={() => exportFile("csv")}>
                    Measurements <span>.csv</span>
                  </button>
                  <button onClick={exportMap}>
                    Heat map image <span>.png</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="workspace">
          <aside className="sidebar">
            <section className="signal-card" aria-label="Live Wi-Fi signal">
              <div className="card-eyebrow">
                <span>
                  <span className={`status-dot ${fresh ? "" : "offline"}`} />
                  {sensorLabel}
                </span>
                <Wifi size={17} />
              </div>
              <div className="signal-number">
                {rssi ?? "—"}
                <span>dBm</span>
              </div>
              <div className="signal-quality">
                <span
                  style={{ background: rssi === null ? "#86968b" : q.color }}
                />
                {rssi === null
                  ? fresh && reading?.status === "disconnected"
                    ? "Disconnected"
                    : "No current reading"
                  : q.label}
                <span className="quality-hint">
                  {rssi !== null ? "Closer to 0 is stronger" : ""}
                </span>
              </div>
              <Sparkline readings={history} />
              <div className="signal-chart-labels">
                <span>LAST 50 READINGS</span>
                <span>1× / SEC</span>
              </div>
              <div className="signal-separator" />
              <div className="network-name">
                <span className="network-icon">
                  <Radio size={17} />
                </span>
                <div>
                  <strong>
                    {fresh && reading?.status === "connected"
                      ? reading.ssid || "Connected Wi-Fi"
                      : "Local Wi-Fi sensor"}
                  </strong>
                  <small>
                    {fresh && reading?.status === "connected"
                      ? reading.ssid
                        ? "Your current network"
                        : "Network name hidden by macOS"
                      : sensorLabel}
                  </small>
                </div>
              </div>
              <div className="signal-details">
                <div>
                  <span>Noise</span>
                  <strong>
                    {fresh &&
                    reading?.noise !== null &&
                    reading?.noise !== undefined
                      ? `${reading.noise} dBm`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Signal / noise</span>
                  <strong>
                    {fresh &&
                    reading?.snr !== null &&
                    reading?.snr !== undefined
                      ? `${reading.snr} dB`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Band / channel</span>
                  <strong>
                    {fresh && reading?.band
                      ? `${reading.band} / ${reading.channel ?? "—"}`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>
                    Link rate{" "}
                    <span title="Radio transmit rate reported by macOS, not internet download speed">
                      ⓘ
                    </span>
                  </span>
                  <strong>
                    {fresh && reading?.txRate
                      ? `${Math.round(reading.txRate)} Mbps`
                      : "—"}
                  </strong>
                </div>
              </div>
              <div className="source-note">
                <ShieldCheck size={13} />
                Real radio data · Apple CoreWLAN
              </div>
            </section>

            <section className="summary-card">
              <div className="section-kicker">
                THE SURVEY SO FAR <Route size={16} />
              </div>
              <div className="stat-grid">
                <div>
                  <strong>
                    {String(measurements.length).padStart(2, "0")}
                  </strong>
                  <span>spots measured</span>
                </div>
                <div>
                  <strong className={weak.length ? "warning-text" : ""}>
                    {String(weak.length).padStart(2, "0")}
                  </strong>
                  <span>weak / offline</span>
                </div>
              </div>
              <div className="average-row">
                <span>Average at measured spots</span>
                <strong>{average === null ? "—" : `${average} dBm`}</strong>
              </div>
              {measurements.length > 0 && (
                <div
                  className="coverage-strip"
                  aria-label={`${measurements.length - weak.length} of ${measurements.length} measured spots have fair or better signal`}
                >
                  <span
                    style={{
                      width: `${((measurements.length - weak.length) / measurements.length) * 100}%`,
                    }}
                  />
                </div>
              )}
            </section>

            <section className="walkthrough">
              <span className="walkthrough-icon">
                <MousePointer2 size={19} />
              </span>
              <h3>A walk, not a speed test.</h3>
              <p>
                Stand in a spot, click it on your map, and hold still for 4
                readings. Repeat in every room.
              </p>
              <button onClick={() => setHelp(true)}>
                A few good field tips <span>↗</span>
              </button>
            </section>
            <div className={`save-status ${saved ? "" : "save-error"}`}>
              <span>
                {saved ? <Check size={13} /> : <Activity size={13} />}
              </span>
              {saved
                ? "Saved in this browser"
                : "Storage full — export a backup"}
              <span className="save-dot">·</span>No cloud
            </div>
          </aside>

          <div className="map-column">
            <section className="map-panel">
              <nav className="floor-tabs" aria-label="Floor surveys">
                {library.surveys.map((floor) => (
                  <button
                    key={floor.id}
                    aria-pressed={floor.id === survey.id}
                    className={
                      floor.id === survey.id ? "floor-tab active" : "floor-tab"
                    }
                    disabled={!!capture || imageBusy}
                    onClick={() => switchFloor(floor.id)}
                  >
                    <Layers2 size={14} />
                    <span>{floor.name}</span>
                    <small>{floor.measurements.length}</small>
                  </button>
                ))}
              </nav>
              <div className="map-heading">
                <div className="map-name">
                  <span className="house-icon">
                    <House size={19} />
                  </span>
                  <div>
                    <input
                      aria-label="Survey name"
                      value={survey.name}
                      maxLength={80}
                      disabled={!!capture}
                      onChange={(e) =>
                        change((old) => ({ ...old, name: e.target.value }))
                      }
                    />
                    <span>
                      {scaled
                        ? `${survey.width} × ${survey.height} m`
                        : "SCALE NOT SET"}{" "}
                      <span> / </span>
                      {survey.floorplan
                        ? "YOUR FLOOR PLAN"
                        : "FREEFORM FLOOR PLAN"}
                    </span>
                  </div>
                </div>
                <div className="map-header-actions">
                  <button
                    className="icon-button"
                    title="Start a new survey"
                    aria-label="Start a new survey"
                    disabled={!!capture}
                    onClick={() => setNewSurveyOpen(true)}
                  >
                    <Plus size={18} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Map settings"
                    title="Map settings"
                    disabled={!!capture}
                    onClick={() => setSettings(true)}
                  >
                    <Settings2 size={18} />
                  </button>
                </div>
              </div>
              {survey.planNote && (
                <div className="plan-note">
                  <CircleHelp size={14} />
                  <span>{survey.planNote}</span>
                  {!scaled && (
                    <button
                      onClick={() => setSettings(true)}
                      disabled={!!capture}
                    >
                      Set dimensions
                    </button>
                  )}
                </div>
              )}
              <div className="map-toolbar">
                <div className="tools" role="group" aria-label="Map tools">
                  {(
                    [
                      { id: "measure", label: "Measure", icon: Crosshair },
                      { id: "walls", label: "Draw walls", icon: Ruler },
                      { id: "router", label: "Router", icon: Radio },
                    ] as const
                  ).map((tool) => (
                    <button
                      key={tool.id}
                      className={mode === tool.id ? "tool active" : "tool"}
                      aria-pressed={mode === tool.id}
                      disabled={!!capture}
                      onClick={() => {
                        setMode(tool.id);
                        setWallStart(null);
                      }}
                    >
                      <tool.icon size={15} />
                      <span>{tool.label}</span>
                    </button>
                  ))}
                </div>
                <div className="map-toolbar-end">
                  <button
                    className="icon-button"
                    aria-label="Undo last point or wall"
                    title="Undo last point or wall"
                    onClick={undo}
                    disabled={
                      !capture &&
                      !wallStart &&
                      !(mode === "walls"
                        ? survey.walls.length
                        : measurements.length)
                    }
                  >
                    <Undo2 size={16} />
                  </button>
                  <span className="toolbar-divider" />
                  <button
                    className={`heat-toggle ${heatmap ? "on" : ""}`}
                    onClick={() => setHeatmap(!heatmap)}
                    aria-label="Heat map"
                    aria-pressed={heatmap}
                  >
                    <Layers2 size={15} />
                    <span>Heat map</span>
                    <span className="switch" />
                  </button>
                </div>
              </div>

              <div
                className={`map-stage ${mode === "walls" ? "drawing" : ""} ${capture ? "capturing" : ""}`}
              >
                <div
                  className="map-surface"
                  style={{
                    aspectRatio: String(mapAspect),
                    width: `min(100%, calc(clamp(240px, 52vh, 560px) * ${mapAspect}))`,
                  }}
                >
                  {survey.floorplan && (
                    <svg
                      className="floorplan-background"
                      viewBox={`0 0 1000 ${mapHeight}`}
                      aria-hidden="true"
                    >
                      {survey.floorplanView ? (
                        <svg
                          viewBox={`${survey.floorplanView.x} ${survey.floorplanView.y} ${survey.floorplanView.width} ${survey.floorplanView.height}`}
                          width="1000"
                          height={mapHeight}
                          preserveAspectRatio="xMidYMid meet"
                        >
                          <image
                            href={survey.floorplan}
                            width={survey.floorplanView.sourceWidth}
                            height={survey.floorplanView.sourceHeight}
                          />
                        </svg>
                      ) : (
                        <image
                          href={survey.floorplan}
                          width="1000"
                          height={mapHeight}
                          preserveAspectRatio="xMidYMid meet"
                        />
                      )}
                    </svg>
                  )}
                  <canvas
                    className="heatmap-canvas"
                    ref={heatRef}
                    style={{ opacity: heatmap ? 1 : 0 }}
                    aria-hidden="true"
                  />
                  <svg
                    ref={mapRef}
                    className="survey-map"
                    viewBox={`0 0 1000 ${mapHeight}`}
                    role="img"
                    aria-label="Interactive floor plan. Click your position to measure signal, or use the keyboard measure button below."
                    onPointerMove={(e) => setPointer(location(e))}
                    onPointerLeave={() => setPointer(null)}
                    onClick={(e) => handleMap(location(e))}
                  >
                    <defs>
                      <pattern
                        id="map-grid"
                        width={1000 / survey.width}
                        height={mapHeight / survey.height}
                        patternUnits="userSpaceOnUse"
                      >
                        <path
                          d={`M ${1000 / survey.width} 0 L 0 0 0 ${mapHeight / survey.height}`}
                          fill="none"
                          stroke="#c5cbbe"
                          strokeWidth=".8"
                          opacity=".48"
                        />
                      </pattern>
                      <pattern
                        id="map-dots"
                        width="18"
                        height="18"
                        patternUnits="userSpaceOnUse"
                      >
                        <circle
                          cx="9"
                          cy="9"
                          r=".75"
                          fill="#b7c0b0"
                          opacity=".5"
                        />
                      </pattern>
                    </defs>
                    {!survey.floorplan && (
                      <rect
                        width="1000"
                        height={mapHeight}
                        fill="url(#map-dots)"
                      />
                    )}
                    {!survey.floorplan && (
                      <rect
                        width="1000"
                        height={mapHeight}
                        fill="url(#map-grid)"
                      />
                    )}
                    {survey.walls.map((w) => (
                      <g key={w.id}>
                        <line
                          x1={w.a.x * 1000}
                          y1={w.a.y * mapHeight}
                          x2={w.b.x * 1000}
                          y2={w.b.y * mapHeight}
                          stroke="#fffdf7"
                          strokeWidth="10"
                        />
                        <line
                          x1={w.a.x * 1000}
                          y1={w.a.y * mapHeight}
                          x2={w.b.x * 1000}
                          y2={w.b.y * mapHeight}
                          stroke="#69756a"
                          strokeWidth="5"
                          strokeLinecap="square"
                        />
                      </g>
                    ))}
                    {wallStart && pointer && (
                      <line
                        x1={wallStart.x * 1000}
                        y1={wallStart.y * mapHeight}
                        x2={pointer.x * 1000}
                        y2={pointer.y * mapHeight}
                        stroke="#44715b"
                        strokeWidth="4"
                        strokeDasharray="8 5"
                      />
                    )}
                    {survey.router && (
                      <g
                        transform={`translate(${survey.router.x * 1000},${survey.router.y * mapHeight}) scale(${mapScale})`}
                      >
                        <circle
                          r="20"
                          fill="#264d40"
                          stroke="#fffef9"
                          strokeWidth="3"
                        />
                        <Wifi x="-11" y="-11" size={22} color="#f5f2d9" />
                        <text
                          y="36"
                          textAnchor="middle"
                          fill="#334c3a"
                          fontSize="14"
                          fontWeight="600"
                        >
                          Router
                        </text>
                      </g>
                    )}
                    {measurements.map((m, i) => (
                      <g
                        key={m.id}
                        className="measurement-marker"
                        transform={`translate(${m.x * 1000},${m.y * mapHeight}) scale(${mapScale})`}
                        onClick={(e) => {
                          if (mode === "measure" && !capture) {
                            e.stopPropagation();
                            setSelected(m.id);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`${m.label}, ${m.rssi === null ? "disconnected" : `${m.rssi} dBm`}`}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelected(m.id);
                          }
                        }}
                      >
                        <circle
                          r={selected === m.id ? 25 : 21}
                          fill="white"
                          opacity={selected === m.id ? 1 : 0.8}
                        />
                        <circle r="17" fill={quality(m.rssi).color} />
                        <text
                          y="4.5"
                          textAnchor="middle"
                          fill="white"
                          fontSize="12"
                          fontWeight="700"
                        >
                          {m.rssi ?? "×"}
                        </text>
                        <text
                          y="35"
                          textAnchor="middle"
                          fill="#465444"
                          fontSize="12"
                          className="point-label"
                        >
                          {m.label === `Point ${i + 1}`
                            ? String(i + 1).padStart(2, "0")
                            : m.label.slice(0, 24)}
                        </text>
                      </g>
                    ))}
                    {capture && (
                      <g
                        transform={`translate(${capture.position.x * 1000},${capture.position.y * mapHeight}) scale(${mapScale})`}
                      >
                        <circle
                          className="capture-pulse"
                          r="28"
                          fill="#2f6b52"
                          opacity=".17"
                        />
                        <circle
                          r="15"
                          fill="#fafbf1"
                          stroke="#2f6b52"
                          strokeWidth="2"
                        />
                        <text
                          y="5"
                          textAnchor="middle"
                          fill="#2f6b52"
                          fontSize="14"
                          fontWeight="700"
                        >
                          {capture.readings.length}/4
                        </text>
                      </g>
                    )}
                  </svg>
                  {!measurements.length &&
                    !survey.walls.length &&
                    !survey.floorplan &&
                    !capture &&
                    mode === "measure" && (
                      <div className="map-empty">
                        <span className="empty-crosshair">
                          <ScanLine size={33} strokeWidth={1.1} />
                        </span>
                        <h2>Start where you are.</h2>
                        <p>
                          Click anywhere to place your first measurement.
                          <br />A picture of your floor plan helps, but isn’t
                          required.
                        </p>
                        <button
                          className="button floorplan-button"
                          disabled={imageBusy}
                          onClick={() => floorInput.current?.click()}
                        >
                          <ImagePlus size={16} />
                          {imageBusy
                            ? "Adding floor plan…"
                            : "Add a floor plan"}
                        </button>
                        <span className="empty-footnote">
                          PNG, JPG, or WebP · stays on this laptop
                        </span>
                      </div>
                    )}
                  {!survey.floorplan && (
                    <div className="map-scale">
                      <span
                        style={{ width: `${1000 / survey.width / mapScale}px` }}
                      />
                      {scaled ? "1 m grid" : "Relative grid"}
                    </div>
                  )}
                  <span className="map-coordinate">
                    {pointer
                      ? scaled
                        ? `${(pointer.x * survey.width).toFixed(1)} m, ${(pointer.y * survey.height).toFixed(1)} m`
                        : `${(pointer.x * 100).toFixed(0)}%, ${(pointer.y * 100).toFixed(0)}%`
                      : scaled
                        ? "DIMENSIONS SET"
                        : "UNSCALED PLAN"}
                  </span>
                </div>
              </div>
              <div className="map-status">
                <span>
                  <span className={`status-dot ${capture ? "pulsing" : ""}`} />
                  {mapStatus}
                </span>
                <button
                  onClick={() => setHelp(true)}
                  aria-label="About map positioning"
                >
                  <CircleHelp size={15} />
                  Manual positioning
                </button>
              </div>
              <div className="map-legend">
                <div className="legend-label">
                  SIGNAL STRENGTH <span>dBm</span>
                </div>
                <div className="legend-ramp">
                  <div />
                  <div className="legend-ticks">
                    <span>
                      −90 <small>Weak</small>
                    </span>
                    <span>−70</span>
                    <span>
                      −50 <small>Strong</small>
                    </span>
                  </div>
                </div>
                <span className="unmeasured-key">
                  <span />
                  Unmeasured
                </span>
              </div>
            </section>

            <div className="map-bottom-note">
              <span>
                <Activity size={14} />
                Colors between points are estimates, not extra readings.
              </span>
              <span>Measure every 2–3 m for a clearer picture.</span>
            </div>
            <section className="measurements-panel">
              <div className="measurements-heading">
                <h2>
                  <MapPin size={17} />
                  Field notes <span>{measurements.length}</span>
                </h2>
                <button
                  className="text-button"
                  disabled={!!capture}
                  onClick={() => setSettings(true)}
                >
                  Measure by coordinates ↗
                </button>
              </div>
              {activePoint ? (
                <div className="point-detail">
                  <span
                    className="point-reading"
                    style={{ color: quality(activePoint.rssi).color }}
                  >
                    {activePoint.rssi ?? "×"}
                    <small>
                      {activePoint.rssi === null ? "offline" : "dBm"}
                    </small>
                  </span>
                  <div className="point-detail-main">
                    <input
                      aria-label="Measurement label"
                      value={activePoint.label}
                      maxLength={80}
                      onChange={(e) =>
                        change((old) => ({
                          ...old,
                          measurements: old.measurements.map((m) =>
                            m.id === activePoint.id
                              ? { ...m, label: e.target.value }
                              : m,
                          ),
                        }))
                      }
                    />
                    <p>
                      {activePoint.count} samples ·{" "}
                      {activePoint.min !== null
                        ? `${activePoint.min} to ${activePoint.max} dBm · `
                        : ""}
                      {new Date(activePoint.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      ·{" "}
                      {scaled
                        ? `${(activePoint.x * survey.width).toFixed(1)}, ${(activePoint.y * survey.height).toFixed(1)} m`
                        : `${(activePoint.x * 100).toFixed(0)}%, ${(activePoint.y * 100).toFixed(0)}% of plan`}
                    </p>
                    <span>
                      {activePoint.band ?? "Band unknown"} ·{" "}
                      {activePoint.ssid ?? "Network identity hidden"}
                      {activePoint.bssid ? ` · ${activePoint.bssid}` : ""}
                    </span>
                  </div>
                  <button
                    className="icon-button delete-button"
                    aria-label="Delete selected measurement"
                    onClick={() => {
                      change((old) => ({
                        ...old,
                        measurements: old.measurements.filter(
                          (m) => m.id !== activePoint.id,
                        ),
                      }));
                      setSelected(null);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Close point details"
                    onClick={() => setSelected(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : measurements.length ? (
                <div className="point-list">
                  {measurements
                    .slice()
                    .reverse()
                    .slice(0, 12)
                    .map((m) => (
                      <button key={m.id} onClick={() => setSelected(m.id)}>
                        <span style={{ background: quality(m.rssi).color }} />
                        {m.label}
                        <strong>
                          {m.rssi === null ? "Offline" : `${m.rssi} dBm`}
                        </strong>
                      </button>
                    ))}
                  {measurements.length > 12 && (
                    <p>
                      Showing the latest 12 points. Select any point on the map
                      for details.
                    </p>
                  )}
                </div>
              ) : (
                <div className="notes-empty">
                  <span className="notes-icon">
                    <Route size={20} />
                  </span>
                  <p>
                    Your measurements will land here.
                    <span>
                      Give each spot a name, like “upstairs desk” or “kitchen
                      corner.”
                    </span>
                  </p>
                  <span className="notes-dash">—</span>
                </div>
              )}
            </section>
          </div>
        </div>
        <footer>
          <span>
            FIELDNOTE <span>/</span> MADE FOR THE WALK AROUND.
          </span>
          <span>
            <ShieldCheck size={13} />
            Your floor plan and measurements stay in this browser.
          </span>
        </footer>
      </main>
      {!available && (
        <div className="sensor-notice">
          <WifiOff size={16} />
          <span>
            {!streamOpen
              ? "Connecting to the local sensor. If this persists, start the app with npm run dev."
              : reading?.message ||
                "Waiting for a fresh signal from your Wi-Fi radio."}
          </span>
        </div>
      )}
      {capture && (
        <div className="capture-banner" role="status">
          <span className="capture-spinner" />
          <div>
            <strong>Taking a real measurement</strong>
            <span>
              Stay at this spot · {capture.readings.length} of 4 readings
            </span>
          </div>
          <button onClick={stopCapture} aria-label="Cancel measurement">
            <X size={18} />
          </button>
        </div>
      )}
      {notice && (
        <div className={`toast ${notice.error ? "error" : ""}`} role="status">
          {notice.error ? <Activity size={17} /> : <Check size={17} />}
          <span>{notice.text}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
      <input
        ref={floorInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadFloor(file);
          e.target.value = "";
        }}
      />
      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        className="hidden-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void importSurvey(file);
          }
          e.target.value = "";
        }}
      />

      {help && (
        <Modal
          title="A good survey starts with a short walk."
          onClose={() => setHelp(false)}
        >
          <div className="help-steps">
            <div>
              <span>01</span>
              <section>
                <h3>Give yourself a map.</h3>
                <p>
                  Upload a floor plan, draw a few walls, or use the blank grid.
                  Set the real width and height in Map settings. You place your
                  position — your laptop does not track it indoors.
                </p>
              </section>
            </div>
            <div>
              <span>02</span>
              <section>
                <h3>Walk. Stop. Measure.</h3>
                <p>
                  Click where you’re standing and wait for 4 fresh readings. We
                  save the median signal, plus noise and the individual samples.
                  Try every room, both sides of doors, and your usual work
                  spots.
                </p>
              </section>
            </div>
            <div>
              <span>03</span>
              <section>
                <h3>Follow the weak spots.</h3>
                <p>
                  Below −70 dBm deserves a closer look; below −80 dBm is very
                  weak. These are rough guidelines, not a speed guarantee. A
                  lost connection gets its own × marker.
                </p>
              </section>
            </div>
          </div>
          <div className="help-callout">
            <Radio size={20} />
            <div>
              <strong>Can it find the walls automatically?</strong>
              <p>
                No. Normal Mac Wi-Fi readings give signal strength, not reliable
                distances, wall geometry, or your indoor location. The colors
                are an interpolation around your measured points; drawn walls do
                not simulate radio propagation.
              </p>
            </div>
          </div>
          <p className="help-footnote">
            Network names may be hidden by macOS Location Services. Real signal
            readings can still work. Link rate is the radio’s negotiated
            transmit rate, not your internet speed. Keep the lid angle and
            laptop orientation consistent while measuring.
          </p>
          <button
            className="button primary full-width"
            onClick={() => setHelp(false)}
          >
            Let’s map it <Crosshair size={16} />
          </button>
        </Modal>
      )}
      {settings && (
        <Modal
          title="Make the map your own."
          onClose={() => setSettings(false)}
        >
          <MapSettings
            survey={survey}
            onChange={change}
            radius={radius}
            setRadius={setRadius}
            onUpload={() => floorInput.current?.click()}
            onMeasure={(p) => {
              setSettings(false);
              setMode("measure");
              handleMap(p, true);
            }}
            canMeasure={available && !capture && !imageBusy}
          />
        </Modal>
      )}
      {newSurveyOpen && (
        <Modal
          title="Add a floor or a fresh survey."
          onClose={() => setNewSurveyOpen(false)}
        >
          <p className="modal-copy">
            Your existing floors stay saved. Reuse this layout to compare a new
            router setup, or add a blank map for another space.
          </p>
          <button className="button quiet full-width" onClick={exportAllFloors}>
            <Download size={16} />
            Download all floors
          </button>
          <button
            className="button primary full-width space-top"
            disabled={library.surveys.length >= 40 || imageBusy}
            onClick={() => {
              const next = {
                ...survey,
                id: crypto.randomUUID(),
                templateId: undefined,
                name: `${survey.name} · new survey`.slice(0, 80),
                measurements: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              setLibrary((old) => addSurvey(old, next));
              setDirty(true);
              setSelected(null);
              setWallStart(null);
              setNewSurveyOpen(false);
              setMode("measure");
            }}
          >
            Reuse this floor plan <Layers2 size={16} />
          </button>
          {revisedPlanId && (
            <>
              <button
                className="button quiet full-width space-top"
                disabled={library.surveys.length >= 40 || imageBusy}
                onClick={() => void useRevisedPlan()}
              >
                Use revised floor plan <ImagePlus size={16} />
              </button>
              <p className="modal-copy">
                Start a separate survey on the newer furnished drawing. Your
                recorded points stay on their original plan.
              </p>
            </>
          )}
          <button
            className="button quiet full-width space-top"
            disabled={library.surveys.length >= 40 || imageBusy}
            onClick={() => {
              setLibrary((old) => addSurvey(old, createSurvey()));
              setDirty(true);
              setSelected(null);
              setWallStart(null);
              setNewSurveyOpen(false);
              setMode("measure");
              notify("New survey ready.");
            }}
          >
            Start empty survey <Plus size={16} />
          </button>
        </Modal>
      )}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="modal"
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-top">
        <span className="eyebrow">FIELD GUIDE</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

function MapSettings({
  survey,
  onChange,
  radius,
  setRadius,
  onUpload,
  onMeasure,
  canMeasure,
}: {
  survey: Survey;
  onChange: (fn: (old: Survey) => Survey) => void;
  radius: number;
  setRadius: (n: number) => void;
  onUpload: () => void;
  onMeasure: (p: Point) => void;
  canMeasure: boolean;
}) {
  const scaled = survey.scaleConfirmed !== false;
  const xLimit = scaled ? survey.width : 100,
    yLimit = scaled ? survey.height : 100;
  const [width, setWidth] = useState(scaled ? String(survey.width) : ""),
    [height, setHeight] = useState(scaled ? String(survey.height) : "");
  const [x, setX] = useState("0"),
    [y, setY] = useState("0");
  const [error, setError] = useState("");
  return (
    <>
      <p className="modal-copy">
        {scaled
          ? "Set the outside dimensions of your plan. The grid and interpolation distance use these measurements."
          : "Your plan is not to scale. You can measure signal now using relative positions, or enter the actual outside dimensions below. Room-size labels in the drawing do not establish an accurate scale."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const w = Number(width),
            h = Number(height);
          if (
            !Number.isFinite(w) ||
            !Number.isFinite(h) ||
            w < 2 ||
            h < 2 ||
            w > 100 ||
            h > 100
          ) {
            setError("Use dimensions between 2 and 100 meters.");
            return;
          }
          onChange((old) => ({
            ...old,
            width: w,
            height: h,
            scaleConfirmed: true,
          }));
          setError("Dimensions saved.");
        }}
      >
        <div className="field-row">
          <label>
            Width <span>meters</span>
            <input
              type="number"
              min="2"
              max="100"
              step=".1"
              placeholder="Actual width"
              required
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
          </label>
          <label>
            Height <span>meters</span>
            <input
              type="number"
              min="2"
              max="100"
              step=".1"
              placeholder="Actual height"
              required
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
          </label>
        </div>
        <button className="button quiet full-width" type="submit">
          <Check size={15} />
          Apply dimensions
        </button>
        {error && (
          <p className="form-message" role="status">
            {error}
          </p>
        )}
      </form>
      <div className="settings-section">
        <h3>Floor plan</h3>
        <button className="button quiet full-width" onClick={onUpload}>
          <ImagePlus size={16} />
          {survey.floorplan ? "Replace floor plan" : "Upload a floor plan"}
        </button>
        {survey.floorplan && (
          <button
            className="text-button remove-link"
            onClick={() =>
              onChange((old) => ({
                ...old,
                floorplan: null,
                floorplanView: undefined,
                planNote: undefined,
              }))
            }
          >
            Remove background image
          </button>
        )}
        <p>
          Use a plan cropped to the building. Existing points stay at the same
          relative positions when dimensions change.
        </p>
      </div>
      <div className="settings-section">
        <label className="range-label">
          Estimate within{" "}
          <strong>
            {scaled
              ? `${radius} meters`
              : `${Math.round((radius / survey.width) * 100)}% of plan width`}
          </strong>
          <input
            type="range"
            min="1"
            max="8"
            step=".5"
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
          />
        </label>
        <p>
          {scaled
            ? "Beyond this distance from a measurement, the map stays blank."
            : "This is a relative blend area, not a physical distance. Set actual dimensions to use meters."}{" "}
          Walls are annotations; they don’t change the estimate.
        </p>
      </div>
      <div className="settings-section">
        <h3>Measure by coordinates</h3>
        <p>
          Accessible alternative to clicking the map. Measured from the top-left
          corner.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const px = Number(x),
              py = Number(y);
            if (
              Number.isFinite(px) &&
              Number.isFinite(py) &&
              px >= 0 &&
              px <= xLimit &&
              py >= 0 &&
              py <= yLimit
            )
              onMeasure({ x: px / xLimit, y: py / yLimit });
          }}
        >
          <div className="field-row">
            <label>
              X <span>{scaled ? "meters" : "percent"}</span>
              <input
                type="number"
                min="0"
                max={xLimit}
                step=".1"
                value={x}
                onChange={(e) => setX(e.target.value)}
              />
            </label>
            <label>
              Y <span>{scaled ? "meters" : "percent"}</span>
              <input
                type="number"
                min="0"
                max={yLimit}
                step=".1"
                value={y}
                onChange={(e) => setY(e.target.value)}
              />
            </label>
          </div>
          <button
            className="button primary full-width"
            type="submit"
            disabled={!canMeasure}
          >
            <Crosshair size={16} />
            Measure here
          </button>
        </form>
      </div>
    </>
  );
}
