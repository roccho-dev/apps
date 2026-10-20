export const VOICE_UI_FAILURE_CODE = "voice-ui.operation-failed";
export const EXPECTED_PROVIDER = Object.freeze({
  repository: "roccho-org/ops",
  revision: "ad2f0ab9eb9b70fa7c05bb06c4f4e29b5b6452b6",
  tree: "4508762a81f152eee90c4d57bfd2197a7ae2534f",
  contractBlob: "1b3ced4216b9b5b9a767515a8288ad0ce5adb5a5",
  coreBlob: "c4c9c1f2c301418ac4d5953ac35001a4e51032f2",
  browserAdapterBlob: "ff2a0c2cc6ef668c3f93eb6a064afd0a16ec5f18",
});

const ACTIONS = Object.freeze({
  input: "inspect-user-input",
  judge: "inspect-judgment-provider",
  render: "inspect-graph-rendering",
  apply: "inspect-state-application",
  operation: "inspect-voice-ui-operation",
});

const boundedToken = (value, fallback) => {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z][a-z0-9_-]{0,63}$/u.test(token) ? token : fallback;
};

export function diagnosticForVoiceUiFailure({ phase = "operation", reason = "failed" } = {}) {
  return {
    schema: "diagnostic/1",
    code: VOICE_UI_FAILURE_CODE,
    level: "error",
    message: "Voice UI operation failed",
    fields: {
      phase: boundedToken(phase, "operation"),
      reason: boundedToken(reason, "failed"),
    },
  };
}

export function sameProviderIdentity(actual, expected = EXPECTED_PROVIDER) {
  return actual !== null
    && typeof actual === "object"
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function consumeVoiceUiDiagnostic({
  line,
  parse,
  providerIdentity,
  expectedProvider = EXPECTED_PROVIDER,
}) {
  if (!sameProviderIdentity(providerIdentity, expectedProvider)) {
    return Object.freeze({ status: "ignored", reason: "wrong-source" });
  }
  if (typeof parse !== "function") {
    return Object.freeze({ status: "ignored", reason: "invalid-provider-port" });
  }

  let value;
  try {
    value = parse(line);
  } catch {
    return Object.freeze({ status: "ignored", reason: "invalid-diagnostic" });
  }
  if (value.code !== VOICE_UI_FAILURE_CODE) {
    return Object.freeze({ status: "ignored", reason: "wrong-code" });
  }

  const phase = boundedToken(value.fields?.phase, "operation");
  return Object.freeze({
    status: "classified",
    code: value.code,
    phase,
    action: ACTIONS[phase] ?? ACTIONS.operation,
  });
}

export function createVoiceUiDiagnosticBridge({
  port,
  providerIdentity,
  expectedProvider = EXPECTED_PROVIDER,
  onFinding = () => {},
}) {
  if (port === null || typeof port !== "object" || typeof port.emit !== "function" || typeof port.parse !== "function") {
    throw new TypeError("port must expose emit(value) and parse(line)");
  }
  if (typeof onFinding !== "function") {
    throw new TypeError("onFinding must be a function");
  }

  return Object.freeze({
    reportFailure(input = {}) {
      const diagnostic = diagnosticForVoiceUiFailure(input);
      const line = port.emit(diagnostic);
      const finding = consumeVoiceUiDiagnostic({
        line,
        parse: port.parse,
        providerIdentity,
        expectedProvider,
      });
      if (finding.status === "classified") {
        onFinding(finding);
      }
      return Object.freeze({ diagnostic, line, finding });
    },
  });
}
