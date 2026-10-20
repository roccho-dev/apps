const textEncoder = new TextEncoder();

export class DiagnosticContractError extends Error {
  constructor(code, path, message, options = {}) {
    super(message, options);
    this.name = "DiagnosticContractError";
    this.code = code;
    this.path = path;
    if (options.line !== undefined) {
      this.line = options.line;
    }
  }
}

function fail(code, path, message, options) {
  throw new DiagnosticContractError(code, path, message, options);
}

function utf8Bytes(value) {
  return textEncoder.encode(value).byteLength;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataKeys(value, path) {
  const keys = Reflect.ownKeys(value);
  const strings = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      fail("DIAGNOSTIC_NON_JSON_PROPERTY", path, `${path} contains a symbol property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail("DIAGNOSTIC_NON_JSON_PROPERTY", `${path}.${key}`, `${path}.${key} must be an enumerable data property`);
    }
    strings.push(key);
  }
  return strings.sort();
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertNoDuplicateObjectKeys(text) {
  let index = 0;

  function skipWhitespace() {
    while (index < text.length && /[\t\n\r ]/u.test(text[index])) {
      index += 1;
    }
  }

  function readString() {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      } else {
        index += 1;
      }
    }
    return "";
  }

  function readObject() {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      const key = readString();
      if (keys.has(key)) {
        fail("DIAGNOSTIC_DUPLICATE_KEY", key, `duplicate object key: ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      index += 1;
      skipWhitespace();
      readValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      index += 1;
      skipWhitespace();
    }
  }

  function readArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      readValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      index += 1;
      skipWhitespace();
    }
  }

  function readPrimitive() {
    while (index < text.length && !/[\t\n\r ,}\]]/u.test(text[index])) {
      index += 1;
    }
  }

  function readValue() {
    skipWhitespace();
    if (text[index] === "{") {
      readObject();
    } else if (text[index] === "[") {
      readArray();
    } else if (text[index] === '"') {
      readString();
    } else {
      readPrimitive();
    }
  }

  readValue();
}

function assertStringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("DIAGNOSTIC_CONTRACT_INVALID", path, `${path} must be an array of strings`);
  }
  return value;
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("DIAGNOSTIC_CONTRACT_INVALID", path, `${path} must be a positive safe integer`);
  }
  return value;
}

function assertUnique(values, path) {
  if (new Set(values).size !== values.length) {
    fail("DIAGNOSTIC_CONTRACT_INVALID", path, `${path} must not contain duplicates`);
  }
  return values;
}

function readContract(contract) {
  if (!isPlainObject(contract) || contract.schema !== "diagnostic-contract/1") {
    fail("DIAGNOSTIC_CONTRACT_INVALID", "contract", "contract schema must be diagnostic-contract/1");
  }

  const allowedTopLevel = assertUnique(
    assertStringArray(contract.allowedTopLevel, "contract.allowedTopLevel"),
    "contract.allowedTopLevel",
  );
  const requiredTopLevel = assertUnique(
    assertStringArray(contract.requiredTopLevel, "contract.requiredTopLevel"),
    "contract.requiredTopLevel",
  );
  const hostOwnedTopLevel = assertUnique(
    assertStringArray(contract.hostOwnedTopLevel, "contract.hostOwnedTopLevel"),
    "contract.hostOwnedTopLevel",
  );
  const levels = assertUnique(assertStringArray(contract.levels, "contract.levels"), "contract.levels");
  const fieldValueTypes = assertUnique(
    assertStringArray(contract.fieldValueTypes, "contract.fieldValueTypes"),
    "contract.fieldValueTypes",
  );

  const allowedSet = new Set(allowedTopLevel);
  for (const required of requiredTopLevel) {
    if (!allowedSet.has(required)) {
      fail(
        "DIAGNOSTIC_CONTRACT_INVALID",
        "contract.requiredTopLevel",
        `required field is not allowed: ${required}`,
      );
    }
  }
  for (const hostOwned of hostOwnedTopLevel) {
    if (allowedSet.has(hostOwned)) {
      fail(
        "DIAGNOSTIC_CONTRACT_INVALID",
        "contract.hostOwnedTopLevel",
        `host-owned field must not be allowed: ${hostOwned}`,
      );
    }
  }
  const supportedFieldTypes = new Set(["null", "string", "boolean", "number"]);
  for (const fieldType of fieldValueTypes) {
    if (!supportedFieldTypes.has(fieldType)) {
      fail(
        "DIAGNOSTIC_CONTRACT_INVALID",
        "contract.fieldValueTypes",
        `unsupported field value type: ${fieldType}`,
      );
    }
  }
  if (contract.nestedFieldsAllowed !== false) {
    fail(
      "DIAGNOSTIC_CONTRACT_INVALID",
      "contract.nestedFieldsAllowed",
      "nestedFieldsAllowed must be false",
    );
  }

  if (typeof contract.diagnosticSchema !== "string" || contract.diagnosticSchema.length === 0) {
    fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.diagnosticSchema", "diagnosticSchema must be a non-empty string");
  }
  if (!isPlainObject(contract.patterns) || !isPlainObject(contract.limits)) {
    fail("DIAGNOSTIC_CONTRACT_INVALID", "contract", "patterns and limits must be objects");
  }

  if (typeof contract.patterns.code !== "string" || typeof contract.patterns.field !== "string") {
    fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.patterns", "code and field patterns must be strings");
  }

  let codePattern;
  let fieldPattern;
  try {
    codePattern = new RegExp(contract.patterns.code, "u");
    fieldPattern = new RegExp(contract.patterns.field, "u");
  } catch (error) {
    fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.patterns", "patterns must be valid regular expressions", { cause: error });
  }

  const limits = {
    encodedBytes: assertPositiveInteger(contract.limits.encodedBytes, "contract.limits.encodedBytes"),
    codeBytes: assertPositiveInteger(contract.limits.codeBytes, "contract.limits.codeBytes"),
    messageBytes: assertPositiveInteger(contract.limits.messageBytes, "contract.limits.messageBytes"),
    fields: assertPositiveInteger(contract.limits.fields, "contract.limits.fields"),
    fieldNameBytes: assertPositiveInteger(contract.limits.fieldNameBytes, "contract.limits.fieldNameBytes"),
    fieldStringBytes: assertPositiveInteger(contract.limits.fieldStringBytes, "contract.limits.fieldStringBytes"),
  };

  return {
    diagnosticSchema: contract.diagnosticSchema,
    allowedTopLevel: allowedSet,
    requiredTopLevel,
    hostOwnedTopLevel: new Set(hostOwnedTopLevel),
    levels: new Set(levels),
    fieldValueTypes: new Set(fieldValueTypes),
    codePattern,
    fieldPattern,
    limits,
  };
}

