import { textToUiIr } from "./decision/jev.mjs";
import { typeToText } from "./input/type.mjs";
import { voiceToText } from "./input/voice.mjs";

function requireFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
}

export function createVoiceUiApp({ transcribe, decide, render } = {}) {
  requireFunction("transcribe", transcribe);
  requireFunction("decide", decide);
  requireFunction("render", render);

  const run = async (text) => render(await textToUiIr(text, decide));

  return Object.freeze({
    submitType(value) {
      return run(typeToText(value));
    },

    async submitVoice(audio) {
      return run(await voiceToText(audio, transcribe));
    },
  });
}
