export async function voiceToText(audio, transcribe) {
  if (typeof transcribe !== "function") {
    throw new TypeError("transcribe must be a function");
  }

  const text = await transcribe(audio);
  if (typeof text !== "string") {
    throw new TypeError("Hayamimi must return text");
  }
  return text;
}
