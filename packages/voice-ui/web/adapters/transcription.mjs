// Only the selected concrete binding loads/probes Hayamimi. Fake bindings have
// no dependency on this module, its provider, service worker, model or network.
const prepareChunks = async () => {
  const manifest = await fetch("/hayamimi/sherpa/data.parts.json", { cache: "no-store" });
  await manifest.arrayBuffer();
  if (manifest.status === 204) return;
  if (!manifest.ok || !("serviceWorker" in navigator)) throw new Error("transcription_unavailable");
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
};
const load = async () => (await import("/hayamimi/runtime/api/hayamimi.mjs")).createHayamimi();
const transcriptionError = code => Object.assign(new Error(code), { code });
export const createTranscription = ({ loadRecognizer = load, prepare = prepareChunks } = {}) => {
  let prepared;
  return ({ onListening = () => {}, signal } = {}) => new Promise((resolve, reject) => {
    let settled = false;
    let owned;
    let timer;
    const stop = async () => {
      if (!owned) return;
      owned.onText = null;
      try { await owned.stop(); } finally { await owned.close?.(); }
    };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const finish = async (value, code = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { await stop(); }
      catch { reject(transcriptionError("transcription_stop_failed")); return; }
      if (code !== null) reject(transcriptionError(code)); else resolve(value);
    };
    const cancel = () => { void finish(null, "transcription_cancelled"); };
    timer = setTimeout(() => { void finish(null, "transcription_timeout"); }, 300000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    // All task promises are observed. A late prepare/start/text cannot adopt a
    // result after timeout/cancel; a late-created recognizer is stopped as well.
    void (async () => {
      prepared ??= prepare();
      await prepared;
      if (settled) return;
      owned ??= await loadRecognizer();
      if (settled) { await stop(); return; }
      owned.onText = value => { void finish(value, typeof value === "string" ? null : "transcription_invalid_text"); };
      await owned.start();
      if (settled) { await stop(); return; }
      onListening();
    })().catch(() => { void finish(null, "transcription_failed"); });
  });
};
