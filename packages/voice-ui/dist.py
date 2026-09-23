#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

CHUNK_SIZE = 20 * 1024 * 1024
PAGE_FILE_LIMIT = 25 * 1024 * 1024
IMPORT_RE = re.compile(r'''(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']''')
SECRET_MARKERS = (
    b"AGE-SECRET-KEY-",
    b"-----BEGIN PRIVATE KEY-----",
    b"CLOUDFLARE_API_TOKEN",
    b"CLOUDFLARE_ACCOUNT_ID",
)

SERVICE_WORKER = r'''const target="/hayamimi/sherpa/sherpa-onnx-wasm-main-vad-asr.data";
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=="GET"||url.origin!==self.location.origin||url.pathname!==target)return;
  event.respondWith((async()=>{
    const metaResponse=await fetch("/hayamimi/sherpa/data.parts.json",{cache:"no-store"});
    if(!metaResponse.ok)return new Response("model manifest unavailable",{status:502});
    const meta=await metaResponse.json();
    const stream=new ReadableStream({async start(controller){
      try{
        for(const part of meta.parts){
          const response=await fetch("/hayamimi/sherpa/"+part.path);
          if(!response.ok)throw new Error("model chunk unavailable");
          const reader=response.body.getReader();
          while(true){
            const value=await reader.read();
            if(value.done)break;
            controller.enqueue(value.value);
          }
        }
        controller.close();
      }catch(error){controller.error(error);}
    }});
    return new Response(stream,{headers:{
      "content-type":"application/octet-stream",
      "content-length":String(meta.bytes),
      "cache-control":"public, max-age=31536000, immutable"
    }});
  })());
});
'''

def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def copy_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.is_file() and sha256(source) == sha256(target):
            return
        raise SystemExit(f"artifact collision: {target}")
    shutil.copy2(source, target)

def copy_tree(source, target):
    source = Path(source)
    if not source.is_dir():
        raise SystemExit(f"provider artifact missing: {source}")
    for item in sorted(source.rglob("*")):
        if item.is_file():
            copy_file(item, target / item.relative_to(source))

