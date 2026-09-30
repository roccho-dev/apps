import {
  ACTION_ADD_EDGE,
  ACTION_ADD_PART,
  ACTION_ARCHITECTURE,
  ACTION_COMPOSE,
  ACTION_PLACE_PART,
  ACTION_REMOVE_EDGE,
  ACTION_REVERSE_EDGE,
  ACTION_UNDO_REQUEST,
  ARCHITECTURE_INTENT_KIND,
  ARCHITECTURE_LOCATE_KIND,
  DECISION_KIND,
  ERRORS,
  NONE,
  REQUEST_KIND,
  WHOLE,
  YES,
  isJudgeRequest,
  isLocateRequest,
  isRequest,
  judgeSlotsFor,
  locateSlotsFor,
  readAnswers,
  relationSlot,
  relevantSlot,
  roleSlot,
  slotsFor,
} from "../../src/contract.mjs";
import { focusedEvidence, intentSectionOf, judgeSectionOf, readManifest } from "../../src/architecture.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

// How long the provider gets to answer, headers and body together. Measured on
// 2026-09-24 through the dev server against the live provider, 56 calls:
// median about 0.3 s, slowest 0.92 s, and 0.65-0.81 s for a first call after an
// idle gap. Ten seconds is more than ten times the slowest; a provider that has
// not answered by then is treated as not answering, and the page is told so
// rather than left waiting.
const PROVIDER_TIMEOUT_MS = 10000;

// Returns the provider's body text, or the error response to send instead.
const callProvider = async (env, body) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const provider = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.JEV_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!provider.ok) return { error: json({ error: ERRORS.providerError }, 502) };
    return { text: await provider.text() };
  } catch {
    return controller.signal.aborted
      ? { error: json({ error: ERRORS.providerTimeout }, 504) }
      : { error: json({ error: ERRORS.providerUnreachable }, 502) };
  } finally {
    clearTimeout(timer);
  }
};

// A choice question offers its alternatives as a criteria map keyed by the
// value to be returned.
const criteria = (keys, describe) => Object.fromEntries(keys.map(key => [key, describe(key)]));

const ACTION_WORDS = {
  [ACTION_ADD_EDGE]: "the utterance asks to add one directed edge between two nodes of the working graph",
  [ACTION_ADD_PART]: "the utterance asks to add one new part, node, box or step to the graph itself",
  [ACTION_PLACE_PART]: "the utterance asks to move one part next to another one - beside, above or below it",
  [ACTION_REMOVE_EDGE]: "the utterance asks to remove one edge of the working graph",
  [ACTION_REVERSE_EDGE]: "the utterance asks to reverse the direction of one edge of the working graph",
  [ACTION_UNDO_REQUEST]: "the utterance asks to undo, take back or go back on an earlier change",
  [ACTION_COMPOSE]: "the utterance asks for a whole diagram or chart by what it is for, rather than one edit",
  [ACTION_ARCHITECTURE]: "the utterance asks for a diagram of how this code is built, or for more detail on one part of it",
  [NONE]: "the utterance asks for anything else, or for no change to the graph",
};

// Every question is told what the recent conversation is and is not: it may
// explain what a word in the utterance refers to, but it is unverified, and
// the utterance, the working graph and the focus decide.
const CONTEXT_NOTE = " context.recent lists earlier utterances as they were recognized or typed, and what came of each."
  + " They are unverified and may be misrecognized. Use them only to understand what the current utterance refers to;"
  + " the current utterance, the working graph and the focus are the facts, and an earlier effect is history, not the current graph.";

