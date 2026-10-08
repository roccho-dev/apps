#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import shutil
import subprocess
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


# The consumer's one narrow admission: completed bytes, never producer source
# or a second publisher implementation. It runs before any credential injection.
def judge_require(condition, code):
    if not condition:
        raise SystemExit("judge_admission:" + code)

def judge_json(raw, code):
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise SystemExit("judge_admission:" + code) from None
    judge_require(isinstance(value, dict), code)
    return value

def admit_judge(archive, proof_path, provenance_path, expected, out):
    archive, proof_path, provenance_path = map(Path, (archive, proof_path, provenance_path))
    judge_require(sha256(archive) == expected["sha256"], "digest_mismatch")
    judge_require(sha256(proof_path) == expected["proof_sha256"], "identity_mismatch")
    judge_require(sha256(provenance_path) == expected["provenance_sha256"], "identity_mismatch")
    proof = judge_json(proof_path.read_bytes(), "identity_mismatch")
    provenance = judge_json(provenance_path.read_bytes(), "identity_mismatch")
    judge_require(all(proof.get(k) == v for k, v in expected["proof"].items())
                  and proof.get("reviewed_tree") == proof.get("merge_tree") and proof.get("merged_at"), "identity_mismatch")
    judge_require(all(isinstance(provenance.get(k), dict) for k in ("proof", "artifact", "inputDigests")), "identity_mismatch")
    judge_require(provenance.get("schema") == "jev-provider-provenance/1"
                  and provenance.get("source") == {"repository": "roccho-dev/ops", "commit": proof["merge_sha"], "tree": proof["merge_tree"]}
                  and provenance.get("mergedProof") == proof
                  and provenance.get("proof", {}).get("sha256") == expected["proof_sha256"]
                  and provenance.get("locator") == expected["locator"]
                  and provenance.get("artifact", {}).get("sha256") == expected["sha256"], "identity_mismatch")
    import zipfile
    try:
        with zipfile.ZipFile(archive) as zipped:
            names = zipped.namelist()
            judge_require("batch.mjs" in names, "module_missing")
            judge_require(sorted(names) == ["batch.mjs", "manifest.json"], "manifest_mismatch")
            module, manifest_bytes = zipped.read("batch.mjs"), zipped.read("manifest.json")
    except (zipfile.BadZipFile, UnicodeDecodeError):
        raise SystemExit("judge_admission:manifest_mismatch") from None
    manifest = judge_json(manifest_bytes, "manifest_mismatch")
    judge_require(manifest.get("schema") == "jev-provider/1" and manifest.get("contract") == expected["contract"] == "named-choices/2", "unsupported_contract")
    module_sha = hashlib.sha256(module).hexdigest()
    judge_require(manifest.get("entry") == "batch.mjs" and manifest.get("exports") == ["JudgeProviderError", "bindJev", "judgeNamedChoices"]
                  and manifest.get("importClosure") == []
                  and manifest.get("files") == [{"path": "batch.mjs", "bytes": len(module), "sha256": module_sha}]
                  and provenance.get("manifestSha256") == hashlib.sha256(manifest_bytes).hexdigest()
                  and provenance.get("artifact", {}).get("bytes") == archive.stat().st_size
                  and set(provenance["inputDigests"]) == {"flake.lock", "packages/jev/src/core.mjs", "packages/jev/src/batch.mjs", "packages/jev/default.nix", "tools/jev-provider-artifact.py"}
                  and all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for v in provenance["inputDigests"].values())
                  and provenance.get("entrySha256") == module_sha
                  and module_sha == expected["entry_sha256"]
                  and hashlib.sha256(manifest_bytes).hexdigest() == expected["manifest_sha256"], "manifest_mismatch")
    try:
        source = module.decode("utf-8")
    except UnicodeDecodeError:
        raise SystemExit("judge_admission:import_failed") from None
    judge_require(not re.search(r'\b(?:import|require)\s*(?:\(|["\'])|\bfrom\s*["\']|\b(?:process|global|Buffer)\b|node:', source), "import_closure")
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    entry = out / "batch.mjs"
    entry.write_bytes(module)
    (out / "manifest.json").write_bytes(manifest_bytes)
    # Controlled import, not a provider invocation. No key is passed, no app
    # state/commit exists here; fetch during module initialization is rejected.
    probe = r'''let calls=0;globalThis.fetch=()=>{calls++;throw new Error("forbidden")};
    try{const m=await import(process.argv[1]);if(calls!==0||typeof m.bindJev!=="function"||typeof m.judgeNamedChoices!=="function"||typeof m.JudgeProviderError!=="function")process.exit(1)}catch{process.exit(1)}'''
    try:
        imported = subprocess.run(["node", "--input-type=module", "-e", probe, entry.resolve().as_uri()], capture_output=True, timeout=10)
    except subprocess.TimeoutExpired:
        raise SystemExit("judge_admission:import_failed") from None
    judge_require(imported.returncode == 0, "import_failed")
    (out / "identity.json").write_text(json.dumps({k: expected[k] for k in ("locator", "sha256", "proof_sha256", "provenance_sha256", "contract", "entry_sha256", "manifest_sha256")}, sort_keys=True) + "\n")
    return out


