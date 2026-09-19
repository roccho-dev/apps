export async function textToUiIr(text, decide) {
  if (typeof decide !== "function") {
    throw new TypeError("decide must be a function");
  }
  return decide(text);
}