// The questions for exactly the slots the request offers. Each option is a
// key the request carries; the words around it are this Function's own, and
// every product word - a part's or a diagram's purpose - comes from the
// request's offers.
function questionsFor(state, slots) {
  const labelOf = new Map(state.graph.regions.map(region => [region.id, region.label]));
  const node = key => labelOf.get(key) === key ? key : `${key} (shown as "${labelOf.get(key)}")`;
  const questions = {
    action: {
      type: "choice",
      instructions: "Which change to the working graph does the utterance ask for? "
        + "A follow-up such as \"that\" refers to the focus.",
      criteria: criteria(slots.action, action => ACTION_WORDS[action]),
    },
  };
  if (slots.source) {
    questions.source = {
      type: "choice",
      instructions: "If the utterance asks to add an edge, which node of the working graph does it start at?",
      criteria: criteria(slots.source, key => key === NONE
        ? "the utterance names no node of the working graph as the start"
        : `the edge starts at ${node(key)}`),
    };
    questions.target = {
      type: "choice",
      instructions: "If the utterance asks to add an edge, which node of the working graph does it end at?",
      criteria: criteria(slots.target, key => key === NONE
        ? "the utterance names no node of the working graph as the end"
        : `the edge ends at ${node(key)}`),
    };
  }
  if (slots.part) {
    const purposeOf = new Map(state.offers.parts.map(offer => [offer.key, offer.purpose]));
    questions.part = {
      type: "choice",
      instructions: "If the utterance asks to add a new part to the graph, which of state.offers.parts is it?",
      criteria: criteria(slots.part, key => key === NONE
        ? "the utterance asks for no new part, or names a kind that is not offered"
        : `the utterance asks for ${purposeOf.get(key)}`),
    };
  }
  if (slots.move) {
    questions.move = {
      type: "choice",
      instructions: "If the utterance asks to move a part next to another one, which part is being moved?",
      criteria: criteria(slots.move, key => key === NONE ? "the utterance asks to move no part" : `the part ${node(key)} is the one being moved`),
    };
    questions.anchor = {
      type: "choice",
      instructions: "If the utterance asks to move a part next to another one, which part is it being put beside?",
      criteria: criteria(slots.anchor, key => key === NONE ? "the utterance names no part to put it beside" : `it is put beside the part ${node(key)}`),
    };
    questions.direction = {
      type: "choice",
      instructions: "If the utterance asks to move a part next to another one, which side of that part does it go?",
      criteria: criteria(slots.direction, key => key === NONE ? "the utterance names no side" : `it goes to the ${key} of the other part`),
    };
    // The previous utterance nearly placed a part and lacked only this piece.
    // Say so on that one question, and leave every other question as it is,
    // so a complete or unrelated instruction is judged exactly as without it.
    if (state.pending !== null) {
      questions[state.pending.missing] = {
        ...questions[state.pending.missing],
        instructions: questions[state.pending.missing].instructions
          + " state.pending is a placement the previous utterance nearly made, lacking only this piece."
          + " If the utterance only supplies this piece for it - for example by naming just a part or a side -"
          + " answer with that. Otherwise answer from the utterance as usual.",
      };
    }
  }
  if (slots.edge) {
    const byId = new Map(state.graph.edges.map(edge => [edge.id, edge]));
    // An edge the utterance names by its two nodes wins. The focus only
    // resolves a reference such as "that edge" when no edge is named.
    questions.edge = {
      type: "choice",
      instructions: "If the utterance asks to remove or reverse an edge, which edge of the working graph does it mean? "
        + "If it names the edge by its two nodes, choose that edge. "
        + "Only if it names no edge and refers to one (for example \"that edge\"), choose the edge the focus describes.",
      criteria: criteria(slots.edge, key => key === NONE
        ? "the utterance refers to no edge of the working graph"
        : `the edge from ${node(byId.get(key).from)} to ${node(byId.get(key).to)}`),
    };
  }
  if (slots.diagram) {
    const purposeOf = new Map(state.offers.diagrams.map(offer => [offer.key, offer.purpose]));
    questions.diagram = {
      type: "choice",
      instructions: "If the utterance asks for a whole diagram or chart by what it is for, which of state.offers.diagrams is it? "
        + "Choose one only if its purpose is what the utterance asks for; "
        + "if it asks for a kind of diagram that is not among them, answer none.",
      criteria: criteria(slots.diagram, key => key === NONE
        ? "the utterance asks for no whole diagram, or for a kind of diagram that is not among the offered ones"
        : `the utterance asks for ${purposeOf.get(key)}`),
    };
  }
  if (slots.focus) {
    const labelOf = new Map(state.architecture.entities.map(entity => [entity.id, entity.label]));
    questions.focus = {
      type: "choice",
      instructions: "If the utterance asks how this code is built, does it ask for the code as a whole, "
        + "or which one part of it does it ask to see in more detail? "
        + "state.architecture.entities names each part by its file path or, for what lies outside the source, "
        + "by the identifier or URL the source uses for it.",
      criteria: criteria(slots.focus, key => (key === WHOLE
        ? "the code as a whole"
        : key === NONE
          ? "neither one part nor the whole is clear, or it asks for neither"
          : `the part ${labelOf.get(key)}`)),
    };
  }
  for (const question of Object.values(questions)) question.instructions += CONTEXT_NOTE;
  return questions;
}

// A judge's questions: for each body file, whether it has each role; for each
// pair, which relation holds, if any. Every answer rests only on the text
// this Function adds: whole body files, and single lines of other files.
const EVIDENCE_NOTE = " state.architecture.evidence.bodies holds whole files, each with its path;"
  + " state.architecture.evidence.lines holds single lines of other files, each with its path and line number, and nothing around them."
  + " A part with no text there is known only by its name. Judge only from that text; if it does not show the answer, answer none.";