def test_judge_admission(args):
    # Same admission and one immutable supplied base; crafted identities here
    # isolate each guard, never acquire supplied/proof-approved status.
    import copy
    import tempfile
    import zipfile
    baseline = json.loads(args.expected)
    original_proof = Path(args.proof).read_bytes()
    original_provenance = json.loads(Path(args.provenance).read_bytes())
    with zipfile.ZipFile(args.archive) as zipped:
        original_module = zipped.read("batch.mjs")
        original_manifest = json.loads(zipped.read("manifest.json"))
    work = Path(tempfile.mkdtemp(prefix="judge-admission-controls-"))
    admit_judge(args.archive, args.proof, args.provenance, baseline, work / "positive")
    cases = [
        ("tamper", "digest_mismatch"),
        ("wrong_identity", "identity_mismatch"),
        ("module_missing", "module_missing"),
        ("unsupported_contract", "unsupported_contract"),
        ("import_failed", "import_failed"),
        ("initialization_fetch", "import_failed"),
        ("malformed_manifest", "manifest_mismatch"),
        ("corrupt_zip", "manifest_mismatch"),
    ]
    for label, code in cases:
        folder = work / label
        folder.mkdir()
        expected = copy.deepcopy(baseline)
        provenance = copy.deepcopy(original_provenance)
        manifest = copy.deepcopy(original_manifest)
        module = original_module
        if label == "unsupported_contract":
            manifest["contract"] = "unsupported/1"
        elif label == "import_failed":
            module = b"export {"
        elif label == "initialization_fetch":
            module = b'globalThis.fetch("https://fixture.invalid");export const JudgeProviderError=Error;export const judgeNamedChoices=()=>{};'
        module_sha = hashlib.sha256(module).hexdigest()
        manifest["files"] = [{"path": "batch.mjs", "bytes": len(module), "sha256": module_sha}]
        manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        if label == "malformed_manifest":
            manifest_bytes = b"{"
        archive = folder / "provider.zip"
        with zipfile.ZipFile(archive, "w") as zipped:
            if label != "module_missing":
                zipped.writestr("batch.mjs", module)
            zipped.writestr("manifest.json", manifest_bytes)
        if label == "corrupt_zip":
            archive.write_bytes(b"invalid ZIP")
        expected["sha256"] = sha256(archive)
        expected["entry_sha256"] = module_sha
        expected["manifest_sha256"] = hashlib.sha256(manifest_bytes).hexdigest()
        provenance["artifact"] = {"bytes": archive.stat().st_size, "sha256": expected["sha256"]}
        provenance["manifestSha256"] = expected["manifest_sha256"]
        provenance["entrySha256"] = module_sha
        proof_path = folder / "proof.json"
        proof_path.write_bytes(original_proof)
        provenance_path = folder / "provenance.json"
        provenance_path.write_text(json.dumps(provenance))
        expected["provenance_sha256"] = sha256(provenance_path)
        if label == "tamper":
            expected["sha256"] = "0" * 64
        elif label == "wrong_identity":
            expected["proof"]["merge_sha"] = "0" * 40
        try:
            admit_judge(archive, proof_path, provenance_path, expected, folder / "output")
        except SystemExit as failure:
            assert str(failure) == "judge_admission:" + code, label
        else:
            raise AssertionError("admission unexpectedly accepted " + label)
    print("judge admission: actual supplied positive 1; typed refusal controls 8; credential injection/provider invocation/app commit 0")

