{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/f9948418dc8628ac02b6d6337e191ade9429d59d";
    ui.url = "github:roccho-dev/ui/57cd621206ef416dc2525e113a5a12b77c082065";
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
        base = "https://github.com/roccho-dev/ops/releases/download/jev-provider-7758b4cf8b89088d5475a3acb700c027a665d7e3";
        locator = "https://github.com/roccho-dev/ops/releases/download/jev-provider-7758b4cf8b89088d5475a3acb700c027a665d7e3/jev-provider.zip";
        sha256 = "fd0bceae63863c0d562d8ffd716828afcdffd5e02d1ad0139bad240a03148fb1";
        proof_sha256 = "a7e5ee3ea10639ce85d1205e9cdc14057802f7c125684510ca0cbf3e343faa1a";
        provenance_sha256 = "3f61a5842c61f4f516bbf5904b4e0f8a6e0e11e2921c69ca1257c8cbcf5a2287";
        entry_sha256 = "1b1f393a3cde7b4e5dde26baa9327a9858bda48b9ec9a2a98874830557595ded";
        manifest_sha256 = "05b6642095392276293df53733594c2055b55b243e2562a331dd5a758f4f7fed";
        contract = "named-choices/1";
        proof = {
          pr_number = 464;
          base = "proposals";
          reviewed_head = "9eae8cae13215f31aa75520528e8ce1fa3d17c54";
          r_exact_head_verdict_ref = "https://github.com/roccho-dev/ops/pull/464#pullrequestreview-5378764707";
          merge_sha = "7758b4cf8b89088d5475a3acb700c027a665d7e3";
          reviewed_tree = "52a71d4d56ba28bbe297bf1342fc54da1c2ba14c";
          merge_tree = "52a71d4d56ba28bbe297bf1342fc54da1c2ba14c";
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
                ];
              }
              ''
                python3 ${self}/packages/voice-ui/dist.py build \
                  --app ${self}/packages/voice-ui \
                  --semantic-map ${semanticMap} \
                  --hayamimi ${hayamimiWeb} \
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
        }
      );

      apps = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          dev = pkgs.writeShellApplication {
            name = "voice-ui-dev";
            runtimeInputs = [ pkgs.nodejs ];
            text = ''
              export VOICE_UI_SEMANTIC_MAP=${ui.packages.${system}.semantic-map}
              export VOICE_UI_HAYAMIMI=${hayamimiFor system}
              export VOICE_UI_WORKER=${self.packages.${system}.voice-ui-dist}/worker/worker.mjs
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
                ];
              }
              ''
                python3 ${self}/packages/voice-ui/dist.py build \
                  --app ${self}/packages/voice-ui \
                  --semantic-map ${semanticMap} \
                  --hayamimi ${hayamimiWeb} \
                  --judge ${if name == "voice-ui-dist-repro-b" then jevRelocated else jevProvider} \
                  --judge-artifact '${jevArtifact}' \
                  --out "$out" \
                  --app-rev ${appRevision} \
                  --ui-rev ${uiRevision} \
                  --hayamimi-artifact '${hayamimiArtifact}' \
                  --system ${system}
              '';
          reproA = mkRepro "voice-ui-dist-repro-a";
          reproB = mkRepro "voice-ui-dist-repro-b";
        in
        {
          voice-ui-acceptance-boundary = (acceptanceFor system).check;
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
                nativeBuildInputs = [ pkgs.python3 ];
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
                test "$i" = 13
                touch "$out"
              '';

          voice-ui-dist-repro =
            pkgs.runCommand "voice-ui-dist-repro-check"
              {
                nativeBuildInputs = [ pkgs.diffutils ];
              }
              ''
                diff -qr ${reproA} ${reproB}
                touch "$out"
              '';
        }
      );
    };
}