def split_model(site):
    data = site / "hayamimi/sherpa/sherpa-onnx-wasm-main-vad-asr.data"
    if not data.is_file():
        raise SystemExit(f"ASR model missing: {data}")
    raw = data.read_bytes()
    parts = []
    for index, start in enumerate(range(0, len(raw), CHUNK_SIZE)):
        chunk = raw[start:start + CHUNK_SIZE]
        name = f"data.part{index:03d}"
        target = data.parent / name
        target.write_bytes(chunk)
        parts.append({
            "path": name,
            "bytes": len(chunk),
            "sha256": hashlib.sha256(chunk).hexdigest(),
        })
    (data.parent / "data.parts.json").write_text(
        json.dumps({"bytes": len(raw), "parts": parts}, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    data.unlink()
    (site / "sw.js").write_text(SERVICE_WORKER, encoding="utf-8")

def build(args):
    app = Path(args.app)
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    site = out / "site"

    copy_file(app / "web/index.html", site / "index.html")
    copy_tree(app / "src", site / "app/src")
    copy_tree(app / "functions", out / "functions")

    copy_tree(Path(args.ui_ir) / "packages/ui-ir/src", site / "ui/ui-ir")
    copy_tree(Path(args.a2ui) / "packages/a2ui-browser/src", site / "ui/a2ui-browser")
    copy_tree(Path(args.a2ui) / "packages/core-port/src", site / "core-port/src")
    copy_tree(Path(args.semantic_map) / "packages", site / "ui")

    hayamimi = Path(args.hayamimi)
    copy_tree(hayamimi / "runtime", site / "hayamimi/runtime")
    copy_tree(hayamimi / "sherpa", site / "hayamimi/sherpa")
    copy_file(hayamimi / "THIRD_PARTY_NOTICES.md", site / "hayamimi/THIRD_PARTY_NOTICES.md")

    copy_file(app / "artifact.jsonl", out / ".envs/artifact.jsonl")
    copy_file(app / "tests/local-voice-graph-e2e.mjs", out / "e2e/local-voice-graph-e2e.mjs")
    copy_file(app / "tests/public-e2e.mjs", out / "e2e/public-e2e.mjs")
    copy_file(app / "tests/fixtures/voice-add-edge-en.wav", out / "e2e/fixtures/voice-add-edge-en.wav")
    copy_file(app / "tests/fixtures/voice-add-edge-en.golden.json", out / "e2e/fixtures/voice-add-edge-en.golden.json")

    split_model(site)

    manifest = {
        "schema": "voice-ui-dist/1",
        "sources": {
            "apps": args.app_rev,
            "ui": args.ui_rev,
            "ops": args.ops_rev,
            "system": args.system,
        },
        "auth": ".envs/artifact.jsonl",
        "e2e": {
            "entrypoint": "e2e/local-voice-graph-e2e.mjs",
            "wav": "e2e/fixtures/voice-add-edge-en.wav",
            "golden": "e2e/fixtures/voice-add-edge-en.golden.json",
        },
    }
    write_manifest(out, manifest)
    verify_dist(out)

def write_manifest(root, manifest):
    rows = []
    for path in sorted(p for p in root.rglob("*") if p.is_file() and p.name != "manifest.json"):
        rows.append({
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })
    manifest["files"] = rows
    (root / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

def resolve_import(source, spec, site):
    clean = spec.split("?", 1)[0].split("#", 1)[0]
    if clean.startswith(("http://", "https://", "data:", "node:")):
        return None
    if clean.startswith("/"):
        return site / clean.lstrip("/")
    if clean.startswith("."):
        return (source.parent / clean).resolve()
    return None

def check_imports(site):
    root = site.resolve()
    for source in sorted(p for p in site.rglob("*") if p.suffix in {".js", ".mjs", ".html"}):
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for spec in IMPORT_RE.findall(text):
            target = resolve_import(source.resolve(), spec, root)
            if target is None:
                continue
            try:
                target.relative_to(root)
            except ValueError:
                raise SystemExit(f"import escapes site: {source}: {spec}")
            if not target.is_file():
                raise SystemExit(f"missing imported module: {source.relative_to(site)} -> {spec}")

def verify_dist(root):
    root = Path(root)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit("manifest missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "voice-ui-dist/1":
        raise SystemExit("manifest schema mismatch")

    required = [
        "site/index.html",
        "site/app/src/app.mjs",
        "site/app/src/render.mjs",
        "site/app/src/decision/graph-edge.mjs",
        "site/ui/ui-ir/index.mjs",
        "site/ui/a2ui-browser/render/trusted-dom.mjs",
        "site/ui/semantic-map/runtime.js",
        "site/ui/semantic-map/protocol/index.js",
        "site/ui/semantic-map/authoring/pages/embed.html",
        "site/hayamimi/runtime/api/hayamimi.mjs",
        "site/hayamimi/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm",
        "site/hayamimi/sherpa/data.parts.json",
        "site/sw.js",
        "functions/api/jev.mjs",
        ".envs/artifact.jsonl",
        "e2e/local-voice-graph-e2e.mjs",
        "e2e/fixtures/voice-add-edge-en.wav",
        "e2e/fixtures/voice-add-edge-en.golden.json",
    ]
    for rel in required:
        path = root / rel
        if not path.is_file() or path.stat().st_size == 0:
            raise SystemExit(f"required artifact missing: {rel}")

    if (root / "site/hayamimi/sherpa/sherpa-onnx-wasm-main-vad-asr.data").exists():
        raise SystemExit("whole ASR model must be chunked before publication")
    if any("sherpa-pja" in path.as_posix() for path in root.rglob("*")):
        raise SystemExit("second-opinion runtime must not be projected")

    site = root / "site"
    for path in (p for p in site.rglob("*") if p.is_file()):
        if path.stat().st_size > PAGE_FILE_LIMIT:
            raise SystemExit(f"Pages file limit exceeded: {path.relative_to(root)}")
        data = path.read_bytes()
        if b"JEV_API_KEY" in data:
            raise SystemExit(f"Jev secret identifier leaked into public site: {path.relative_to(root)}")

    for path in (p for p in root.rglob("*") if p.is_file()):
        data = path.read_bytes()
        for marker in SECRET_MARKERS:
            if marker in data:
                raise SystemExit(f"secret material marker in artifact: {path.relative_to(root)}")

    check_imports(site)

    expected = {row["path"]: row for row in manifest.get("files", [])}
    actual = {
        path.relative_to(root).as_posix(): path
        for path in root.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    }
    if set(expected) != set(actual):
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        raise SystemExit(f"manifest closure mismatch missing={missing} extra={extra}")
    for rel, path in actual.items():
        row = expected[rel]
        if row.get("bytes") != path.stat().st_size or row.get("sha256") != sha256(path):
            raise SystemExit(f"manifest mismatch: {rel}")

    parts = json.loads((site / "hayamimi/sherpa/data.parts.json").read_text(encoding="utf-8"))
    if len(parts.get("parts", [])) < 2:
        raise SystemExit("chunk manifest does not describe a split model")
    for row in parts["parts"]:
        part = site / "hayamimi/sherpa" / row["path"]
        if not part.is_file() or part.stat().st_size != row["bytes"] or sha256(part) != row["sha256"]:
            raise SystemExit(f"chunk mismatch: {row['path']}")

    auth_lines = (root / ".envs/artifact.jsonl").read_text(encoding="utf-8").splitlines()
    if len([line for line in auth_lines if line.strip()]) != 1:
        raise SystemExit("auth contract must contain exactly one record")
    auth = json.loads(next(line for line in auth_lines if line.strip()))
    if auth != {
        "artifact": "voice-ui",
        "kind": "artifact.auth.v1",
        "requiredCapabilities": ["jev-api"],
    }:
        raise SystemExit("auth contract mismatch")

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    build_parser = sub.add_parser("build")
    build_parser.add_argument("--app", required=True)
    build_parser.add_argument("--ui-ir", required=True)
    build_parser.add_argument("--a2ui", required=True)
    build_parser.add_argument("--semantic-map", required=True)
    build_parser.add_argument("--hayamimi", required=True)
    build_parser.add_argument("--out", required=True)
    build_parser.add_argument("--app-rev", required=True)
    build_parser.add_argument("--ui-rev", required=True)
    build_parser.add_argument("--ops-rev", required=True)
    build_parser.add_argument("--system", required=True)

    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--dist", required=True)

    args = parser.parse_args()
    if args.command == "build":
        build(args)
    else:
        verify_dist(Path(args.dist))

if __name__ == "__main__":
    main()
