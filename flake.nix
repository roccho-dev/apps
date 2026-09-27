{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/f9948418dc8628ac02b6d6337e191ade9429d59d";
    ui.url = "github:roccho-dev/ui/57cd621206ef416dc2525e113a5a12b77c082065";
    ops.url = "github:roccho-dev/ops/268a7b8e26c1f32ca29604ee45a08a61be97b507";
  };

  outputs = { self, nixpkgs, ui, ops }:
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
      opsRevision = revisionOf ops;
    in {
      packages = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          uiIr = ui.packages.${system}.ui-ir;
          a2uiBrowser = ui.packages.${system}.a2ui-browser;
          semanticMap = ui.packages.${system}.semantic-map;
          hayamimiWeb = ops.packages.${system}.hayamimi-web;

          mkVoiceUiDist = name: pkgs.runCommand name {
            nativeBuildInputs = [ pkgs.python3 ];
          } ''
            python3 ${self}/packages/voice-ui/dist.py build \
              --app ${self}/packages/voice-ui \
              --ui-ir ${uiIr} \
              --a2ui ${a2uiBrowser} \
              --semantic-map ${semanticMap} \
              --hayamimi ${hayamimiWeb} \
              --out "$out" \
              --app-rev ${appRevision} \
              --ui-rev ${uiRevision} \
              --ops-rev ${opsRevision} \
              --system ${system}
          '';
        in {
          ui-ir = uiIr;
          a2ui-browser = a2uiBrowser;
          semantic-map = semanticMap;
          hayamimi-web = hayamimiWeb;

          voice-ui-auth = pkgs.runCommand "voice-ui-auth" { } ''
            mkdir -p "$out/.envs"
            cp ${self}/packages/voice-ui/artifact.jsonl "$out/.envs/artifact.jsonl"
          '';

          voice-ui-dist = mkVoiceUiDist "voice-ui-dist";
        });

      apps = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          dev = pkgs.writeShellApplication {
            name = "voice-ui-dev";
            runtimeInputs = [ pkgs.nodejs ];
            text = ''
              export VOICE_UI_UI_IR=${ui.packages.${system}.ui-ir}
              export VOICE_UI_A2UI=${ui.packages.${system}.a2ui-browser}
              export VOICE_UI_SEMANTIC_MAP=${ui.packages.${system}.semantic-map}
              export VOICE_UI_HAYAMIMI=${ops.packages.${system}.hayamimi-web}
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
          uiIr = ui.packages.${system}.ui-ir;
          a2uiBrowser = ui.packages.${system}.a2ui-browser;
          semanticMap = ui.packages.${system}.semantic-map;
          hayamimiWeb = ops.packages.${system}.hayamimi-web;
          voiceUiAuth = self.packages.${system}.voice-ui-auth;
          voiceUiDist = self.packages.${system}.voice-ui-dist;
          mkRepro = name: pkgs.runCommand name {
            nativeBuildInputs = [ pkgs.python3 ];
          } ''
            python3 ${self}/packages/voice-ui/dist.py build \
              --app ${self}/packages/voice-ui \
              --ui-ir ${uiIr} \
              --a2ui ${a2uiBrowser} \
              --semantic-map ${semanticMap} \
              --hayamimi ${hayamimiWeb} \
              --out "$out" \
              --app-rev ${appRevision} \
              --ui-rev ${uiRevision} \
              --ops-rev ${opsRevision} \
              --system ${system}
          '';
          reproA = mkRepro "voice-ui-dist-repro-a";
          reproB = mkRepro "voice-ui-dist-repro-b";
        in {
          voice-ui = pkgs.runCommand "voice-ui-check" {
            nativeBuildInputs = [ pkgs.nodejs ];
            SEMANTIC_MAP = semanticMap;
          } ''
            cd ${self}
            node --test packages/voice-ui/tests/*.test.mjs
            touch "$out"
          '';

          voice-ui-scenarios = pkgs.runCommand "voice-ui-scenarios-check" {
            nativeBuildInputs = [ pkgs.nodejs pkgs.curl pkgs.playwright-test ];
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers-chromium;
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
            PLAYWRIGHT_MODULE = "file://${pkgs.playwright-test}/lib/node_modules/playwright/index.mjs";
            VOICE_UI_UI_IR = uiIr;
            VOICE_UI_A2UI = a2uiBrowser;
            VOICE_UI_SEMANTIC_MAP = semanticMap;
            VOICE_UI_HAYAMIMI = hayamimiWeb;
          } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"

            log="$TMPDIR/voice-ui-scenario-server.log"
            PORT=0 node ${self}/packages/voice-ui/dev/serve.mjs >"$log" 2>&1 &
            server_pid=$!
            cleanup() {
              kill "$server_pid" 2>/dev/null || true
              wait "$server_pid" 2>/dev/null || true
            }
            trap cleanup EXIT

            port=""
            for _ in $(seq 1 120); do
              line="$(grep -m1 'voice-ui dev: listening on ' "$log" || true)"
              if [ -n "$line" ]; then
                port="${line##*:}"
                break
              fi
              if ! kill -0 "$server_pid" 2>/dev/null; then
                break
              fi
              sleep 0.25
            done

            if [ -z "$port" ] || ! curl -fsS "http://127.0.0.1:$port/" >/dev/null; then
              cat "$log" >&2
              exit 1
            fi

            if ! node ${self}/packages/voice-ui/tests/e2e/run.mjs "http://127.0.0.1:$port"; then
              cat "$log" >&2
              exit 1
            fi

            touch "$out"
          '';

          provider-artifacts = pkgs.runCommand "provider-artifacts-check" { } ''
            set -euo pipefail

            for artifact in ${uiIr} ${a2uiBrowser} ${semanticMap}; do
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
