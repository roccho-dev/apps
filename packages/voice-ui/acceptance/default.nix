{ pkgs, artifact }:
let
  modules = pkgs.linkFarm "voice-ui-acceptance-modules" [
    { name = "playwright-core"; path = pkgs.playwright-driver; }
  ];
  browsers = pkgs.runCommand "voice-ui-playwright-browsers" { } ''
    source=${pkgs.playwright-driver.browsers-chromium}
    mkdir -p "$out"
    for item in "$source"/*; do
      name="$(basename "$item")"
      if [ "$name" != chromium-1228 ] && [ "$name" != chromium_headless_shell-1228 ]; then
        ln -s "$item" "$out/$name"
      fi
    done
    chrome="$(find -L "$source" -type f -path '*/chrome-linux*/chrome' -perm -0100 | head -n 1)"
    shell="$(find -L "$source" -type f -name chrome-headless-shell -perm -0100 | head -n 1)"
    test -n "$chrome"
    if [ -z "$shell" ]; then shell="$chrome"; fi
    mkdir -p \
      "$out/chromium-1228/chrome-linux64" \
      "$out/chromium_headless_shell-1228/chrome-headless-shell-linux64"
    ln -s "$chrome" "$out/chromium-1228/chrome-linux64/chrome"
    ln -s "$shell" "$out/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"
  '';
  runtime = pkgs.writeShellApplication {
    name = "voice-ui-acceptance-node";
    text = ''
      unset NODE_OPTIONS NODE_EXTRA_CA_CERTS
      export NODE_PATH=${modules}
      export PLAYWRIGHT_BROWSERS_PATH=${browsers}
      export VOICE_UI_CHROMIUM_EXECUTABLE=${browsers}/chromium-1228/chrome-linux64/chrome
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
