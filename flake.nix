{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/f9948418dc8628ac02b6d6337e191ade9429d59d";
    ui.url = "github:roccho-dev/ui/2c835f3c712dbba535d5f15ffddf08b2a9253ef8";
    ops.url = "github:roccho-dev/ops/ec6f29eee6efc057c9b7938e979849d070b0d0fc";
  };

  outputs = { self, nixpkgs, ui, ops }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = f:
        builtins.listToAttrs (map (system: {
          name = system;
          value = f system;
        }) systems);
    in {
      packages = forEachSystem (system: {
        ui-ir = ui.packages.${system}.ui-ir;
        a2ui-browser = ui.packages.${system}.a2ui-browser;
        semantic-map = ui.packages.${system}.semantic-map;
        hayamimi-web = ops.packages.${system}.hayamimi-web;
      });

      # One localhost entry. It serves the exact provider outputs in place and
      # needs no Cloudflare account; envctl supplies JEV_API_KEY to the child.
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
        in {
          voice-ui = pkgs.runCommand "voice-ui-check" {
            nativeBuildInputs = [ pkgs.nodejs ];
            # The decision unit proves the projection against the pinned
            # semantic-map codec rather than a stand-in.
            SEMANTIC_MAP = semanticMap;
          } ''
            cd ${self}
            node --test packages/voice-ui/tests/*.test.mjs
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
        });
    };
}
