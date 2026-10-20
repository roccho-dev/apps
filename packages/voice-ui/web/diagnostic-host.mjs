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

async function installDiagnosticHost(target, { onFinding = () => {}, write } = {}) {
  if (target === null || typeof target !== "object") {
    throw new TypeError("diagnostic host target must be an object");
  }
  if (target.dataset.diagnosticHostInstalled === "true") {
    return null;
  }

  target.dataset.diagnosticHostInstalled = "pending";
  try {
    const runtime = await createBrowserBridge({
      write,
      onFinding(finding) {
        target.dataset.diagnosticCode = finding.code;
        target.dataset.diagnosticAction = finding.action;
        target.dataset.diagnosticPhase = finding.phase;
        onFinding(finding);
      },
    });
    let lastFailure = "";
    const observe = () => {
      if (target.dataset.state !== "failed") return;
      const phase = target.dataset.failurePhase || "operation";
      const reason = target.dataset.failureReason || "failed";
      const key = `${phase}:${reason}`;
      if (key === lastFailure) return;
      lastFailure = key;
      try {
        runtime.bridge.reportFailure({ phase, reason });
        target.dataset.diagnosticTransport = "accepted";
      } catch {
        target.dataset.diagnosticTransport = "rejected";
      }
    };
    const observer = new MutationObserver(observe);
    observer.observe(target, {
      attributes: true,
      attributeFilter: ["data-state", "data-failure-phase", "data-failure-reason"],
    });
    target.dataset.diagnosticProviderRevision = EXPECTED_PROVIDER.revision;
    target.dataset.diagnosticHostInstalled = "true";
    observe();
    return Object.freeze({ observer, runtime });
  } catch (error) {
    target.dataset.diagnosticHostInstalled = "failed";
    throw error;
  }
}

async function settleMutations() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function runBrowserDiagnosticProof() {
  const body = globalThis.document?.body;
  if (!body) {
    throw new Error("browser proof requires a document body");
  }

  const rows = [];
  const findings = [];
  body.dataset.primaryResult = "failed";
  body.dataset.failurePhase = "judge";
  body.dataset.failureReason = "provider_rejected";
  const installed = await installDiagnosticHost(body, {
    write: (line) => rows.push(line),
    onFinding: (finding) => findings.push(finding),
  });
  if (installed === null) {
    throw new Error("browser proof target was already installed");
  }
  body.dataset.state = "failed";
  await settleMutations();

  if (rows.length !== 1 || findings.length !== 1) {
    throw new Error("actual failure state did not produce exactly one diagnostic and finding");
  }
  if (body.dataset.diagnosticTransport !== "accepted"
      || body.dataset.diagnosticAction !== "inspect-judgment-provider"
      || body.dataset.primaryResult !== "failed"
      || body.dataset.state !== "failed") {
    throw new Error("actual failure state was not preserved and classified");
  }

  const line = rows[0];
  const finding = findings[0];
  if (!line.includes(`\"code\":\"${VOICE_UI_FAILURE_CODE}\"`)
      || installed.runtime.port.canonicalize(line) !== line) {
    throw new Error("browser callback did not contain one canonical diagnostic row");
  }

  const wrongSource = consumeVoiceUiDiagnostic({
    line,
    parse: installed.runtime.port.parse,
    providerIdentity: { ...installed.runtime.providerIdentity, revision: "0".repeat(40) },
  });
  if (wrongSource.reason !== "wrong-source") {
    throw new Error("wrong provider source was accepted");
  }
  const wrongCode = consumeVoiceUiDiagnostic({
    line: installed.runtime.port.encode({
      schema: "diagnostic/1",
      code: "voice-ui.other",
      level: "error",
      message: "x",
    }),
    parse: installed.runtime.port.parse,
    providerIdentity: installed.runtime.providerIdentity,
  });
  if (wrongCode.reason !== "wrong-code") {
    throw new Error("wrong diagnostic code was accepted");
  }
  const invalid = consumeVoiceUiDiagnostic({
    line: "{not-json}",
    parse: installed.runtime.port.parse,
    providerIdentity: installed.runtime.providerIdentity,
  });
  if (invalid.reason !== "invalid-diagnostic") {
    throw new Error("invalid diagnostic was accepted");
  }

  const rejectedTarget = document.createElement("section");
  rejectedTarget.dataset.primaryResult = "failed";
  rejectedTarget.dataset.failurePhase = "render";
  rejectedTarget.dataset.failureReason = "transport_rejected";
  body.append(rejectedTarget);
  let rejectedWrites = 0;
  await installDiagnosticHost(rejectedTarget, {
    write() {
      rejectedWrites += 1;
      throw new Error("bounded browser transport rejected");
    },
  });
  rejectedTarget.dataset.state = "failed";
  await settleMutations();
  if (rejectedWrites !== 1
      || rejectedTarget.dataset.diagnosticTransport !== "rejected"
      || rejectedTarget.dataset.primaryResult !== "failed"
      || rejectedTarget.dataset.state !== "failed") {
    throw new Error("transport rejection changed the caller-owned primary failure");
  }

  return Object.freeze({
    status: "PASS",
    providerIdentity: installed.runtime.providerIdentity,
    finding,
    actualFailureState: Object.freeze({
      state: body.dataset.state,
      primaryResult: body.dataset.primaryResult,
      transport: body.dataset.diagnosticTransport,
    }),
    controls: [wrongSource.reason, wrongCode.reason, invalid.reason, "transport-preserved-primary"],
  });
}

if (globalThis.document?.body?.dataset.diagnosticProof !== "standalone") {
  void installDiagnosticHost(globalThis.document.body).catch(() => {});
}
