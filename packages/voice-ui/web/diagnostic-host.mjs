import { createBrowserDiagnosticPort } from "./providers/structured-diagnostic/adapters/browser.mjs";
import {
  EXPECTED_PROVIDER,
  VOICE_UI_FAILURE_CODE,
  consumeVoiceUiDiagnostic,
  createVoiceUiDiagnosticBridge,
} from "/app/src/diagnostic.mjs";

const CONTRACT_URL = new URL("./providers/structured-diagnostic/contract.json", import.meta.url);
const IDENTITY_URL = new URL("./providers/structured-diagnostic/identity.json", import.meta.url);

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed to load ${url.pathname}: ${response.status}`);
  }
  return response.json();
}

async function createBrowserBridge({ onFinding = () => {}, write } = {}) {
  const [contract, providerIdentity] = await Promise.all([
    loadJson(CONTRACT_URL),
    loadJson(IDENTITY_URL),
  ]);
  const lines = [];
  const port = createBrowserDiagnosticPort({
    contract,
    write: write ?? ((line) => {
      lines.push(line);
      globalThis.dispatchEvent?.(new CustomEvent("voice-ui-diagnostic", { detail: { line } }));
    }),
  });
  return Object.freeze({
    contract,
    providerIdentity,
    lines,
    port,
    bridge: createVoiceUiDiagnosticBridge({ port, providerIdentity, onFinding }),
  });
}

export async function runBrowserDiagnosticProof() {
  const findings = [];
  const runtime = await createBrowserBridge({ onFinding: (finding) => findings.push(finding) });
  const result = runtime.bridge.reportFailure({ phase: "judge", reason: "provider_rejected" });
  if (result.finding.status !== "classified" || result.finding.action !== "inspect-judgment-provider") {
    throw new Error("valid diagnostic was not classified from stable machine fields");
  }
  if (runtime.lines.length !== 1 || !runtime.lines[0].includes(`\"code\":\"${VOICE_UI_FAILURE_CODE}\"`)) {
    throw new Error("browser callback did not contain exactly one canonical diagnostic row");
  }
  if (runtime.port.canonicalize(result.line) !== result.line) {
    throw new Error("browser provider did not preserve canonical JSONL bytes");
  }
  const wrongSource = consumeVoiceUiDiagnostic({
    line: result.line,
    parse: runtime.port.parse,
    providerIdentity: { ...runtime.providerIdentity, revision: "0".repeat(40) },
  });
  if (wrongSource.reason !== "wrong-source") {
    throw new Error("wrong provider source was accepted");
  }
  const wrongCode = consumeVoiceUiDiagnostic({
    line: runtime.port.encode({ schema: "diagnostic/1", code: "voice-ui.other", level: "error", message: "x" }),
    parse: runtime.port.parse,
    providerIdentity: runtime.providerIdentity,
  });
  if (wrongCode.reason !== "wrong-code") {
    throw new Error("wrong diagnostic code was accepted");
  }
  const invalid = consumeVoiceUiDiagnostic({
    line: "{not-json}",
    parse: runtime.port.parse,
    providerIdentity: runtime.providerIdentity,
  });
  if (invalid.reason !== "invalid-diagnostic") {
    throw new Error("invalid diagnostic was accepted");
  }

  const primary = Object.freeze({ ok: false, status: "failed" });
  const transportFailure = new Error("bounded browser transport rejected");
  const rejecting = await createBrowserBridge({ write: () => { throw transportFailure; } });
  let observed = null;
  try {
    rejecting.bridge.reportFailure({ phase: "render", reason: "transport_rejected" });
  } catch (error) {
    observed = error;
  }
  if (observed !== transportFailure || primary.status !== "failed") {
    throw new Error("transport failure changed the primary result");
  }

  return Object.freeze({
    status: "PASS",
    providerIdentity: runtime.providerIdentity,
    finding: findings[0],
    controls: [wrongSource.reason, wrongCode.reason, invalid.reason, "transport-preserved-primary"],
  });
}

async function installOnVoiceUiPage() {
  if (!globalThis.document?.body || globalThis.document.body.dataset.diagnosticHostInstalled === "true") {
    return;
  }
  const body = globalThis.document.body;
  body.dataset.diagnosticHostInstalled = "pending";
  try {
    const runtime = await createBrowserBridge({
      onFinding(finding) {
        body.dataset.diagnosticCode = finding.code;
        body.dataset.diagnosticAction = finding.action;
        body.dataset.diagnosticPhase = finding.phase;
      },
    });
    let lastFailure = "";
    const observe = () => {
      if (body.dataset.state !== "failed") return;
      const phase = body.dataset.failurePhase || "operation";
      const reason = body.dataset.failureReason || "failed";
      const key = `${phase}:${reason}`;
      if (key === lastFailure) return;
      lastFailure = key;
      try {
        runtime.bridge.reportFailure({ phase, reason });
        body.dataset.diagnosticTransport = "accepted";
      } catch {
        body.dataset.diagnosticTransport = "rejected";
      }
    };
    new MutationObserver(observe).observe(body, {
      attributes: true,
      attributeFilter: ["data-state", "data-failure-phase", "data-failure-reason"],
    });
    body.dataset.diagnosticProviderRevision = EXPECTED_PROVIDER.revision;
    body.dataset.diagnosticHostInstalled = "true";
    observe();
  } catch {
    body.dataset.diagnosticHostInstalled = "failed";
  }
}

if (globalThis.document?.body?.dataset.diagnosticProof !== "standalone") {
  void installOnVoiceUiPage();
}
