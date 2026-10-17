{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/f9948418dc8628ac02b6d6337e191ade9429d59d";
    ui.url = "github:roccho-dev/ui/756d47e891191c3344eb2d29b000203be8331abc";
  };

  outputs =
    {
      self,
      nixpkgs,
      ui,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem =
        f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );
      revisionOf =
        input:
        if input ? rev then
          input.rev
        else if input ? dirtyRev then
          input.dirtyRev
        else
          "working-tree";
      appRevision = revisionOf self;
      uiRevision = revisionOf ui;
      # Immutable canonical semcmp package definition from roccho-org/ops.
      # This builds its installed wrapper, never imports a sibling checkout.
      semcmpSource = builtins.fetchGit {
        url = "https://github.com/roccho-org/ops.git";
        rev = "50bd8a674ca6c13d45cb362c6bc1b6e18659f8eb";
      };
      semcmpFor = system:
        let pkgs = import nixpkgs { inherit system; };
        in pkgs.callPackage (semcmpSource + "/packages/semcmp/default.nix") { };
      # This package's own source, prepared for the architecture page from the
      # exact commit only. A tree with uncommitted changes has no commit, so the
      # preparation records that it is unavailable and why; the architecture
      # page stays blocked while the rest of the dev server works as before.
      architectureFor = system:
        let pkgs = import nixpkgs { inherit system; };
        in pkgs.runCommand "voice-ui-architecture-source" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
          node --experimental-vm-modules ${self}/packages/voice-ui/architecture/prepare.mjs \
            --scope ${self}/packages/voice-ui/architecture/scope.v1.json \
            --root ${self}/packages/voice-ui \
            --commit '${if self ? rev then self.rev else ""}' \
            --out "$out"
        '';
      acceptanceFor =
        system:
        import ./packages/voice-ui/acceptance {
          pkgs = import nixpkgs { inherit system; };
          artifact = self.packages.${system}.voice-ui-dist;
        };
      # hayamimi-web is the exact ops release (roccho-dev/ops#446), not ops
      # source. The zip and its merged-PR proof are pinned by digest, and the
      # proof must match this exact PR/review/merge before the zip is used.
      # Bytes are not claimed to be reproducible across hosts.
      hayamimiRelease = {
        base = "https://github.com/roccho-dev/ops/releases/download/hayamimi-web-1665d5195a0dd70c2e0253c20351e5305db35f3f";
        sha256 = "c12b51e2ea396a64131b917439ffbda1aa1cd70a9fd7f9567ea05030897c672a";
        proofSha256 = "a0bb1478a5ffe9440f46682ca143382cd000d0d1d6f736723baad96541be4e27";
        proof = {
          pr_number = 447;
          base = "proposals";
          reviewed_head = "ab1be5d0c7471c71fa10b17a98f2fa3353f891a9";
          r_exact_head_verdict_ref = "https://github.com/roccho-dev/ops/pull/447#pullrequestreview-5349013341";
          merge_sha = "1665d5195a0dd70c2e0253c20351e5305db35f3f";
          reviewed_tree = "1719da5f952165cdae0325249daa01816e9f6311";
          merge_tree = "1719da5f952165cdae0325249daa01816e9f6311";
        };
      };
      hayamimiArtifact = builtins.toJSON {
        locator = "${hayamimiRelease.base}/hayamimi-web.zip";
        inherit (hayamimiRelease) sha256;
        proof_sha256 = hayamimiRelease.proofSha256;
      };
      # Completed reviewed provider bytes; no ops source checkout/build input.
      jevRelease = {
        base = "https://github.com/roccho-org/ops/releases/download/jev-provider-b4f611cac9e13fbef178469796cbc3b6d4a76b23";
        locator = "https://github.com/roccho-org/ops/releases/download/jev-provider-b4f611cac9e13fbef178469796cbc3b6d4a76b23/jev-provider.zip";
        sha256 = "073d9df7a2eeb479a3641c6b86768bf3af14ec1b7e976ed5672649148d5e2435";
        proof_sha256 = "459b753541fdf53cf0acb9cb13167c17218e078e3782933e589afaf57a8c6846";
        provenance_sha256 = "b602225c44cc67c4f6a96fe41914c5159140718a4c81f0826cf46d9cce9223b8";
        entry_sha256 = "3f754c8b1ee4a8b34b50d00fd17e37295d853e1b607903b6d355b5e06997669c";
        manifest_sha256 = "c8fdf65da826690b487ab093d20c73a445a11dbc736ae4f58e23af7c57330318";
        contract = "named-choices-and-typed/1";
        proof = {
          pr_number = 565;
          base = "proposals";
          reviewed_head = "f7e80875b1331c113cb38251d85838edf0330d5b";
          r_exact_head_verdict_ref = "https://github.com/roccho-org/ops/pull/565#pullrequestreview-5558945175";
          merge_sha = "b4f611cac9e13fbef178469796cbc3b6d4a76b23";
          reviewed_tree = "dcb90215ac4e2f010b1bb39da5f71462cc94bf56";
          merge_tree = "dcb90215ac4e2f010b1bb39da5f71462cc94bf56";
        };
      };
      jevArtifact = builtins.toJSON (
        builtins.removeAttrs jevRelease [
          "base"
          "proof"
        ]
      );
      jevFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          fetch =
            name: sha256:
            pkgs.fetchurl {
              url = "${jevRelease.base}/${name}";
              inherit sha256;
            };
        in
        pkgs.runCommand "jev-provider-admitted"
          {
            nativeBuildInputs = [
              pkgs.python3
              pkgs.nodejs
            ];
            zip = fetch "jev-provider.zip" jevRelease.sha256;
            proof = fetch "merged-pr-proof.json" jevRelease.proof_sha256;
            provenance = fetch "provenance.json" jevRelease.provenance_sha256;
            expected = builtins.toJSON (builtins.removeAttrs jevRelease [ "base" ]);
          }
          ''
            python3 ${self}/packages/voice-ui/dist.py test-judge-admission \
              --archive "$zip" --proof "$proof" --provenance "$provenance" \
              --expected "$expected"
            python3 ${self}/packages/voice-ui/dist.py admit-judge \
              --archive "$zip" --proof "$proof" --provenance "$provenance" \
              --expected "$expected" --out "$out"
          '';
      hayamimiFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          fetch =
            name: sha256:
            pkgs.fetchurl {
              url = "${hayamimiRelease.base}/${name}";
              inherit sha256;
            };
        in
        pkgs.runCommand "hayamimi-web"
          {
            nativeBuildInputs = [
              pkgs.python3
              pkgs.unzip
            ];
            expected = builtins.toJSON hayamimiRelease.proof;
            proof = fetch "merged-pr-proof.json" hayamimiRelease.proofSha256;
            zip = fetch "hayamimi-web.zip" hayamimiRelease.sha256;
          }
          ''
            python3 - <<'PY'
            import json, os
            proof = json.load(open(os.environ["proof"]))
            expected = json.loads(os.environ["expected"])
            assert set(proof) == set(expected) | {"merged_at"}, sorted(proof)
            assert all(proof[k] == v for k, v in expected.items()), proof
            assert proof["reviewed_tree"] == proof["merge_tree"] and proof["merged_at"], proof
            PY
            unzip -q "$zip" -d unpacked
            test "$(ls -A unpacked)" = hayamimi-web
            cp -R unpacked/hayamimi-web "$out"
          '';
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          semanticMap = ui.packages.${system}.semantic-map;
          hayamimiWeb = hayamimiFor system;
          jevProvider = jevFor system;

          mkVoiceUiDist =
            name:
            pkgs.runCommand name
              {
                nativeBuildInputs = [
                  pkgs.python3
                  pkgs.esbuild
                  pkgs.nodejs
                ];
              }
              ''
                python3 ${self}/packages/voice-ui/dist.py build \
                  --app ${self}/packages/voice-ui \
                  --semantic-map ${semanticMap} \
                  --hayamimi ${hayamimiWeb} \
                  --architecture ${architectureFor system} \
                  --judge ${jevProvider} \
                  --judge-artifact '${jevArtifact}' \
                  --out "$out" \
                  --app-rev ${appRevision} \
                  --ui-rev ${uiRevision} \
                  --hayamimi-artifact '${hayamimiArtifact}' \
                  --system ${system}
              '';
        in
        {
          semantic-map = semanticMap;
          hayamimi-web = hayamimiWeb;
          jev-provider = jevProvider;

          voice-ui-auth = pkgs.runCommand "voice-ui-auth" { } ''
            mkdir -p "$out/.envs"
            cp ${self}/packages/voice-ui/artifact.jsonl "$out/.envs/artifact.jsonl"
          '';

          voice-ui-dist = mkVoiceUiDist "voice-ui-dist";
          voice-ui-acceptance-runtime = (acceptanceFor system).runtime;
          voice-ui-architecture-source = architectureFor system;
        }
      );

      apps = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          semcmpPackage = semcmpFor system;
          dev = pkgs.writeShellApplication {
            name = "voice-ui-dev";
            runtimeInputs = [ pkgs.nodejs semcmpPackage ];
            text = ''
              export VOICE_UI_SEMANTIC_MAP=${ui.packages.${system}.semantic-map}
              export VOICE_UI_HAYAMIMI=${hayamimiFor system}
              export VOICE_UI_WORKER=${self.packages.${system}.voice-ui-dist}/worker/worker.mjs
              export VOICE_UI_ARCHITECTURE=${architectureFor system}
              export VOICE_UI_SEMCMP_BIN=${semcmpPackage}/bin/semcmp
              exec node ${self}/packages/voice-ui/dev/serve.mjs "$@"
            '';
          };
        in
        {
          dev = {
            type = "app";
            program = "${dev}/bin/voice-ui-dev";
          };
        }
      );

      checks = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          semanticMap = ui.packages.${system}.semantic-map;
          hayamimiWeb = hayamimiFor system;
          jevProvider = jevFor system;
          voiceUiAuth = self.packages.${system}.voice-ui-auth;
          voiceUiDist = self.packages.${system}.voice-ui-dist;
          # Local supplied-byte location changes only: no formal URL/proof
          # identity change or general future supplier guarantee is claimed.
          jevRelocated = pkgs.runCommand "jev-provider-relocated" { } ''
            cp -R ${jevProvider} "$out"
          '';
          mkRepro =
            name:
            pkgs.runCommand name
              {
                nativeBuildInputs = [
                  pkgs.python3
                  pkgs.esbuild
                  pkgs.nodejs
                ];
              }
              ''
                python3 ${self}/packages/voice-ui/dist.py build \
                  --app ${self}/packages/voice-ui \
                  --semantic-map ${semanticMap} \
                  --hayamimi ${hayamimiWeb} \
                  --architecture ${architectureFor system} \
                  --judge ${if name == "voice-ui-dist-relocated" then jevRelocated else jevProvider} \
                  --judge-artifact '${jevArtifact}' \
                  --out "$out" \
                  --app-rev ${appRevision} \
                  --ui-rev ${uiRevision} \
                  --hayamimi-artifact '${hayamimiArtifact}' \
                  --system ${system}
              '';
          reproA = mkRepro "voice-ui-dist-repro-a";
          reproB = mkRepro "voice-ui-dist-repro-b";
          relocated = mkRepro "voice-ui-dist-relocated";
        in
        {
          voice-ui-acceptance-boundary = (acceptanceFor system).check;
          voice-ui-candidate-browser = pkgs.runCommand "voice-ui-candidate-browser-check" { } ''
            export HOME="$TMPDIR/candidate-browser-home"
            mkdir -p "$HOME"
            ${(acceptanceFor system).runtime}/bin/voice-ui-acceptance-node \
              ${self}/packages/voice-ui/acceptance/candidate-browser.mjs ${voiceUiDist} "$out"
            ${(acceptanceFor system).runtime}/bin/voice-ui-acceptance-node \
              ${self}/packages/voice-ui/acceptance/component-axes-smoke.mjs ${voiceUiDist} "$out/component-axes-mechanics"
          '';
          voice-ui-worker =
            pkgs.runCommand "voice-ui-worker-check" { nativeBuildInputs = [ pkgs.nodejs ]; }
              ''
                node ${./packages/voice-ui/acceptance/worker-smoke.mjs} ${voiceUiDist}/worker/worker.mjs
                touch "$out"
              '';
          voice-ui =
            pkgs.runCommand "voice-ui-check"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                SEMANTIC_MAP = semanticMap;
                JUDGE_PROVIDER_ENTRY = "${jevProvider}/batch.mjs";
                VOICE_UI_WORKER = "${voiceUiDist}/worker/worker.mjs";
                VOICE_UI_SEMCMP_BIN = "${semcmpFor system}/bin/semcmp";
                VOICE_UI_DIST = "${voiceUiDist}";
                POC_PROTOCOL_ENTRY = "${voiceUiDist}/site/ui/semantic-map/protocol/index.js";
                POC_SOURCE_ROOT = "${self}/packages/voice-ui";
                POC_AXIS_FIXTURES = "${self}/docs/voice-ui/component-axes-20261017/preregistered";
                POC_RESERVE_FIXTURES = "${self}/docs/voice-ui/component-axes-20261017/evidence/final-E";
                POC_REQUIREMENTS_FIXTURES = "${self}/docs/voice-ui/requirements-cycle-20261017/preregistered";
                POC_DEPENDENCY_PREREG_ROOT = "${self}/docs/voice-ui/dependency-cycle-20261018/preregistered";
                POC_DEPENDENCY_PARENT_ROOT = "${self}/docs/voice-ui/requirements-cycle-20261017/preregistered";
                POC_INTENT_PREREG_ROOT = "${self}/docs/voice-ui/intent-cycle-20261018/preregistered";
                POC_INTENT_PARENT_ROOT = "${self}/docs/voice-ui/dependency-cycle-20261018/preregistered";
                POC_INTENT_OLD_JOURNAL = "${self}/docs/voice-ui/dependency-cycle-20261018/evidence/public-E/dependency-public-E-20261018.journal.jsonl";
                POC_FRONTIER_PREREG_ROOT = "${self}/docs/voice-ui/frontier-cycle-20261018/preregistered";
                POC_FRONTIER_PARENT_ROOT = "${self}/docs/voice-ui/intent-cycle-20261018/preregistered";
                POC_FRONTIER_OLD_JOURNAL = "${self}/docs/voice-ui/intent-cycle-20261018/evidence/public-G0/intent-public-G0-20261018.journal.jsonl";
                VOICE_UI_HAYAMIMI = "${hayamimiWeb}";
                VOICE_UI_SEMANTIC_MAP = "${semanticMap}";
                VOICE_UI_ARCHITECTURE = "${architectureFor system}";
              }
              ''
                cd ${self}
                # A pattern that matches no test fails here, so an empty scope can never pass.
                shopt -s failglob
                node --test packages/voice-ui/tests/*.test.mjs
                touch "$out"
              '';

          provider-artifacts = pkgs.runCommand "provider-artifacts-check" { } ''
            set -euo pipefail

            for artifact in ${semanticMap} ${jevProvider}; do
              test -d "$artifact"
              test -n "$(ls -A "$artifact")"
            done

            for file in \
              ${hayamimiWeb}/runtime/api/hayamimi.mjs \
              ${hayamimiWeb}/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm \
              ${hayamimiWeb}/sherpa/sherpa-onnx-wasm-main-vad-asr.data \
              ${hayamimiWeb}/THIRD_PARTY_NOTICES.md; do
              test -f "$file"
              test -s "$file"
            done

            touch "$out"
          '';

          artifact-auth = pkgs.runCommand "artifact-auth-check" { } ''
            test -f ${voiceUiAuth}/.envs/artifact.jsonl
            cmp ${self}/packages/voice-ui/artifact.jsonl \
              ${voiceUiAuth}/.envs/artifact.jsonl
            touch "$out"
          '';

          voice-ui-dist =
            pkgs.runCommand "voice-ui-dist-check"
              {
                nativeBuildInputs = [ pkgs.python3 pkgs.nodejs ];
              }
              ''
                python3 ${self}/packages/voice-ui/dist.py verify --dist ${voiceUiDist}
                # The declared runtime is verified, not trusted: an old schema, a
                # tampered runtime block or a Worker that does not read a declared
                # binding (its manifest row updated to match) must each be refused.
                # One real copy, hard-linked per case so paths resolve inside each
                # tree; a mutation replaces files, never edits a shared one.
                cp -R ${voiceUiDist} base
                chmod -R u+w base
                # Each case must be refused with its own reason, not an earlier one.
                i=0
                refuse() {
                  i=$((i + 1))
                  cp -al base "tampered-$i"
                  python3 - "tampered-$i" "$2" <<'PY'
                import hashlib, json, os, sys
                root, mutation = sys.argv[1], sys.argv[2]
                m = json.load(open(os.path.join(root, "manifest.json")))
                def rewrite(rel, data):
                    os.remove(os.path.join(root, rel))
                    open(os.path.join(root, rel), "wb").write(data)
                    row = next(r for r in m["files"] if r["path"] == rel)
                    row.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                exec(mutation)
                os.remove(os.path.join(root, "manifest.json"))
                json.dump(m, open(os.path.join(root, "manifest.json"), "w"))
                PY
                  if err="$(python3 ${self}/packages/voice-ui/dist.py verify --dist "tampered-$i" 2>&1)"; then
                    echo "dist verify accepted a tampered artifact: $2" >&2
                    exit 1
                  fi
                  case "$err" in
                    *"$1"*) echo "refused as expected: $1" ;;
                    *) echo "refused for another reason ($err), expected: $1" >&2; exit 1 ;;
                  esac
                }
                refuse "manifest schema mismatch" 'm["schema"] = "voice-ui-dist/1"'
                refuse "declared Worker runtime mismatch" 'm["runtime"]["secrets"] = []'
                refuse "declared Worker runtime mismatch" 'm["runtime"]["assets"]["binding"] = "STATIC"'
                refuse "declared Worker runtime mismatch" 'm["runtime"]["main_module"] = "site/app.mjs"'
                refuse "declared Worker runtime mismatch" 'm["runtime"]["compatibility_date"] = "2026-01-01"'
                refuse "compiled Worker does not read declared binding: ASSETS" \
                  'rewrite("worker/worker.mjs", b"export default {fetch(){return new Response(null)}}\n")'
                refuse "compiled Worker does not read declared binding: JEV_API_KEY" \
                  'rewrite("worker/worker.mjs", open(os.path.join(root, "worker/worker.mjs"), "rb").read().replace(b"JEV_API_KEY", b"JEV_API_KEX"))'
                # Reach each artifact guard independently: keep manifest closure
                # valid when the import or chunk contract is the intended failure.
                refuse "missing imported module" \
                  'rel="site/hayamimi/runtime/asr/client.mjs"; os.remove(os.path.join(root, rel)); m["files"] = [r for r in m["files"] if r["path"] != rel]'
                refuse "chunk mismatch" \
                  'rel="site/hayamimi/sherpa/" + json.load(open(os.path.join(root, "site/hayamimi/sherpa/data.parts.json")))["parts"][0]["path"]; os.remove(os.path.join(root, rel)); m["files"] = [r for r in m["files"] if r["path"] != rel]'
                refuse "chunk mismatch" \
                  'rel="site/hayamimi/sherpa/" + json.load(open(os.path.join(root, "site/hayamimi/sherpa/data.parts.json")))["parts"][0]["path"]; data=open(os.path.join(root, rel), "rb").read(); rewrite(rel, bytes([data[0] ^ 1]) + data[1:])'
                refuse "manifest mismatch" \
                  'rel="site/index.html"; data=open(os.path.join(root, rel), "rb").read() + b"\n<!-- byte mismatch -->\n"; os.remove(os.path.join(root, rel)); open(os.path.join(root, rel), "wb").write(data)'
                refuse "manifest closure mismatch" \
                  'open(os.path.join(root, "unlisted-test.txt"), "wb").write(b"unlisted public test file\n")'
                refuse "secret material marker" \
                  'rewrite("site/index.html", open(os.path.join(root, "site/index.html"), "rb").read() + b"\n<!-- AGE-SECRET-KEY-TEST-ONLY -->\n")'
                refuse "architecture source identity mismatch" \
                  'rel="site/architecture/data/source.v1.json"; s=json.load(open(os.path.join(root, rel))); s["source"]["commit"]="f"*40; rewrite(rel, json.dumps(s).encode())'
                refuse "architecture evidence closure mismatch" \
                  'rel="architecture/evidence.json"; e=json.load(open(os.path.join(root, rel))); del e["files"][next(iter(e["files"]))]; rewrite(rel, json.dumps(e).encode())'
                refuse "architecture evidence blob mismatch" \
                  'rel="architecture/evidence.json"; e=json.load(open(os.path.join(root, rel))); e["files"][next(iter(e["files"]))]+="\nchanged"; rewrite(rel, json.dumps(e).encode())'
                refuse "architecture provenance mismatch" 'm["sources"]["architecture"]["manifest_sha256"]="0"*64'
                refuse "architecture public manifest invalid" \
                  'rel="site/architecture/data/source.v1.json"; s=json.load(open(os.path.join(root, rel))); s["text"]="not public metadata"; rewrite(rel, json.dumps(s).encode())'
                test "$i" = 18
                touch "$out"
              '';

          voice-ui-dist-repro =
            pkgs.runCommand "voice-ui-dist-repro-check"
              {
                nativeBuildInputs = [
                  pkgs.diffutils
                  pkgs.nodejs
                ];
              }
              ''
                diff -qr ${reproA} ${reproB}
                # Whitespace-only emission omits input storepath banners:
                # relocation must preserve the actual Worker bytes too.
                diff -qr ${reproA}/site ${relocated}/site
                diff -qr ${reproA}/e2e ${relocated}/e2e
                cmp ${reproA}/worker/worker.mjs ${relocated}/worker/worker.mjs
                export JUDGE_PROVIDER_ENTRY=${jevRelocated}/batch.mjs
                export VOICE_UI_WORKER=${relocated}/worker/worker.mjs
                node --test ${self}/packages/voice-ui/tests/api.test.mjs
                touch "$out"
              '';
        }
      );
    };
}
