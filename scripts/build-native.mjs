import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
export const binaryPath = path.join(root, ".native", "wifi-probe");
export async function buildNative() {
  if (process.platform !== "darwin") return null;
  const source = path.join(root, "native", "WiFiProbe.swift");
  const [sourceInfo, binaryInfo] = await Promise.all([
    stat(source),
    stat(binaryPath).catch(() => null),
  ]);
  if (binaryInfo && binaryInfo.mtimeMs >= sourceInfo.mtimeMs) return binaryPath;
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/xcrun",
      ["swiftc", "-O", "-framework", "CoreWLAN", source, "-o", binaryPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let details = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("The Swift build timed out."));
    }, 120_000);
    child.stderr.on("data", (chunk) => {
      details = (details + chunk).slice(-6000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Unable to build the native Wi-Fi helper. Install Apple Command Line Tools with xcode-select --install. ${details}`,
          ),
        );
    });
  });
  return binaryPath;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await buildNative();
    console.log(
      result
        ? "Native Wi-Fi helper ready."
        : "Native Wi-Fi measurement requires macOS.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