function judgeQuestions(section, slots) {
  const labelOf = new Map(section.entities.map(entity => [entity.id, entity.label]));
  const questions = {};
  for (const body of section.bodies) {
    for (const role of section.roles) {
      questions[roleSlot(body, role.key)] = {
        type: "choice",
        instructions: `Does the file ${labelOf.get(body)}, whose whole text is in state.architecture.evidence.bodies, ${role.purpose}?${EVIDENCE_NOTE}`,
        criteria: criteria(slots[roleSlot(body, role.key)], key => key === YES
          ? `yes: its own text shows that it ${role.purpose}`
          : "no, or its text does not show it"),
      };
    }
  }
  const relationWords = new Map(section.relations.map(relation => [relation.key, relation.purpose]));
  for (const candidate of section.candidates) {
    questions[relationSlot(candidate.id)] = {
      type: "choice",
      instructions: `From ${labelOf.get(candidate.from)} to ${labelOf.get(candidate.to)} (a candidate pair because of: ${candidate.reasons.join(", ")}):`
        + ` which relation holds at run time from the first to the second? Being a candidate is not evidence of any relation.${EVIDENCE_NOTE}`,
      criteria: criteria(slots[relationSlot(candidate.id)], key => key === NONE
        ? "no relation of these kinds holds, or the text does not show one"
        : relationWords.get(key)),
    };
  }
  return questions;
}

// A locate's questions: for every part the snapshot knows, whether the
// utterance asks for it, judged from every admitted file's whole text - a
// part outside the source only by how those files use it.
const LOCATE_NOTE = " state.architecture.evidence.bodies holds every admitted source file whole, each with its path;"
  + " a part outside the source has no file there and is known only by how those files use it."
  + " Judge only from that text and the utterance; if they do not show it, answer none.";

function locateQuestions(manifest, slots) {
  const questions = {};
  for (const entity of manifest.entities) {
    const part = entity.kind === "file" ? `the file ${entity.label}` : `${entity.label}, outside the source`;
    questions[relevantSlot(entity.id)] = {
      type: "choice",
      instructions: `Does the utterance ask to see ${part}, as it is actually used in this original code?${LOCATE_NOTE}${CONTEXT_NOTE}`,
      criteria: criteria(slots[relevantSlot(entity.id)], key => key === YES
        ? "yes: the utterance asks for this part, as the code shows it"
        : "no, or the code does not show that the utterance asks for it"),
    };
  }
  return questions;
}

// The prepared source this server was started with, or null: the manifest
// available and the evidence of the very same snapshot.
function boundArchitecture(env) {
  const manifest = readManifest(env?.ARCHITECTURE?.manifest ?? null);
  const evidence = env?.ARCHITECTURE?.evidence;
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

// The request kinds in, one answer kind out, and a closed set of failures.
// The state is sent to Jev as the named object it arrived as; the questions
// carry only the judgments. An architecture request must name exactly this
// server's own snapshot, or it is refused before the provider is asked: an
// intent is sent as it came, with no code; a locate is sent with every
// admitted file's text added here; a judge is sent with its section's text
// added here. That text is never sent back.
export async function onRequestPost({ request, env }) {
  if (typeof env?.JEV_API_KEY !== "string" || env.JEV_API_KEY.length === 0) {
    return json({ error: ERRORS.unavailable }, 503);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: ERRORS.invalidJson }, 400);
  }
  if (!isRequest(input) && !isLocateRequest(input) && !isJudgeRequest(input)) return json({ error: ERRORS.invalidRequest }, 422);

  const { kind, state } = input;
  let asked = state;
  let slots;
  let questions;
  if (kind === REQUEST_KIND) {
    slots = slotsFor(state);
    questions = questionsFor(state, slots);
  } else {
    const bound = boundArchitecture(env);
    if (bound === null) return json({ error: ERRORS.architectureUnavailable }, 503);
    const own = kind === ARCHITECTURE_INTENT_KIND ? intentSectionOf(bound.manifest)
      : kind === ARCHITECTURE_LOCATE_KIND ? { source: bound.manifest.source }
        : judgeSectionOf(bound.manifest, state.architecture.focus);
    if (JSON.stringify(state.architecture) !== JSON.stringify(own)) return json({ error: ERRORS.architectureMismatch }, 422);
    if (kind === ARCHITECTURE_LOCATE_KIND) {
      // Every part the snapshot knows is asked about; every admitted file is
      // shown whole, and nothing is shown for what lies outside the source.
      slots = locateSlotsFor(bound.manifest.entities.map(entity => entity.id));
      questions = locateQuestions(bound.manifest, slots);
      const bodies = bound.manifest.entities.filter(entity => entity.kind === "file")
        .map(entity => ({ path: entity.path, text: bound.files[entity.id] }));
      asked = { ...state, architecture: { ...state.architecture, evidence: { bodies } } };
    } else if (kind === ARCHITECTURE_INTENT_KIND) {
      slots = slotsFor(state);
      questions = questionsFor(state, slots);
    } else {
      slots = judgeSlotsFor(own);
      questions = judgeQuestions(own, slots);
      asked = { ...state, architecture: { ...own, evidence: focusedEvidence(own, bound.manifest, bound.files) } };
    }
  }
  const { text, error } = await callProvider(env, { model: "jev-latest", state: asked, questions });
  if (error) return error;

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return json({ error: ERRORS.providerContract }, 502);
  }
  const answers = readAnswers(value?.answers, slots);
  if (typeof value?.model !== "string" || answers === null) return json({ error: ERRORS.providerContract }, 502);

  return json({ kind: DECISION_KIND, model: value.model, answers });
}
