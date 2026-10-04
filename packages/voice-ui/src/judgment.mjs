import { ACTION_ADD_EDGE, ACTION_ADD_PART, ACTION_ARCHITECTURE, ACTION_COMPOSE, ACTION_PLACE_PART, ACTION_REMOVE_EDGE, ACTION_REVERSE_EDGE, ACTION_UNDO_REQUEST, ARCHITECTURE_INTENT_KIND, ARCHITECTURE_JUDGE_KIND, ARCHITECTURE_LOCATE_KIND, NONE, WHOLE, YES, relationSlot, relevantSlot, roleSlot } from "./contract.mjs";

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
const REFERENCE_NOTE = " An architecture conversation entry may carry reference: the server reopened its section from the current source."
  + " The historical association with that utterance is still unverified, not proof of its intent or of a unique edge."
  + " Use the earlier utterance together with that section's entities and candidate relationships to understand an anaphoric qualification."
  + " Do not replace an explicit endpoint or semantic qualification with the latest analysis, camera selection or edit focus."
  + " Match against all current edges; if the conversational qualification does not identify one unique edge, answer none.";

// The questions for exactly the slots the request offers. Each option is a
// key the request carries; the words around it are this Function's own, and
// every product word - a part's or a diagram's purpose - comes from the
// request's offers. `defined` says what the server's own snapshot defines an
// edge as, or null: an architecture intent passes it, and a plain request,
// which has no snapshot, describes every edge by its two ends only.
export function questionsFor(state, slots, context) {
  if (state.candidates !== undefined) {
    const purposes = new Map(state.offers.parts.map(part => [part.key, part.purpose]));
    const parents = new Map(state.parents.map(parent => [parent.id, parent]));
    const labels = new Map(state.graph.map(region => [region.id, region.label]));
    return {
      delta: {
        instruction: "Choose one executable change toward the utterance's goal. A candidate adds one offered part inside its existing group at a proved placement, or connects two existing parts by one directed flow arrow. selected is actual adopted part history, not a goal oracle. Choose none when no candidate is clearly needed or the request is ambiguous. Do not create or move groups.",
        options: criteria(slots.delta, key => {
          if (key === NONE) return "no offered executable change is clearly requested";
          const candidate = state.candidates.find(item => item.id === key);
          if (candidate.action === ACTION_ADD_EDGE) return `a directed flow arrow from ${labels.get(candidate.from)} (${candidate.from}) to ${labels.get(candidate.to)} (${candidate.to})`;
          return `${purposes.get(candidate.part)} inside ${parents.get(candidate.parent).label} (${candidate.parent})`;
        }),
      },
    };
  }
  if (context.kind === ARCHITECTURE_LOCATE_KIND) return locateQuestion(context.entity, context.evidence, slots);
  if (context.kind === ARCHITECTURE_JUDGE_KIND) return judgeQuestions(context.section, slots);
  const defined = context.kind === ARCHITECTURE_INTENT_KIND ? context.relationOf : () => null;
  const labelOf = new Map(state.graph.regions.map(region => [region.id, region.label]));
  const node = key => labelOf.get(key) === key ? key : `${key} (shown as "${labelOf.get(key)}")`;
  const definedAs = edge => {
    const relation = defined(edge);
    return relation === null ? "" : `, which this snapshot defines as ${relation.kind}${relation.purpose === null ? "" : `: ${relation.purpose}`}`;
  };
  const questions = {
    action: {
      instruction: "Which change to the working graph does the utterance ask for? "
        + "A reference qualified by endpoints or semantic description refers to matching current graph candidates, not the focus. "
        + "Only a bare, unqualified reference such as \"that edge\" may use the focus. "
        + "A clear remove or reverse request still names that action when its edge is unresolved; answer none for the edge.",
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
    // Existing candidate descriptions resolve qualified references first.
    // Edit focus is evidence only for a bare, unqualified reference.
    questions.edge = {
      instruction: "If the utterance asks to remove or reverse an edge, which edge of the working graph does it mean? "
        + "If it identifies an edge by its endpoints or its semantic description, match that qualification against the offered edges, "
        + "using their current node labels and any snapshot-defined kind or purpose. Choose the matching edge only if it is unique; "
        + "For a description of what a relationship does, compare the relationship itself, not merely a related endpoint label: "
        + "membership in a role and interaction with another part are different relationships. "
        + "An explicit identification by endpoints remains valid, including endpoints named by their displayed labels. "
        + "if no edge or more than one edge matches, answer none. In particular, never use focus to override a qualification. "
        + "Only a bare, unqualified reference (for example \"that edge\") may use the edge the focus describes; "
        + "if it identifies no unique current edge, answer none. Do not pick an edge just because it is the only edge.",
      options: criteria(slots.edge, key => key === NONE
        ? "no unique edge matches the qualified reference, or no unqualified reference identifies a current edge"
        : `the edge from ${node(byId.get(key).from)} to ${node(byId.get(key).to)}${definedAs(byId.get(key))}`),
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
  if (slots.focus) {
    const labelOf = new Map(state.architecture.entities.map(entity => [entity.id, entity.label]));
    questions.focus = {
      instruction: "If the utterance asks how this code is built, does it ask for the code as a whole, "
        + "or which one part of it does it ask to see in more detail? "
        + "state.architecture.entities names each part by its file path or, for what lies outside the source, "
        + "by the identifier or URL the source uses for it.",
      options: criteria(slots.focus, key => (key === WHOLE
        ? "the code as a whole"
        : key === NONE
          ? "neither one part nor the whole is clear, or it asks for neither"
          : `the part ${labelOf.get(key)}`)),
    };
  }
  for (const question of Object.values(questions)) question.instruction += CONTEXT_NOTE
    + (context.kind === ARCHITECTURE_INTENT_KIND ? REFERENCE_NOTE : "");
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
        instruction: `Does the file ${labelOf.get(body)}, whose whole text is in state.architecture.evidence.bodies, ${role.purpose}?${EVIDENCE_NOTE}`,
        options: criteria(slots[roleSlot(body, role.key)], key => key === YES
          ? `yes: its own text shows that it ${role.purpose}`
          : "no, or its text does not show it"),
      };
    }
  }
  const relationWords = new Map(section.relations.map(relation => [relation.key, relation.purpose]));
  for (const candidate of section.candidates) {
    questions[relationSlot(candidate.id)] = {
      instruction: `From ${labelOf.get(candidate.from)} to ${labelOf.get(candidate.to)} (a candidate pair because of: ${candidate.reasons.join(", ")}):`
        + ` which relation holds at run time from the first to the second? Being a candidate is not evidence of any relation.${EVIDENCE_NOTE}`,
      options: criteria(slots[relationSlot(candidate.id)], key => key === NONE
        ? "no relation of these kinds holds, or the text does not show one"
        : relationWords.get(key)),
    };
  }
  return questions;
}