def architecture_identity(root, app_rev):
    public = Path(root) / "site/architecture/data/source.v1.json"
    private = Path(root) / "architecture/evidence.json"
    source = json.loads(public.read_text(encoding="utf-8"))
    evidence = json.loads(private.read_text(encoding="utf-8"))
    # Reuse the app's closed public-metadata validator, not a second schema implementation.
    probe = 'import fs from "node:fs"; import { readManifest } from "./src/architecture.mjs"; const v=JSON.parse(fs.readFileSync(0,"utf8")); if(readManifest(v).status!==v.status) process.exitCode=1;'
    try:
        checked = subprocess.run(["node", "--input-type=module", "--eval", probe],
                                 cwd=Path(__file__).parent, input=public.read_bytes(),
                                 capture_output=True, timeout=10)
    except subprocess.TimeoutExpired:
        raise SystemExit("architecture public manifest invalid") from None
    if checked.returncode != 0:
        raise SystemExit("architecture public manifest invalid")
    if (source.get("schema") != "voice-ui.architecture-source/2"
            or evidence.get("schema") != "voice-ui.architecture-evidence/1"
            or source.get("status") != evidence.get("status")):
        raise SystemExit("architecture binding mismatch")
    if source["status"] == "available":
        if set(evidence) != {"schema", "status", "source", "files"}:
            raise SystemExit("architecture evidence closure mismatch")
        identity = source.get("source")
        if (not isinstance(identity, dict) or set(identity) != {"handle", "commit"}
                or not re.fullmatch(r"[0-9a-f]{40}", app_rev)
                or identity["commit"] != app_rev or evidence.get("source") != identity):
            raise SystemExit("architecture source identity mismatch")
        admitted = {f["entity"]: f for f in source["files"] if f["class"] == "admitted"}
        files = evidence.get("files")
        if not isinstance(files, dict) or set(files) != set(admitted):
            raise SystemExit("architecture evidence closure mismatch")
        for entity, text in files.items():
            if not isinstance(text, str):
                raise SystemExit("architecture evidence blob mismatch")
            raw = text.encode("utf-8")
            blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            if blob != admitted[entity]["blob"]:
                raise SystemExit("architecture evidence blob mismatch")
    elif (source["status"] == "unavailable" and not re.fullmatch(r"[0-9a-f]{40}", app_rev)
          and set(evidence) == {"schema", "status", "reason"}
          and source.get("reason") == evidence.get("reason")):
        # Preserve source-dev builds of a dirty tree, without granting an exact snapshot.
        identity = None
    else:
        raise SystemExit("architecture source unavailable for exact artifact")
    return {"status": source["status"], "source": identity,
            "manifest_sha256": sha256(public), "evidence_sha256": sha256(private)}