function validateToken(value, path, pattern, maxBytes, kind) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`DIAGNOSTIC_${kind}_INVALID`, path, `${path} must be a non-empty string`);
  }
  if (utf8Bytes(value) > maxBytes) {
    fail(`DIAGNOSTIC_${kind}_TOO_LARGE`, path, `${path} exceeds ${maxBytes} UTF-8 bytes`);
  }
  if (!pattern.test(value)) {
    fail(`DIAGNOSTIC_${kind}_INVALID`, path, `${path} does not match the required token pattern`);
  }
}

function canonicalFields(value, compiled) {
  if (!isPlainObject(value)) {
    fail("DIAGNOSTIC_FIELDS_INVALID", "fields", "fields must be a plain object");
  }

  const keys = ownDataKeys(value, "fields");
  if (keys.length > compiled.limits.fields) {
    fail("DIAGNOSTIC_FIELDS_TOO_MANY", "fields", `fields exceeds ${compiled.limits.fields} entries`);
  }

  const fields = {};
  for (const key of keys) {
    validateToken(key, `fields.${key}`, compiled.fieldPattern, compiled.limits.fieldNameBytes, "FIELD_NAME");
    const fieldValue = value[key];

    if (fieldValue === null) {
      if (!compiled.fieldValueTypes.has("null")) {
        fail("DIAGNOSTIC_FIELD_VALUE_INVALID", `fields.${key}`, "null field values are not allowed");
      }
      fields[key] = fieldValue;
      continue;
    }
    if (typeof fieldValue === "boolean") {
      if (!compiled.fieldValueTypes.has("boolean")) {
        fail("DIAGNOSTIC_FIELD_VALUE_INVALID", `fields.${key}`, "boolean field values are not allowed");
      }
      fields[key] = fieldValue;
      continue;
    }
    if (typeof fieldValue === "number") {
      if (!compiled.fieldValueTypes.has("number")) {
        fail("DIAGNOSTIC_FIELD_VALUE_INVALID", `fields.${key}`, "number field values are not allowed");
      }
      if (!Number.isFinite(fieldValue)) {
        fail("DIAGNOSTIC_FIELD_VALUE_INVALID", `fields.${key}`, "number field values must be finite");
      }
      fields[key] = fieldValue;
      continue;
    }
    if (typeof fieldValue === "string") {
      if (!compiled.fieldValueTypes.has("string")) {
        fail("DIAGNOSTIC_FIELD_VALUE_INVALID", `fields.${key}`, "string field values are not allowed");
      }
      if (!isWellFormedUnicode(fieldValue)) {
        fail(
          "DIAGNOSTIC_FIELD_STRING_INVALID_UNICODE",
          `fields.${key}`,
          "string field value must contain well-formed Unicode",
        );
      }
      if (utf8Bytes(fieldValue) > compiled.limits.fieldStringBytes) {
        fail(
          "DIAGNOSTIC_FIELD_STRING_TOO_LARGE",
          `fields.${key}`,
          `string field value exceeds ${compiled.limits.fieldStringBytes} UTF-8 bytes`,
        );
      }
      fields[key] = fieldValue;
      continue;
    }

    fail(
      "DIAGNOSTIC_FIELD_VALUE_INVALID",
      `fields.${key}`,
      "field values must be null, string, boolean, or finite number",
    );
  }
  return fields;
}

