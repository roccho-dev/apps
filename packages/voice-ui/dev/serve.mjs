import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
if (process.argv.length > 2 && !(process.argv.length === 3 && process.argv[2] === "--formal")) throw new Error("unsupported server mode");
// In the shipped e2e/serve.mjs, this own-location root is the PRODUCT.
// The target admits PRODUCT/ACCEPTANCE before its secret child; no path override.
const formalRoot = process.argv[2] === "--formal" ? packageRoot : null;

const requireStore = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point at the pinned provider store path`);
  return value;
};

// Producer compilation happens before the target secret is injected.
const { default: worker } = await import(formalRoot ? path.join(formalRoot, "worker/worker.mjs") : requireStore("VOICE_UI_WORKER"));

// Exact provider Nix outputs, handed in by the flake app. Nothing is vendored
// and nothing is copied: the store paths are served in place.
const stores = formalRoot ? {} : {
  semanticMap: requireStore("VOICE_UI_SEMANTIC_MAP"),
  hayamimi: requireStore("VOICE_UI_HAYAMIMI"),
  // This package's own source, prepared at build time from the exact commit
  // (or marked unavailable when there was none): a public manifest the
  // architecture page reads, and evidence only the Function below is given.
  architecture: requireStore("VOICE_UI_ARCHITECTURE"),
};
const architectureFiles = formalRoot
  ? { manifest: path.join(formalRoot, "site/architecture/data/source.v1.json"), evidence: path.join(formalRoot, "architecture/evidence.json") }
  : { manifest: path.join(stores.architecture, "manifest.json"), evidence: path.join(stores.architecture, "evidence.json") };
const architecture = Object.fromEntries(await Promise.all(Object.entries(architectureFiles)
  .map(async ([name, file]) => [name, JSON.parse(await fs.readFile(file, "utf8"))])));

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
  if (formalRoot) {
    return resolveUnder(path.join(formalRoot, "site"), ["/", "/architecture/"].includes(pathname) ? "index.html" : pathname.slice(1));
  }
  if (pathname === "/") return path.join(packageRoot, "web/index.html");

  if (pathname === "/app.mjs") return path.join(packageRoot, "web/app.mjs");

  if (pathname === "/data/config.v1.json") return path.join(packageRoot, "web/data/config.v1.json");

  if (pathname === "/data/bundle.v1.json") return path.join(packageRoot, "web/data/bundle.v1.json");

  // The architecture page: the same page and app under its own path, reading
  // its own config beside it and the prepared source's public manifest.
  if (pathname === "/architecture/") return path.join(packageRoot, "web/index.html");
  if (pathname === "/architecture/data/config.v1.json") return path.join(packageRoot, "dev/architecture-config.v1.json");
  if (pathname === "/architecture/data/source.v1.json") return path.join(stores.architecture, "manifest.json");

  const rest = suffix => pathname.slice(suffix.length);

  if (pathname.startsWith("/app/src/")) {
    return resolveUnder(path.join(packageRoot, "src"), rest("/app/src/"));
  }
  if (pathname.startsWith("/adapters/")) {
    return resolveUnder(path.join(packageRoot, "web/adapters"), rest("/adapters/"));
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

// The production router itself answers /api/judge: every method, header and
// body goes to the Worker the artifact ships, so its routing, its 405 and its
// closed error set are what this server exercises. The key is read from the
// injected process env only. Static files never reach the Worker here, so its
// asset binding fails loudly if routing ever sends one there.
const workerEnv = {
  JEV_API_KEY: process.env.JEV_API_KEY,
  ARCHITECTURE: architecture,
  ASSETS: {
    fetch: async request => {
      throw new Error(`the dev server routes static files itself, not ${new URL(request.url).pathname}`);
    },
  },
};

async function serveJudge(request, response) {
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

  // Without the slash the page would read the root's config; send it to its own.
  if (pathname === "/architecture") {
    response.writeHead(308, { location: "/architecture/", "cache-control": "no-store" });
    response.end();
    return;
  }

  if (pathname === "/api/proposals" && proposalSettings !== null) {
    serveProposals(request, response).catch(() => proposalReply(response, 502, { error: "PROPOSAL_FAILED" }));
    return;
  }
  if (pathname === "/api/judge") {
    serveJudge(request, response).catch(() => {
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
  const serve = !formalRoot && pathname === CHUNK_MANIFEST ? serveChunkManifest : serveFile;
  serve(response, file).catch(() => {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("read failed");
  });
});

// A formal PRODUCT ships the server but not its dev-only acquisition CLI.
// It therefore never configures, launches or serves this optional route.
const proposalSettings = !formalRoot && process.env.VOICE_UI_PROPOSAL_MODULE
  && process.env.VOICE_UI_PROPOSAL_JEV_URL && process.env.VOICE_UI_PROPOSAL_TEST_KEY
  ? (() => {
    let endpoint;
    try { endpoint = new URL(process.env.VOICE_UI_PROPOSAL_JEV_URL); }
    catch { throw new Error("invalid proposal endpoint"); }
    if (endpoint.protocol !== "http:"
      || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password
      || !path.isAbsolute(process.env.VOICE_UI_PROPOSAL_MODULE))
      throw new Error("proposal acquisition requires a trusted absolute proposer and loopback endpoint");
    const bin = requireStore("VOICE_UI_SEMCMP_BIN");
    if (!path.isAbsolute(bin)) throw new Error("installed semcmp entry must be absolute");
    const vars = {
      VOICE_UI_SEMCMP_BIN: bin,
      VOICE_UI_PROPOSAL_MODULE: process.env.VOICE_UI_PROPOSAL_MODULE,
      JEV_API_KEY: process.env.VOICE_UI_PROPOSAL_TEST_KEY,
      JEV_API_URL: endpoint.href,
      JEV_TIMEOUT_MS: "3000",
      VOICE_UI_PROPOSAL_TIMEOUT_MS: process.env.VOICE_UI_PROPOSAL_TIMEOUT_MS || "5000",
    };
    // Optional opaque operator-owned locator. The first slice does not read B.
    if (process.env.VOICE_UI_PROPOSAL_B) {
      if (process.env.VOICE_UI_PROPOSAL_B.length > 4096) throw new Error("proposal source locator too long");
      vars.VOICE_UI_PROPOSAL_B = process.env.VOICE_UI_PROPOSAL_B;
    }
    return {
      entry: fileURLToPath(new URL("./proposals.mjs", import.meta.url)),
      vars,
    };
  })() : null;

function proposalReply(response, status, body) {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function serveProposals(request, response) {
  if (request.method !== "POST") return proposalReply(response, 405, { error: "METHOD_NOT_ALLOWED" });
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    return proposalReply(response, 415, { error: "INVALID_CONTENT_TYPE" });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) return proposalReply(response, 413, { error: "INVALID_QUERY" });
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  const result = await new Promise(resolve => {
    let child;
    try {
      child = spawn(process.execPath, [proposalSettings.entry], {
        cwd: "/", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: proposalSettings.vars, // not ambient process.env / Worker credential
      });
    } catch { resolve(null); return; }
    let stdout = "", bytes = 0, expired = false, done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(clock);
      resolve(value);
    };
    const clock = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 17500);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 131072) child.kill("SIGKILL");
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", () => finish(null));
    child.on("close", code => finish(!expired && code === 0 ? stdout : null));
    child.stdin.end(input);
  });
  let value;
  try { value = JSON.parse(result); } catch { value = null; }
  if (!value || ![200, 400, 413, 502, 503, 504].includes(value.status)
    || !value.body || typeof value.body !== "object" || Array.isArray(value.body))
    return proposalReply(response, 502, { error: "PROPOSAL_FAILED" });
  return proposalReply(response, value.status, value.body);
}
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
