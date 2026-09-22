import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onRequestPost } from "../functions/api/jev.mjs";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const requireStore = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point at the pinned provider store path`);
  return value;
};

// Exact provider Nix outputs, handed in by the flake app. Nothing is vendored
// and nothing is copied: the store paths are served in place.
const stores = {
  uiIr: requireStore("VOICE_UI_UI_IR"),
  a2ui: requireStore("VOICE_UI_A2UI"),
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

  const rest = suffix => pathname.slice(suffix.length);

  if (pathname.startsWith("/app/src/")) {
    return resolveUnder(path.join(packageRoot, "src"), rest("/app/src/"));
  }
  if (pathname === "/ui/ui-ir/index.mjs") {
    return path.join(stores.uiIr, "packages/ui-ir/src/index.mjs");
  }
  if (pathname.startsWith("/ui/a2ui-browser/")) {
    return resolveUnder(
      path.join(stores.a2ui, "packages/a2ui-browser/src"),
      rest("/ui/a2ui-browser/"),
    );
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

async function serveJev(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const proxied = new Request("http://localhost/api/jev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.concat(chunks),
  });

  // The Pages Function is invoked directly. No second adapter, no re-implemented
  // provider call, and the key is read from the injected process env only.
  const result = await onRequestPost({
    request: proxied,
    env: { JEV_API_KEY: process.env.JEV_API_KEY },
  });

  const body = Buffer.from(await result.arrayBuffer());
  response.writeHead(result.status, {
    "content-type": result.headers.get("content-type") ?? "application/json",
    "content-length": body.byteLength,
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");

  if (pathname === "/api/jev") {
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("method not allowed");
      return;
    }
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
server.listen(port, "127.0.0.1", () => {
  // Provider identity is part of the evidence, so it is printed, never the key.
  process.stdout.write(`voice-ui dev: http://127.0.0.1:${port}/\n`);
  for (const [name, value] of Object.entries(stores)) {
    process.stdout.write(`voice-ui dev: ${name}=${value}\n`);
  }
  process.stdout.write(
    `voice-ui dev: JEV_API_KEY ${process.env.JEV_API_KEY ? "bound" : "absent"}\n`,
  );
});
