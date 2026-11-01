# Fieldnote · Wi-Fi Mapper

A local survey app for finding weak Wi-Fi around your house. It reads **real signal strength from your Mac's Wi-Fi interface**, then turns measurements you place on a floor plan into an estimated coverage heat map. No demo readings or cloud service.

## Start on your Mac

You need macOS, **Node.js 22.18 or newer**, and the Xcode Command Line Tools. If Swift is missing, install the tools with `xcode-select --install`.

Double-click **Start Wi-Fi Mapper.command**. It installs missing dependencies, builds the app, starts the local measurement service, and opens <http://127.0.0.1:4318>. Keep its Terminal window open while surveying; press **Control-C** there to stop.

Or run:

```sh
npm install
npm run build
npm start
```

Then open <http://127.0.0.1:4318>. For development, use `npm run dev` instead of the build/start commands. A different port is supported with `PORT=4319 npm start`; use that port consistently because browser storage belongs to the exact address.

## Survey your house

1. Connect your laptop to the Wi-Fi you want to measure. Keep the app running as you walk; internet access is not required after installation.
2. Set your map dimensions, upload a floor-plan image, or sketch walls on the blank grid. The layout is supplied by you, not inferred from the radio.
3. Stand still at a location and click its position on the map in measurement mode. Stay there for the four fresh samples used to calculate that point's median signal.
4. Repeat in each room, near doorways, and at suspected dead spots. More points make the heat map more useful. Keep the laptop at roughly the same height and orientation for a fair comparison.
5. Review the colored measurements and heat map. Return to weak spots after moving your router or changing your setup and take another survey.

Surveys save automatically in this browser's local storage. Switch between floors using the tabs above the map; each floor has its own measurements, heat map, and router marker. Adding a survey keeps existing floors. Use **Reuse this floor plan** to compare another router setup without erasing an earlier survey.

If another tab saves a newer collection, this tab stops saving and keeps your pending changes available for export. Use **Export this tab** before **Load saved floors** to keep both versions. A current browser is required for coordinated saving, and leaving with unsaved changes triggers a browser warning.

Export **This floor** as JSON for one survey, **All floors backup** for the complete collection, **CSV** for measurement analysis, or **PNG** to share the current map. JSON backups include the floor-plan image and can be restored on another browser. Clearing browser data or switching browser profiles will remove or hide saved surveys; keep a backup before doing that. Exported files may include your Wi-Fi network name and access-point identifier when macOS makes them available.

All-floor backups can exceed 8 MB and still be restored. They remain subject to the survey format's limits on floors, images, and measurements. Large imports may exceed browser storage; keep the backup file until the app confirms it has saved the restored collection.

## Optional local floor plans

**Personal floor-plan images are not included in this repository.** A fresh clone starts with a blank map; upload your own image or sketch walls to begin. Local images, generated builds, QA screenshots, and survey backups in `.qa/` are excluded from Git.

When the optional local drawing is present, it is loaded as separate **First floor**, **Second floor**, and **Basement** maps, including the upstairs balcony. The app displays each floor through its own viewport without redrawing the rooms. New installations with that local drawing start with these three maps.

If you already surveyed the earlier two-floor drawing, those saved images, measurements, walls, router markers, and your selected floor stay unchanged. The missing basement map is added alongside them. **Use revised floor plan** is optional: it creates a separate empty survey using the updated artwork, so earlier readings remain attached to the layout on which you placed them.

The drawing identifies itself as an approximate reconstruction and **not to scale**. These maps therefore start with **Scale not set**. You can collect real signal readings immediately, with positions expressed as percentages of the plan. Enter actual outside dimensions in Map settings to enable meters. The drawing's approximation notice remains visible, and setting dimensions does not rearrange your points or change the artwork's proportions.

The unchanged original attachments are stored locally at `public/local-floorplans/home.png` and `public/local-floorplans/home-with-basement.png`, both excluded from Git. The revised maps share a compressed, full-resolution WebP copy in browser storage and all-floor backups. Existing saved images are retained, and the old single-survey storage key is kept during migration.

## What the numbers mean

| Reading         | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| RSSI, dBm       | The actual received Wi-Fi signal. Less negative is stronger: −50 is stronger than −75. |
| Noise, dBm      | The radio's reported background noise level.                                           |
| SNR, dB         | Signal minus noise; a larger gap is usually better.                                    |
| Link rate, Mbps | The negotiated radio transmit rate. **This is not an internet speed test.**            |
| Channel / band  | The currently connected access point's radio channel and band.                         |

The app labels signals at or above −55 dBm excellent, −67 good, −70 fair, and −80 weak; below −80 is a very weak/dead-spot indication. These are practical survey guides, not guarantees of connection quality. Interference, congestion, and your router or internet connection can affect performance even when RSSI is strong.

The heat map interpolates nearby measured points. Empty areas are unmeasured, and colored areas between points are **estimates**. The interpolation does not simulate wall materials, reflections, or signal propagation. Disconnected measurements are stored with no RSSI value, rather than an invented low signal number. If the sensor is unavailable, stale, or fails, the app reports that instead of fabricating readings.

## Can it automatically map the house?

It automatically colors the coverage map as you collect points. It cannot reliably discover your walls or track your indoor position using the ordinary Wi-Fi signal readings exposed by this laptop. A scalar RSSI reading does not identify where a signal reflected or where you are. That kind of reconstruction needs additional sensing, supported ranging hardware, or a separate mapping workflow. Use a floor-plan image or draw a rough layout, then place your measurement locations manually.

## Privacy and troubleshooting

- Measurements come from Apple's [CoreWLAN framework](https://developer.apple.com/documentation/corewlan). The Swift helper only reads the interface; it does not switch networks, scan nearby networks, or change Wi-Fi settings.
- The service listens only on `127.0.0.1`. Measurements and floor plans stay in the local browser unless you export/share them. The initial dependency installation uses the internet.
- macOS can withhold network names and BSSIDs without Location Services permission for the launching app. Real RSSI may still work with these names hidden. When identifiers are hidden, the app cannot reliably identify roaming between access points.
- If Wi-Fi is off or disconnected, reconnect using macOS's normal Wi-Fi controls. Ethernet connectivity alone does not produce Wi-Fi signal measurements.
- If the app says the sensor is unavailable, confirm `swift --version` works and run `npm run build` again. Real telemetry currently supports macOS only.
- If port 4318 is occupied by another application, stop that application or choose another `PORT`. The launcher will not open an unidentified service on that port.
- If the UI loses its local service connection, restart the launcher or `npm start`. Previously saved points remain in browser storage.

## Checks and implementation

```sh
npm run check
npm test
npm run build
```

The interface uses React, TypeScript, and Vite. A loopback-only Node service streams fresh readings from a persistent Swift CoreWLAN helper. The native binary is built into `.native/` and is not committed. The production web build goes into `dist/`.
