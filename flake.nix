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
      packages = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
          ui-ir = ui.packages.${system}.ui-ir;
          a2ui-browser = ui.packages.${system}.a2ui-browser;
          semantic-map = ui.packages.${system}.semantic-map;
          hayamimi-web = ops.packages.${system}.hayamimi-web;

          voice-ui-auth = pkgs.runCommand "voice-ui-auth" { } ''
            mkdir -p "$out/.envs"
            cp ${self}/packages/voice-ui/artifact.jsonl "$out/.envs/artifact.jsonl"
          '';
        });

      checks = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          uiIr = ui.packages.${system}.ui-ir;
          a2uiBrowser = ui.packages.${system}.a2ui-browser;
          semanticMap = ui.packages.${system}.semantic-map;
          hayamimiWeb = ops.packages.${system}.hayamimi-web;
          voiceUiAuth = self.packages.${system}.voice-ui-auth;
        in {
          voice-ui = pkgs.runCommand "voice-ui-check" {
            nativeBuildInputs = [ pkgs.nodejs ];
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

          artifact-auth = pkgs.runCommand "artifact-auth-check" { } ''
            test -f ${voiceUiAuth}/.envs/artifact.jsonl
            cmp ${self}/packages/voice-ui/artifact.jsonl \
              ${voiceUiAuth}/.envs/artifact.jsonl
            touch "$out"
          '';
        });
    };
}
