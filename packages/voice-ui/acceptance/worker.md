# Exact deployable Worker

The artifact contains `worker/worker.mjs`, compiled once by apps with the root's pinned esbuild. It delegates `/api/jev` to the existing onRequestPost implementation and all static requests to Pages' ASSETS binding. No app behavior is reimplemented by ops.

Ops stages the exact `site/` bytes and this worker as the reserved `_worker.js` upload entry, then deploys with Wrangler `--no-bundle`. Staging changes placement only, not bytes. The worker is not a public static asset, so the site tree remains free of the JEV_API_KEY identifier.

The ordinary artifact manifest and reproducibility checks cover the compiled Worker. `voice-ui-worker` imports the actual compiled output and checks missing-auth, invalid-input, method and static-routing boundaries without external calls. The existing Chromium acceptance-boundary check is retained.

This source proof does not prove live Cloudflare deployment or Jev use. Existing accepted artifacts are not modified; consumers must admit the new artifact digest. Ops still owns actual deployment/readback and secret-free acceptance invocation.
