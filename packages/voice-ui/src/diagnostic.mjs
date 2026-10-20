export const VOICE_UI_FAILURE_CODE = "voice-ui.operation-failed";
export const EXPECTED_PROVIDER = Object.freeze({
  repository: "roccho-org/ops",
  revision: "fe968fc6b8919fed48151a57f421667bce0aac87",
  tree: "b306bf999aba32a678ac48b5a56e4b4a0a3c0cf8",
  contractBlob: "8df122c2e3205328a0f922c3397e7246ae1e0e16",
  coreBlob: "135ec3331f82af2ab310518cc8b4a356ccefcf3f",
  browserAdapterBlob: "f9dfe0616a3abf64fe4af06b949d377ea5de96b2",
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

function diagnosticForVoiceUiFailure({ phase = "operation", reason = "failed" } = {}) {
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

function sameProviderIdentity(actual, expected = EXPECTED_PROVIDER) {
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
