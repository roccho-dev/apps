{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/f9948418dc8628ac02b6d6337e191ade9429d59d";
    ui.url = "github:roccho-dev/ui/57cd621206ef416dc2525e113a5a12b77c082065";
  };

  outputs = { self, nixpkgs, ui }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = f:
        builtins.listToAttrs (map (system: {
          name = system;
          value = f system;
        }) systems);
      revisionOf = input:
        if input ? rev then input.rev
        else if input ? dirtyRev then input.dirtyRev
        else "working-tree";
      appRevision = revisionOf self;
      uiRevision = revisionOf ui;
      acceptanceFor = system: import ./packages/voice-ui/acceptance {
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
      hayamimiFor = system:
        let
          pkgs = import nixpkgs { inherit system; };
          fetch = name: sha256: pkgs.fetchurl { url = "${hayamimiRelease.base}/${name}"; inherit sha256; };
        in pkgs.runCommand "hayamimi-web" {
          nativeBuildInputs = [ pkgs.python3 pkgs.unzip ];
          expected = builtins.toJSON hayamimiRelease.proof;
          proof = fetch "merged-pr-proof.json" hayamimiRelease.proofSha256;
          zip = fetch "hayamimi-web.zip" hayamimiRelease.sha256;
        } ''
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
    in {
      packages = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          semanticMap = ui.packages.${system}.semantic-map;
          hayamimiWeb = hayamimiFor system;

          mkVoiceUiDist = name: pkgs.runCommand name {
            nativeBuildInputs = [ pkgs.python3 pkgs.esbuild ];
          } ''
            python3 ${self}/packages/voice-ui/dist.py build \
              --app ${self}/packages/voice-ui \
              --semantic-map ${semanticMap} \
              --hayamimi ${hayamimiWeb} \
              --out "$out" \
              --app-rev ${appRevision} \
              --ui-rev ${uiRevision} \
              --hayamimi-artifact '${hayamimiArtifact}' \
              --system ${system}
          '';
        in {
          semantic-map = semanticMap;
          hayamimi-web = hayamimiWeb;

          voice-ui-auth = pkgs.runCommand "voice-ui-auth" { } ''
            mkdir -p "$out/.envs"
            cp ${self}/packages/voice-ui/artifact.jsonl "$out/.envs/artifact.jsonl"
          '';

          voice-ui-dist = mkVoiceUiDist "voice-ui-dist";
          voice-ui-acceptance-runtime = (acceptanceFor system).runtime;
        });

      apps = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          dev = pkgs.writeShellApplication {
            name = "voice-ui-dev";
            runtimeInputs = [ pkgs.nodejs ];
            text = ''
              export VOICE_UI_SEMANTIC_MAP=${ui.packages.${system}.semantic-map}
              export VOICE_UI_HAYAMIMI=${hayamimiFor system}
              exec node ${self}/packages/voice-ui/dev/serve.mjs "$@"
            '';
          };
        in {
          dev = {
            type = "app";
            program = "${dev}/bin/voice-ui-dev";
          };
        });

      checks = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          semanticMap = ui.packages.${system}.semantic-map;
          hayamimiWeb = hayamimiFor system;
          voiceUiAuth = self.packages.${system}.voice-ui-auth;
          voiceUiDist = self.packages.${system}.voice-ui-dist;
          mkRepro = name: pkgs.runCommand name {
            nativeBuildInputs = [ pkgs.python3 pkgs.esbuild ];
          } ''
            python3 ${self}/packages/voice-ui/dist.py build \
              --app ${self}/packages/voice-ui \
              --semantic-map ${semanticMap} \
              --hayamimi ${hayamimiWeb} \
              --out "$out" \
              --app-rev ${appRevision} \
              --ui-rev ${uiRevision} \
              --hayamimi-artifact '${hayamimiArtifact}' \
              --system ${system}
          '';
          reproA = mkRepro "voice-ui-dist-repro-a";
          reproB = mkRepro "voice-ui-dist-repro-b";
        in {
          voice-ui-acceptance-boundary = (acceptanceFor system).check;
          voice-ui-worker = pkgs.runCommand "voice-ui-worker-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            node ${./packages/voice-ui/acceptance/worker-smoke.mjs} ${voiceUiDist}/worker/worker.mjs
            touch "$out"
          '';
          voice-ui = pkgs.runCommand "voice-ui-check" {
            nativeBuildInputs = [ pkgs.nodejs ];
            SEMANTIC_MAP = semanticMap;
          } ''
            cd ${self}
            # A pattern that matches no test fails here, so an empty scope can never pass.
            shopt -s failglob
            node --test packages/voice-ui/tests/*.test.mjs
            touch "$out"
          '';

          provider-artifacts = pkgs.runCommand "provider-artifacts-check" { } ''
            set -euo pipefail

            for artifact in ${semanticMap}; do
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

          voice-ui-dist = pkgs.runCommand "voice-ui-dist-check" {
            nativeBuildInputs = [ pkgs.python3 ];
          } ''
            python3 ${self}/packages/voice-ui/dist.py verify --dist ${voiceUiDist}
            touch "$out"
          '';

          voice-ui-dist-repro = pkgs.runCommand "voice-ui-dist-repro-check" {
            nativeBuildInputs = [ pkgs.diffutils ];
          } ''
            diff -qr ${reproA} ${reproB}
            touch "$out"
          '';
        });
    };
}
