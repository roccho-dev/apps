import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../functions/pages-worker.mjs";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const requireStore = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point at the pinned provider store path`);
  return value;
};

// Exact provider Nix outputs, handed in by the flake app. Nothing is vendored
// and nothing is copied: the store paths are served in place.
const stores = {
  semanticMap: requireStore("VOICE_UI_SEMANTIC_MAP"),
  hayamimi: requireStore("VOICE_UI_HAYAMIMI"),
};

const TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".md": "text/plain; charset=utf-8",
}));

// Resolve a URL path to a file under exactly one root, refusing traversal.
function resolveUnder(root, relative) {
  const resolved = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  return resolved.startsWith(prefix) ? resolved : null;
}

function route(pathname) {
  if (pathname === "/") return path.join(packageRoot, "web/index.html");

  if (pathname === "/app.mjs") return path.join(packageRoot, "web/app.mjs");

  if (pathname === "/data/bundle.v1.json") return path.join(packageRoot, "web/data/bundle.v1.json");

  const rest = suffix => pathname.slice(suffix.length);

  if (pathname.startsWith("/app/src/")) {
    return resolveUnder(path.join(packageRoot, "src"), rest("/app/src/"));
  }
  // semantic-map plus the sibling packages it imports (data-pin, core-port, ...).
  if (pathname.startsWith("/ui/")) {
    return resolveUnder(path.join(stores.semanticMap, "packages"), rest("/ui/"));
  }
  if (pathname.startsWith("/hayamimi/")) {
    return resolveUnder(stores.hayamimi, rest("/hayamimi/"));
  }
  return null;
}

// Hayamimi decodes audio in a worker and needs a cross-origin isolated page.
const ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

// Cloudflare's 25MB file limit forces the deployed site to publish the ASR
// model as chunks plus this manifest, and a service worker to reassemble them.
// A host that serves the model whole has no chunks to describe. Answering the
// probe with 204 states that capability, instead of reporting a transport
// error for an optional file the provider deliberately does not ship.
const CHUNK_MANIFEST = "/hayamimi/sherpa/data.parts.json";

async function serveFile(response, file) {
  let body;
  try {
    body = await fs.readFile(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES.get(path.extname(file)) ?? "application/octet-stream",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    ...ISOLATION_HEADERS,
  });
  response.end(body);
}

// Only this exact path, and only when the pinned provider genuinely does not
// ship it. A host that does publish a manifest serves it normally, and every
// other absent file still gets the ordinary 404.
async function serveChunkManifest(response, file) {
  try {
    await fs.access(file);
  } catch {
    response.writeHead(204, { "cache-control": "no-store", ...ISOLATION_HEADERS });
    response.end();
    return;
  }
  await serveFile(response, file);
}

// The production router itself answers /api/jev: every method, header and
// body goes to the Worker the artifact ships, so its routing, its 405 and its
// closed error set are what this server exercises. The key is read from the
// injected process env only. Static files never reach the Worker here, so its
// asset binding fails loudly if routing ever sends one there.
const workerEnv = {
  JEV_API_KEY: process.env.JEV_API_KEY,
  ASSETS: {
    fetch: async request => {
      throw new Error(`the dev server routes static files itself, not ${new URL(request.url).pathname}`);
    },
  },
};

async function serveJev(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = Object.entries(request.headers)
    .filter(([name]) => !["connection", "host", "keep-alive", "transfer-encoding", "content-length"].includes(name))
    .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => [name, item]));
  const forwarded = new Request(new URL(request.url, "http://localhost"), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(chunks),
  });

  const result = await worker.fetch(forwarded, workerEnv);

  const body = Buffer.from(await result.arrayBuffer());
  response.writeHead(result.status, {
    ...Object.fromEntries(result.headers),
    "content-length": body.byteLength,
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");

  if (pathname === "/api/jev") {
    serveJev(request, response).catch(() => {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "dev_server_error" }));
    });
    return;
  }

  const file = route(pathname);
  if (file === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const serve = pathname === CHUNK_MANIFEST ? serveChunkManifest : serveFile;
  serve(response, file).catch(() => {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("read failed");
  });
});

const port = Number(process.env.PORT ?? 8787);
// Loopback only, unless HOST is set explicitly. Inside a throwaway container
// HOST=0.0.0.0 lets the container's published port reach the server; which
// host addresses may reach that port is decided by the publish, not here.
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  // Provider identity is part of the evidence, so it is printed, never the key.
  const bound = server.address();
  process.stdout.write(`voice-ui dev: listening on ${bound.address}:${bound.port}\n`);
  for (const [name, value] of Object.entries(stores)) {
    process.stdout.write(`voice-ui dev: ${name}=${value}\n`);
  }
  process.stdout.write(
    `voice-ui dev: JEV_API_KEY ${process.env.JEV_API_KEY ? "bound" : "absent"}\n`,
  );
});