export function validateDiagnostic(value, contract) {
  const compiled = readContract(contract);
  if (!isPlainObject(value)) {
    fail("DIAGNOSTIC_NOT_OBJECT", "$", "diagnostic must be a plain object");
  }

  const keys = ownDataKeys(value, "$");
  for (const key of keys) {
    if (!compiled.allowedTopLevel.has(key)) {
      if (compiled.hostOwnedTopLevel.has(key)) {
        fail("DIAGNOSTIC_HOST_FIELD_FORGED", key, `${key} is host-owned and prohibited in diagnostic/1`);
      }
      fail("DIAGNOSTIC_UNKNOWN_FIELD", key, `unknown top-level field: ${key}`);
    }
  }

  for (const key of compiled.requiredTopLevel) {
    if (!Object.hasOwn(value, key)) {
      fail("DIAGNOSTIC_REQUIRED_FIELD_MISSING", key, `missing required field: ${key}`);
    }
  }

  if (value.schema !== compiled.diagnosticSchema) {
    fail(
      "DIAGNOSTIC_SCHEMA_INVALID",
      "schema",
      `schema must be ${compiled.diagnosticSchema}`,
    );
  }

  validateToken(value.code, "code", compiled.codePattern, compiled.limits.codeBytes, "CODE");

  if (typeof value.level !== "string" || !compiled.levels.has(value.level)) {
    fail("DIAGNOSTIC_LEVEL_INVALID", "level", "level must be debug, info, warn, or error");
  }

  if (typeof value.message !== "string" || value.message.trim().length === 0) {
    fail("DIAGNOSTIC_MESSAGE_INVALID", "message", "message must be a non-blank string");
  }
  if (!isWellFormedUnicode(value.message)) {
    fail(
      "DIAGNOSTIC_MESSAGE_INVALID_UNICODE",
      "message",
      "message must contain well-formed Unicode",
    );
  }
  if (utf8Bytes(value.message) > compiled.limits.messageBytes) {
    fail(
      "DIAGNOSTIC_MESSAGE_TOO_LARGE",
      "message",
      `message exceeds ${compiled.limits.messageBytes} UTF-8 bytes`,
    );
  }

  const canonical = {
    schema: compiled.diagnosticSchema,
    code: value.code,
    level: value.level,
    message: value.message,
  };

  if (Object.hasOwn(value, "fields")) {
    canonical.fields = canonicalFields(value.fields, compiled);
  }

  const encoded = `${JSON.stringify(canonical)}\n`;
  if (utf8Bytes(encoded) > compiled.limits.encodedBytes) {
    fail(
      "DIAGNOSTIC_ENCODED_TOO_LARGE",
      "$",
      `encoded diagnostic exceeds ${compiled.limits.encodedBytes} UTF-8 bytes`,
    );
  }

  return canonical;
}

export function encodeDiagnostic(value, contract) {
  return `${JSON.stringify(validateDiagnostic(value, contract))}\n`;
}

export function parseDiagnosticLine(line, contract) {
  if (typeof line !== "string" || line.trim().length === 0) {
    fail("DIAGNOSTIC_JSONL_EMPTY_LINE", "$", "diagnostic JSONL line must not be blank");
  }

  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail("DIAGNOSTIC_JSON_INVALID", "$", "diagnostic line is not valid JSON", { cause: error });
  }
  assertNoDuplicateObjectKeys(line);
  return validateDiagnostic(value, contract);
}

export function canonicalizeDiagnosticJsonl(text, contract) {
  if (typeof text !== "string") {
    fail("DIAGNOSTIC_JSONL_INPUT_INVALID", "$", "diagnostic JSONL input must be text");
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    fail("DIAGNOSTIC_JSONL_EMPTY", "$", "diagnostic JSONL input must contain at least one row");
  }

  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    try {
      values.push(parseDiagnosticLine(lines[index], contract));
    } catch (error) {
      if (error instanceof DiagnosticContractError) {
        throw new DiagnosticContractError(error.code, error.path, error.message, {
          cause: error,
          line: lineNumber,
        });
      }
      throw error;
    }
  }

  return values.map((value) => `${JSON.stringify(value)}\n`).join("");
}
