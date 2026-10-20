{ pkgs, artifact }:
let
  modules = pkgs.linkFarm "voice-ui-acceptance-modules" [
    { name = "playwright-core"; path = pkgs.playwright-driver; }
  ];
  browsers = pkgs.runCommand "voice-ui-playwright-browsers" { } ''
    mkdir -p \
      "$out/chromium-1228/chrome-linux64" \
      "$out/chromium_headless_shell-1228/chrome-headless-shell-linux64"
    ln -s ${pkgs.chromium}/bin/chromium "$out/chromium-1228/chrome-linux64/chrome"
    ln -s ${pkgs.chromium}/bin/chromium "$out/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"
  '';
  runtime = pkgs.writeShellApplication {
    name = "voice-ui-acceptance-node";
    text = ''
      unset NODE_OPTIONS NODE_EXTRA_CA_CERTS
      export NODE_PATH=${modules}
      export PLAYWRIGHT_BROWSERS_PATH=${browsers}
      export VOICE_UI_CHROMIUM_EXECUTABLE=${pkgs.chromium}/bin/chromium
      export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
      export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
      exec ${pkgs.tini}/bin/tini -s -- ${pkgs.nodejs}/bin/node "$@"
    '';
  };
in {
  inherit runtime;
  check = pkgs.runCommand "voice-ui-acceptance-boundary-check" {
    nativeBuildInputs = [ pkgs.nodejs ];
  } ''
    node ${./smoke.mjs} ${runtime}/bin/voice-ui-acceptance-node ${artifact}
    ${runtime}/bin/voice-ui-acceptance-node ${./diagnostic-browser.mjs} ${artifact}
    touch "$out"
  '';
}
