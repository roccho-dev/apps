import { ARCHITECTURE_INTENT_KIND, ARCHITECTURE_LOCATE_KIND, DECISION_KIND, ERRORS, REQUEST_KIND, isJudgeRequest, isLocateRequest, isRequest, judgeFramesFor, judgeSlotsFor, locateSlotsFor, readAnswers, slotsFor } from "../../src/contract.mjs";
import { questionsFor } from "../../src/judgment.mjs";
import { definedRelation, focusedEvidence, intentSectionOf, judgeSectionOf, readManifest } from "../../src/architecture.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const failures = Object.freeze({
  provider_timeout: [504, ERRORS.providerTimeout],
  provider_http_error: [502, ERRORS.providerError],
  provider_unavailable: [502, ERRORS.providerUnreachable],
  provider_invalid_response: [502, ERRORS.providerContract],
  provider_contract_error: [502, ERRORS.providerContract],
  input_invalid: [502, ERRORS.providerContract],
  cancelled: [502, ERRORS.providerUnreachable],
  auth_missing: [503, ERRORS.unavailable],
});

// The composition supplies a bound operation and nonsecret availability.
// No credential, endpoint, header, model or dynamic loader enters here.
// The prepared source this server was started with, or null: the manifest
// available and the evidence of the very same snapshot.
function boundArchitecture(architecture) {
  const manifest = readManifest(architecture?.manifest ?? null);
  const evidence = architecture?.evidence;
  if (manifest.status !== "available" || evidence?.status !== "available") return null;
  if (evidence.source?.handle !== manifest.source.handle || evidence.source?.commit !== manifest.source.commit) return null;
  // The text of exactly the admitted files, each a string: no file missing,
  // none extra, so a request is never answered from a path without its text.
  const { files } = evidence;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return null;
  const admitted = manifest.entities.filter(entity => entity.kind === "file").map(entity => entity.id).sort();
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(admitted)) return null;
  if (!Object.values(files).every(text => typeof text === "string")) return null;
  return { manifest, files };
}


export async function onRequestPost({ request, available, architecture }, judge) {
  if (available !== true) return json({ error: ERRORS.unavailable }, 503);
  let input;
  try { input = await request.json(); }
  catch { return json({ error: ERRORS.invalidJson }, 400); }
  if (!isRequest(input) && !isLocateRequest(input) && !isJudgeRequest(input)) return json({ error: ERRORS.invalidRequest }, 422);
  const { kind, state } = input;
  let asked = state;
  let slots;
  let questions;
  if (kind === REQUEST_KIND) {
    slots = slotsFor(state);
    questions = questionsFor(state, slots, { kind });
  } else {
    const bound = boundArchitecture(architecture);
    if (bound === null) return json({ error: ERRORS.architectureUnavailable }, 503);
    // A locate frame's part opens the section a judge of it would: null for a part
    // the snapshot does not know, or one that opens no text.
    const opened = kind === ARCHITECTURE_LOCATE_KIND ? judgeSectionOf(bound.manifest, state.architecture.focus) : null;
    const own = kind === ARCHITECTURE_INTENT_KIND ? intentSectionOf(bound.manifest)
      : kind === ARCHITECTURE_LOCATE_KIND ? opened && { source: bound.manifest.source, focus: opened.focus }
        : judgeSectionOf(bound.manifest, state.architecture.focus);
    if (JSON.stringify(state.architecture) !== JSON.stringify(own)) return json({ error: ERRORS.architectureMismatch }, 422);
    // A historical client association is not authenticated past analysis or
    // intended-edge authority. Re-open its section from this exact source;
    // never accept client-written labels, bodies, candidates or descriptors.
    if (state.context !== undefined) {
      const recent = [];
      for (const entry of state.context.recent) {
        const reference = entry.reference;
        const section = reference === null ? null : judgeSectionOf(bound.manifest, reference.focus);
        if (reference !== null && (JSON.stringify(reference.source) !== JSON.stringify(bound.manifest.source) || section === null)) {
          return json({ error: ERRORS.architectureMismatch }, 422);
        }
        recent.push({ ...entry, reference: section });
      }
      asked = { ...state, context: { recent } };
    }
    if (kind === ARCHITECTURE_LOCATE_KIND) {
      const [part] = opened.focus;
      const evidence = focusedEvidence(opened, bound.manifest, bound.files);
      slots = locateSlotsFor([part]);
      questions = questionsFor(state, slots, { kind, entity: bound.manifest.entities.find(entity => entity.id === part), evidence });
      asked = { utterance: state.utterance, context: asked.context, architecture: { ...state.architecture, evidence } };
    } else if (kind === ARCHITECTURE_INTENT_KIND) {
      slots = slotsFor(state);
      questions = questionsFor(state, slots, { kind, relationOf: edge => definedRelation(bound.manifest, edge) });
    } else {
      // A judge asks one frame of this section's own plan: that frame's
      // questions, from that frame's text. Which frame is the page's to say
      // and never the provider's to see.
      const framed = judgeFramesFor(own)?.find(({ frame }) => JSON.stringify(frame) === JSON.stringify(state.frame));
      if (framed === undefined) return json({ error: ERRORS.architectureMismatch }, 422);
      slots = judgeSlotsFor(framed.section);
      questions = questionsFor(state, slots, { kind, section: framed.section });
      asked = { utterance: state.utterance, architecture: { ...framed.section, evidence: focusedEvidence(framed.section, bound.manifest, bound.files) } };
    }
  }
  let result;
  try {
    result = await judge({ state: asked, questions }, { signal: request.signal });
  } catch (error) {
    let failureCode;
    try { failureCode = error?.code; } catch {}
    const [status, code] = typeof failureCode === "string" && Object.hasOwn(failures, failureCode)
      ? failures[failureCode] : [502, ERRORS.providerUnreachable];
    return json({ error: code }, status);
  }
  // Application slots are checked again independently of generic provider
  // validation. Action thresholds remain in turn/application, never HTTP 502.
  const normalized = result?.answers;
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) return json({ error: ERRORS.providerContract }, 502);
  if (Object.values(normalized).some(answer => answer === null || typeof answer !== "object" || Array.isArray(answer)
    || Object.keys(answer).some(name => !["choice", "confidence", "probabilities"].includes(name)))) return json({ error: ERRORS.providerContract }, 502);
  const typed = Object.fromEntries(Object.entries(normalized).map(([name, answer]) => [name, { ...answer, type: "choice" }]));
  const answers = readAnswers(typed, slots);
  if (answers === null) return json({ error: ERRORS.providerContract }, 502);
  return json({ kind: DECISION_KIND, answers });
}
