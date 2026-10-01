import {
  ACTION_ADD_EDGE,
  ACTION_ADD_PART,
  ACTION_COMPOSE,
  ACTION_PLACE_PART,
  ACTION_REMOVE_EDGE,
  ACTION_REVERSE_EDGE,
  ACTION_UNDO_REQUEST,
  NONE,
} from "./contract.mjs";


// Application-owned questions and option meaning; no provider wire fields.
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
export function questionsFor(state, slots) {
  const labelOf = new Map(state.graph.regions.map(region => [region.id, region.label]));
  const node = key => labelOf.get(key) === key ? key : `${key} (shown as "${labelOf.get(key)}")`;
  const questions = {
    action: {
      instruction: "Which change to the working graph does the utterance ask for? "
        + "A follow-up such as \"that\" refers to the focus.",
      options: criteria(slots.action, action => ACTION_WORDS[action]),
    },
  };
  if (slots.source) {
    questions.source = {
      instruction: "If the utterance asks to add an edge, which node of the working graph does it start at?",
      options: criteria(slots.source, key => key === NONE
        ? "the utterance names no node of the working graph as the start"
        : `the edge starts at ${node(key)}`),
    };
    questions.target = {
      instruction: "If the utterance asks to add an edge, which node of the working graph does it end at?",
      options: criteria(slots.target, key => key === NONE
        ? "the utterance names no node of the working graph as the end"
        : `the edge ends at ${node(key)}`),
    };
  }
  if (slots.part) {
    const purposeOf = new Map(state.offers.parts.map(offer => [offer.key, offer.purpose]));
    questions.part = {
      instruction: "If the utterance asks to add a new part to the graph, which of state.offers.parts is it?",
      options: criteria(slots.part, key => key === NONE
        ? "the utterance asks for no new part, or names a kind that is not offered"
        : `the utterance asks for ${purposeOf.get(key)}`),
    };
  }
  if (slots.move) {
    questions.move = {
      instruction: "If the utterance asks to move a part next to another one, which part is being moved?",
      options: criteria(slots.move, key => key === NONE ? "the utterance asks to move no part" : `the part ${node(key)} is the one being moved`),
    };
    questions.anchor = {
      instruction: "If the utterance asks to move a part next to another one, which part is it being put beside?",
      options: criteria(slots.anchor, key => key === NONE ? "the utterance names no part to put it beside" : `it is put beside the part ${node(key)}`),
    };
    questions.direction = {
      instruction: "If the utterance asks to move a part next to another one, which side of that part does it go?",
      options: criteria(slots.direction, key => key === NONE ? "the utterance names no side" : `it goes to the ${key} of the other part`),
    };
    // The previous utterance nearly placed a part and lacked only this piece.
    // Say so on that one question, and leave every other question as it is,
    // so a complete or unrelated instruction is judged exactly as without it.
    if (state.pending !== null) {
      questions[state.pending.missing] = {
        ...questions[state.pending.missing],
        instruction: questions[state.pending.missing].instruction
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
      instruction: "If the utterance asks to remove or reverse an edge, which edge of the working graph does it mean? "
        + "If it names the edge by its two nodes, choose that edge. "
        + "Only if it names no edge and refers to one (for example \"that edge\"), choose the edge the focus describes.",
      options: criteria(slots.edge, key => key === NONE
        ? "the utterance refers to no edge of the working graph"
        : `the edge from ${node(byId.get(key).from)} to ${node(byId.get(key).to)}`),
    };
  }
  if (slots.diagram) {
    const purposeOf = new Map(state.offers.diagrams.map(offer => [offer.key, offer.purpose]));
    questions.diagram = {
      instruction: "If the utterance asks for a whole diagram or chart by what it is for, which of state.offers.diagrams is it? "
        + "Choose one only if its purpose is what the utterance asks for; "
        + "if it asks for a kind of diagram that is not among them, answer none.",
      options: criteria(slots.diagram, key => key === NONE
        ? "the utterance asks for no whole diagram, or for a kind of diagram that is not among the offered ones"
        : `the utterance asks for ${purposeOf.get(key)}`),
    };
  }
  for (const question of Object.values(questions)) question.instruction += CONTEXT_NOTE;
  return questions;
}
