export function typeToText(value) {
  if (typeof value !== "string") {
    throw new TypeError("type input must be text");
  }
  return value;
}
