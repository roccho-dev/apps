import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceUiApp } from "../src/app.mjs";

test("typed input flows through Jev and renderer without owning either implementation", async () => {
  const calls = [];
  const ir = Object.freeze({ kind: "typed-ui-ir.test" });

  const app = createVoiceUiApp({
    transcribe() {
      throw new Error("typed path must not transcribe");
    },
    async decide(text) {
      calls.push(["decide", text]);
      return ir;
    },
    async render(value) {
      calls.push(["render", value]);
      return "rendered";
    },
  });

  assert.equal(await app.submitType("hello"), "rendered");
  assert.deepEqual(calls, [["decide", "hello"], ["render", ir]]);
});

test("voice input delegates voice-to-text before the same decision path", async () => {
  const calls = [];
  const audio = Object.freeze({ sample: true });
  const ir = Object.freeze({ kind: "typed-ui-ir.test" });

  const app = createVoiceUiApp({
    async transcribe(value) {
      calls.push(["transcribe", value]);
      return "spoken";
    },
    async decide(text) {
      calls.push(["decide", text]);
      return ir;
    },
    async render(value) {
      calls.push(["render", value]);
      return "rendered";
    },
  });

  assert.equal(await app.submitVoice(audio), "rendered");
  assert.deepEqual(calls, [
    ["transcribe", audio],
    ["decide", "spoken"],
    ["render", ir],
  ]);
});

test("composition dependencies are required instead of being reimplemented", () => {
  assert.throws(() => createVoiceUiApp(), /transcribe must be a function/);
  assert.throws(
    () => createVoiceUiApp({ transcribe() {} }),
    /decide must be a function/,
  );
  assert.throws(
    () => createVoiceUiApp({ transcribe() {}, decide() {} }),
    /render must be a function/,
  );
});

test("voice boundary fails closed when runtime does not return text", async () => {
  const app = createVoiceUiApp({
    async transcribe() {
      return { unexpected: true };
    },
    async decide() {
      throw new Error("must not decide invalid transcript");
    },
    async render() {
      throw new Error("must not render invalid transcript");
    },
  });

  await assert.rejects(app.submitVoice({}), /Hayamimi must return text/);
});
