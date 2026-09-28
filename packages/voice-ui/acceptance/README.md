# Acceptance execution boundary

`voice-ui-acceptance-runtime` is a separate pinned Nix closure containing Node, Playwright Core and its matching full Chromium. It executes the artifact-owned script supplied as its first argument, with no package installation, source checkout or app rebuild. The app/site artifact does not include the browser.

`voice-ui-acceptance-boundary` executes the actual packaged runtime/public E2E entrypoints twice with fresh HOME/workspaces. Real Chromium navigates to a loopback test endpoint and the actual `/api/jev` call receives a controlled 503. CI passes only if the call was observed and the application receipt is RED. This is executable-boundary evidence, not application PASS and not a real provider test.

Ops owns provisioning the already-built closure and admitting its exact identity, then passing the verified artifact entrypoint. The immutable Nix store closure, not just the shell wrapper's digest, defines the runtime. Normal invocation does not contact Nix/npm/package registries. The source Nix pin is shared with the root flake.

Physical completion of apps#27 still requires the actual deployed endpoint, target-native auth and complete application acceptance. CI's controlled endpoint must never be used for that claim.