// A locate frame's one question, judged from its part's own text - the files
// it opens whole, and single lines of other files that name it - which the
// question names by path, since the provider never sees the question's name.
// For a file: whether its own text does or declares what the utterance is
// about. For a part outside the source: whether the shown code uses it for
// that. The utterance need not name the part; the options say where the line
// falls.
function locateQuestion(entity, evidence, slots) {
  const file = entity.kind === "file";
  const lined = [...new Set(evidence.lines.map(line => line.path))];
  return {
    [relevantSlot(entity.id)]: {
      instruction: (file
        ? `Does the original text of the file ${entity.label} implement behaviour, or declare data, that the current utterance asks about or refers to?`
        : `Does the shown original code use ${entity.label}, which lies outside the source, for behaviour or data that the current utterance asks about or refers to?`)
        + ` state.architecture.evidence.bodies holds ${evidence.bodies.map(body => body.path).join(", ")} whole`
        + (lined.length === 0 ? "." : `; state.architecture.evidence.lines holds single lines of ${lined.join(", ")}, each with its path and line number.`)
        + " Judge only from that text and the utterance."
        + CONTEXT_NOTE + REFERENCE_NOTE,
      options: criteria(slots[relevantSlot(entity.id)], key => (file
        ? key === YES
          ? "its own text implements that behaviour or declares that data, whether or not the utterance names the file"
          : "its text does not, even if it mentions or imports another part that does"
        : key === YES
          ? "the shown code uses it for that behaviour or data, whether or not the utterance names it"
          : "the shown code does not use it for that, or only names it")),
    },
  };
}