def build(args):
    app = Path(args.app)
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    site = out / "site"

    judge_identity = json.loads(args.judge_artifact)
    judge = Path(args.judge)
    judge_require(json.loads((judge / "identity.json").read_text()) == judge_identity
                  and sha256(judge / "batch.mjs") == judge_identity["entry_sha256"]
                  and sha256(judge / "manifest.json") == judge_identity["manifest_sha256"], "manifest_mismatch")

    copy_tree(app / "web", site)
    copy_tree(app / "src", site / "app/src")
    copy_file(app / "dev/architecture-config.v1.json", site / "architecture/data/config.v1.json")
    copy_file(Path(args.architecture) / "manifest.json", site / "architecture/data/source.v1.json")
    copy_file(Path(args.architecture) / "evidence.json", out / "architecture/evidence.json")
    # The compiled Worker is the artifact's only provider route. Raw functions/
    # are never shipped: their imports resolve only inside the app tree.
    worker = out / "worker/worker.mjs"
    worker.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "esbuild", "functions/pages-worker.mjs", "--bundle", "--format=esm",
        "--platform=browser", "--target=es2022", "--log-level=warning",
        f"--alias:voice-ui-judge-provider={(judge / 'batch.mjs').resolve()}",
        f"--outfile={worker.resolve()}",
    ], cwd=app, check=True)

    copy_tree(Path(args.semantic_map) / "packages", site / "ui")

    hayamimi = Path(args.hayamimi)
    copy_tree(hayamimi / "runtime", site / "hayamimi/runtime")
    copy_tree(hayamimi / "sherpa", site / "hayamimi/sherpa")
    copy_file(hayamimi / "THIRD_PARTY_NOTICES.md", site / "hayamimi/THIRD_PARTY_NOTICES.md")

    copy_file(app / "artifact.jsonl", out / ".envs/artifact.jsonl")
    copy_file(app / "tests/local-voice-graph-e2e.mjs", out / "e2e/local-voice-graph-e2e.mjs")
    copy_file(app / "tests/public-e2e.mjs", out / "e2e/public-e2e.mjs")
    copy_file(app / "tests/architecture-e2e.mjs", out / "e2e/architecture-e2e.mjs")
    copy_file(app / "tests/runtime-acceptance.mjs", out / "e2e/runtime-acceptance.mjs")
    copy_file(app / "dev/serve.mjs", out / "e2e/serve.mjs")
    copy_file(app / "tests/fixtures/proposals.json", out / "e2e/fixtures/proposals.json")
    copy_file(app / "tests/fixtures/voice-add-edge-en.wav", out / "e2e/fixtures/voice-add-edge-en.wav")
    copy_file(app / "tests/fixtures/voice-add-edge-en.golden.json", out / "e2e/fixtures/voice-add-edge-en.golden.json")
    copy_file(app / "tests/fixtures/voice-reverse-edge-en.wav", out / "e2e/fixtures/voice-reverse-edge-en.wav")
    copy_file(app / "tests/fixtures/voice-reverse-edge-en.golden.json", out / "e2e/fixtures/voice-reverse-edge-en.golden.json")

    split_model(site)

    manifest = {
        "schema": "voice-ui-dist/2",
        "sources": {
            "apps": args.app_rev,
            "architecture": architecture_identity(out, args.app_rev),
            "ui": args.ui_rev,
            "hayamimi-web": json.loads(args.hayamimi_artifact),
            "jev-provider": judge_identity,
            "system": args.system,
        },
        "auth": ".envs/artifact.jsonl",
        "e2e": {
            "entrypoint": "e2e/local-voice-graph-e2e.mjs",
            "runtime_entrypoint": "e2e/runtime-acceptance.mjs",
            "local_serve_entrypoint": "e2e/serve.mjs",
            "public_entrypoint": "e2e/public-e2e.mjs",
            "architecture_entrypoint": "e2e/architecture-e2e.mjs",
            "wav": "e2e/fixtures/voice-add-edge-en.wav",
            "golden": "e2e/fixtures/voice-add-edge-en.golden.json",
            "correction_wav": "e2e/fixtures/voice-reverse-edge-en.wav",
            "correction_golden": "e2e/fixtures/voice-reverse-edge-en.golden.json",
        },
        # Declared Worker requirements for a consumer's deploy step. Declared,
        # not proven: no target, account or secret value is named here.
        "runtime": {
            "main_module": "worker/worker.mjs",
            "assets": {"directory": "site", "binding": "ASSETS"},
            "compatibility_date": "2026-09-01",
            "compatibility_flags": [],
            "secrets": [{"name": "JEV_API_KEY", "capability": "jev-api"}],
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
    if manifest.get("schema") != "voice-ui-dist/2":
        raise SystemExit("manifest schema mismatch")

    required = [
        "site/index.html",
        "site/app.mjs",
        "site/data/config.v1.json",
        "site/data/bundle.v1.json",
        "site/architecture/data/config.v1.json",
        "site/architecture/data/source.v1.json",
        "architecture/evidence.json",
        "site/app/src/contract.mjs",
        "site/app/src/bundle.mjs",
        "site/app/src/config.mjs",
        "site/app/src/log.mjs",
        "site/app/src/session.mjs",
        "site/app/src/turn.mjs",
        "site/app/src/render.mjs",
        "site/app/src/judgment.mjs",
        "site/adapters/judgment.mjs",
        "site/adapters/transcription.mjs",
        "site/app/src/architecture.mjs",
        "site/app/src/document.mjs",
        "site/ui/semantic-map/runtime.js",
        "site/ui/semantic-map/protocol/index.js",
        "site/ui/semantic-map/authoring/pages/embed.html",
        "site/hayamimi/runtime/api/hayamimi.mjs",
        "site/hayamimi/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm",
        "site/hayamimi/sherpa/data.parts.json",
        "site/sw.js",
        "worker/worker.mjs",
        ".envs/artifact.jsonl",
        "e2e/local-voice-graph-e2e.mjs",
        "e2e/public-e2e.mjs",
        "e2e/architecture-e2e.mjs",
        "e2e/runtime-acceptance.mjs",
        "e2e/serve.mjs",
        "e2e/fixtures/proposals.json",
        "e2e/fixtures/voice-add-edge-en.wav",
        "e2e/fixtures/voice-add-edge-en.golden.json",
        "e2e/fixtures/voice-reverse-edge-en.wav",
        "e2e/fixtures/voice-reverse-edge-en.golden.json",
    ]
    for rel in required:
        path = root / rel
        if not path.is_file() or path.stat().st_size == 0:
            raise SystemExit(f"required artifact missing: {rel}")

    expected_e2e = {
        "entrypoint": "e2e/local-voice-graph-e2e.mjs",
        "runtime_entrypoint": "e2e/runtime-acceptance.mjs",
            "local_serve_entrypoint": "e2e/serve.mjs",
        "public_entrypoint": "e2e/public-e2e.mjs",
        "architecture_entrypoint": "e2e/architecture-e2e.mjs",
        "wav": "e2e/fixtures/voice-add-edge-en.wav",
        "golden": "e2e/fixtures/voice-add-edge-en.golden.json",
        "correction_wav": "e2e/fixtures/voice-reverse-edge-en.wav",
        "correction_golden": "e2e/fixtures/voice-reverse-edge-en.golden.json",
    }
    if manifest.get("e2e") != expected_e2e:
        raise SystemExit("runtime acceptance contract mismatch")

    expected_runtime = {
        "main_module": "worker/worker.mjs",
        "assets": {"directory": "site", "binding": "ASSETS"},
        "compatibility_date": "2026-09-01",
        "compatibility_flags": [],
        "secrets": [{"name": "JEV_API_KEY", "capability": "jev-api"}],
    }
    if manifest.get("runtime") != expected_runtime:
        raise SystemExit("declared Worker runtime mismatch")

    if manifest.get("sources", {}).get("architecture") != architecture_identity(root, manifest["sources"]["apps"]):
        raise SystemExit("architecture provenance mismatch")

    if (root / "site/hayamimi/sherpa/sherpa-onnx-wasm-main-vad-asr.data").exists():
        raise SystemExit("whole ASR model must be chunked before publication")
    if any("sherpa-pja" in path.as_posix() for path in root.rglob("*")):
        raise SystemExit("second-opinion runtime must not be projected")

    site = root / "site"
    for path in (p for p in site.rglob("*") if p.is_file()):
        if path.stat().st_size > PAGE_FILE_LIMIT:
            raise SystemExit(f"Pages file limit exceeded: {path.relative_to(root)}")
        data = path.read_bytes()
        # The exact public source manifest declares identifiers, never source text or key values.
        # Its paired source identity and evidence blobs were checked above; other site files retain the ban.
        if b"JEV_API_KEY" in data and path != site / "architecture/data/source.v1.json":
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

    # The declared secrets are exactly the auth contract's capabilities, and the
    # compiled Worker reads every declared binding by name.
    runtime = manifest["runtime"]
    if [s["capability"] for s in runtime["secrets"]] != auth["requiredCapabilities"]:
        raise SystemExit("declared secrets differ from the auth contract")
    worker = (root / runtime["main_module"]).read_bytes()
    for name in [runtime["assets"]["binding"]] + [s["name"] for s in runtime["secrets"]]:
        if f"env.{name}".encode() not in worker and f"env?.{name}".encode() not in worker:
            raise SystemExit(f"compiled Worker does not read declared binding: {name}")

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    build_parser = sub.add_parser("build")
    build_parser.add_argument("--app", required=True)
    build_parser.add_argument("--semantic-map", required=True)
    build_parser.add_argument("--hayamimi", required=True)
    build_parser.add_argument("--architecture", required=True)
    build_parser.add_argument("--out", required=True)
    build_parser.add_argument("--app-rev", required=True)
    build_parser.add_argument("--ui-rev", required=True)
    build_parser.add_argument("--hayamimi-artifact", required=True)
    build_parser.add_argument("--system", required=True)
    build_parser.add_argument("--judge", required=True)
    build_parser.add_argument("--judge-artifact", required=True)

    judge_parser = sub.add_parser("admit-judge")
    for name in ("archive", "proof", "provenance", "expected", "out"):
        judge_parser.add_argument("--" + name, required=True)

    judge_test_parser = sub.add_parser("test-judge-admission")
    for name in ("archive", "proof", "provenance", "expected"):
        judge_test_parser.add_argument("--" + name, required=True)

    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--dist", required=True)

    args = parser.parse_args()
    if args.command == "build":
        build(args)
    elif args.command == "admit-judge":
        admit_judge(args.archive, args.proof, args.provenance, json.loads(args.expected), args.out)
    elif args.command == "test-judge-admission":
        test_judge_admission(args)
    else:
        verify_dist(Path(args.dist))

if __name__ == "__main__":
    main()
