import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { Telemetry } from "./telemetry.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export function isLocalRequest(request, port) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!hosts.has(request.headers.host)) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) return false;
  // A hostile site's subresource requests do not always send Origin.
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  return true;
}

function json(response, code, value) {
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

export async function createServer({
  telemetry = new Telemetry(),
  dev = false,
  port = 4318,
} = {}) {
  const subscribers = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    const boundPort = server.address()?.port ?? port;
    if (!isLocalRequest(request, boundPort))
      return json(response, 403, {
        error: "Only same-origin local access is allowed.",
      });
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("Allow", "GET, HEAD");
      return json(response, 405, {
        error: "This measurement service is read-only.",
      });
    }
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
    } catch {
      return json(response, 400, { error: "Invalid URL." });
    }
    if (pathname === "/api/health") {
      return json(response, 200, {
        app: "fieldnote-wifi-mapper",
        ok: true,
        platform: process.platform,
        source: "corewlan",
        status: telemetry.current.status,
        timestamp: telemetry.current.timestamp,
      });
    }
    if (pathname === "/api/status")
      return json(response, 200, telemetry.current);
    if (pathname === "/api/stream") {
      if (request.method === "HEAD") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        return response.end();
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      response.write("retry: 2000\n\n");
      const send = (reading) => {
        if (
          !response.write(
            `event: reading\ndata: ${JSON.stringify(reading)}\n\n`,
          )
        )
          response.destroy();
      };
      send(telemetry.current);
      telemetry.on("reading", send);
      subscribers.add(response);
      const keepalive = setInterval(
        () => response.write(": keepalive\n\n"),
        15_000,
      );
      keepalive.unref();
      response.once("close", () => {
        clearInterval(keepalive);
        telemetry.off("reading", send);
        subscribers.delete(response);
      });
      return;
    }
    if (pathname.startsWith("/api/"))
      return json(response, 404, { error: "Unknown API endpoint." });
    if (vite) {
      vite.middlewares(request, response, () => {
        response.writeHead(404);
        response.end("Not found");
      });
      return;
    }
    try {
      let filename = path.resolve(dist, "." + pathname);
      if (!filename.startsWith(dist + path.sep) && filename !== dist)
        return json(response, 403, { error: "Invalid path." });
      if (
        pathname === "/" ||
        (!path.extname(pathname) &&
          request.headers.accept?.includes("text/html"))
      )
        filename = path.join(dist, "index.html");
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("Not a file");
      const contents =
        request.method === "HEAD" ? null : await readFile(filename);
      response.writeHead(200, {
        "Content-Type":
          mime[path.extname(filename)] ?? "application/octet-stream",
        "Content-Length": info.size,
      });
      response.end(contents);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("App files not found. Run npm run build, then npm start.");
    }
  });
  let vite = null;
  if (dev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      root,
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
  }
  return {
    server,
    telemetry,
    async close() {
      telemetry.stop();
      for (const response of subscribers) response.end();
      await vite?.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function main() {
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("PORT must be an integer between 1024 and 65535.");
  const app = await createServer({ dev: process.argv.includes("--dev"), port });
  try {
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await app.close().catch(() => {});
    if (error.code === "EADDRINUSE")
      throw new Error(
        `Port ${port} is already in use. Close the existing app or choose another PORT.`,
      );
    throw error;
  }
  console.log(`Wi-Fi Mapper is running at http://127.0.0.1:${port}`);
  console.log("Real measurements stay on this laptop. Press Ctrl+C to stop.");
  void app.telemetry.start();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
