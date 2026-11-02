import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function fingerprint(directory) {
  const manifest = await readFile(path.join(directory, "package.json"), "utf8");
  const lock = await readFile(path.join(directory, "package-lock.json"), "utf8")
    .catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  const hash = createHash("sha256")
    .update(JSON.stringify([manifest, lock, process.platform, process.arch,
      process.versions.node.split(".")[0]]))
    .digest("hex");
  return { hash, lock };
}

function run(directory, command, args, quiet = false, timeout = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      stdio: quiet ? "ignore" : "inherit",
      timeout,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === 0));
  });
}

const npm = (directory, args, quiet = false) => run(directory, "npm", args, quiet);

async function healthy(directory) {
  // npm ls is local/offline and catches incomplete transitive dependency trees.
  const bins = ["tsc", "vite"].map((name) =>
    access(path.join(directory, "node_modules", ".bin", name), constants.X_OK),
  );
  if (!(await Promise.allSettled(bins)).every((result) => result.status === "fulfilled"))
    return false;
  if (!await npm(directory, ["ls", "--all", "--include=dev", "--offline"], true))
    return false;
  // npm ls tolerates missing optional packages, but the current platform's
  // Vite/Rolldown and TypeScript bindings are required to build this app.
  // Load/execute the actual installed tools without starting a server or build.
  const smoke = await Promise.all([
    run(directory, process.execPath, ["--input-type=module", "-e", "await import('vite')"], true, 15_000),
    run(directory, process.execPath, [path.join(directory, "node_modules", ".bin", "tsc"), "--version"], true, 15_000),
  ]);
  return smoke.every(Boolean);
}

async function installedLockMatches(directory, lockText) {
  // Adopt a healthy installation made before this helper existed, without
  // downloading again. Platform-specific optional packages may be absent.
  try {
    const expected = JSON.parse(lockText).packages;
    const installed = JSON.parse(await readFile(
      path.join(directory, "node_modules", ".package-lock.json"), "utf8",
    )).packages;
    const entries = Object.entries(installed);
    return entries.length > 0 && entries.every(([name, entry]) =>
      expected[name] && ["version", "resolved", "integrity"].every(
        (key) => expected[name][key] === entry[key],
      ),
    );
  } catch {
    return false;
  }
}

export async function ensureDependencies(directory = root) {
  const marker = path.join(directory, "node_modules", ".fieldnote-install");
  const current = await fingerprint(directory);
  const previous = await readFile(marker, "utf8").catch(() => null);
  const matches = previous === current.hash ||
    (previous === null && await installedLockMatches(directory, current.lock));
  if (matches && await healthy(directory)) {
    if (previous === null) await writeFile(marker, current.hash);
    return false;
  }

  // Never leave a success marker behind after an interrupted/failed attempt.
  await rm(marker, { force: true });
  console.log("Installing Fieldnote dependencies…");
  if (!await npm(directory, [current.lock ? "ci" : "install", "--include=dev", "--include=optional"]))
    throw new Error("Dependency installation failed. Check your internet connection and try again.");
  if (!await healthy(directory))
    throw new Error("Dependency installation is incomplete. Try launching Fieldnote again.");
  await writeFile(marker, (await fingerprint(directory)).hash);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureDependencies().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
