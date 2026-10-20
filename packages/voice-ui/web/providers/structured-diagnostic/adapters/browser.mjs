import {
  DiagnosticContractError,
  encodeDiagnostic,
  parseDiagnosticLine,
  validateDiagnostic,
} from "../lib/diagnostic.mjs";

export function createBrowserDiagnosticPort({ contract, write }) {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    throw new DiagnosticContractError(
      "DIAGNOSTIC_CONTRACT_INVALID",
      "contract",
      "contract must be an object",
    );
  }
  if (typeof write !== "function") {
    throw new DiagnosticContractError(
      "DIAGNOSTIC_PORT_INVALID",
      "write",
      "browser diagnostic port must expose write(line)",
    );
  }

  return Object.freeze({
    validate(value) {
      return validateDiagnostic(value, contract);
    },
    encode(value) {
      return encodeDiagnostic(value, contract);
    },
    parse(line) {
      return parseDiagnosticLine(line, contract);
    },
    emit(value) {
      const line = encodeDiagnostic(value, contract);
      write(line);
      return line;
    },
  });
}
