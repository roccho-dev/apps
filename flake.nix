{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/f9948418dc8628ac02b6d6337e191ade9429d59d";
    ui.url = "github:roccho-dev/ui/c39e7c6ca17454a5e41e6d6289f5fe9c6e574683";
    ops.url = "github:roccho-dev/ops/36bdd2cb9d12fb56f962cf33f3b05e004906124e";
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
          } ''
            cd ${self}
            node --test packages/voice-ui/tests/*.test.mjs
            touch "$out"
          '';

          provider-artifacts = pkgs.runCommand "provider-artifacts-check" { } ''
            set -euo pipefail

            test -s ${uiIr}/packages/ui-ir/src/index.mjs
            test -s ${a2uiBrowser}/packages/a2ui-browser/src/index.mjs
            test -s ${semanticMap}/packages/semantic-map/runtime.js
            test -s ${semanticMap}/packages/semantic-map/renderer-maxgraph/adapter.js
            test -s ${semanticMap}/packages/semantic-map/vendor/maxgraph/view/AbstractGraph.js

            test -s ${hayamimiWeb}/runtime/api/hayamimi.mjs
            test -s ${hayamimiWeb}/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm
            test -s ${hayamimiWeb}/sherpa/sherpa-onnx-wasm-main-vad-asr.data
            test -s ${hayamimiWeb}/THIRD_PARTY_NOTICES.md

            touch "$out"
          '';
        });
    };
}
