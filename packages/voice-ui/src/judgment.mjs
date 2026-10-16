import { ACTION_ADD_EDGE, ACTION_ADD_PART, ACTION_ARCHITECTURE, ACTION_COMPOSE, ACTION_PLACE_PART, ACTION_REMOVE_EDGE, ACTION_REVERSE_EDGE, ACTION_UNDO_REQUEST, ARCHITECTURE_GOAL_INTENT_KIND, ARCHITECTURE_INTENT_KIND, ARCHITECTURE_JUDGE_KIND, ARCHITECTURE_LOCATE_KIND, NONE, WHOLE, YES, partOption, relationSlot, relevantSlot, roleSlot } from "./contract.mjs";

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
  [ACTION_COMPOSE]: "the utterance asks for one of the prepared diagrams in state.offers.diagrams, as a whole, by what it is for, rather than one edit",
  [ACTION_ARCHITECTURE]: "the utterance asks for a diagram of how the code of this application, given in state.architecture, is built, or for more detail on one part of it",
  [NONE]: "the utterance asks for anything else, or for no change to the graph",
};

// Every question is told what the recent conversation is and is not: it may
// explain what a word in the utterance refers to, but it is unverified, and
// the utterance, the working graph and the focus decide.
const RECENT_NOTE = " context.recent lists earlier utterances as they were recognized or typed, and what came of each."
  + " They are unverified and may be misrecognized. Use them only to understand what the current utterance refers to;";
const CONTEXT_NOTE = RECENT_NOTE
  + " the current utterance, the working graph and the focus are the facts, and an earlier effect is history, not the current graph.";
// A locate frame reads no working graph, and its focus is the asked part itself.
const LOCATE_CONTEXT_NOTE = RECENT_NOTE
  + " the current utterance and the shown text are the facts; any earlier outcome is history, not evidence this part is asked about.";
// Goal has its own read set: graph and edges, never an editing focus.
const GOAL_CONTEXT_NOTE = " context.recent lists earlier utterances as they were recognized or typed, and what came of each."
  + " They are unverified and may be misrecognized. Use them only to understand what the current utterance refers to;"
  + " the current utterance, the current Working graph and edges are the facts, and an earlier effect is history, not the current graph.";
// A Goal step is asked in up to two frames. The first asks what comes next:
// a part, whose group a second frame asks, or an arrow between existing parts.
const GOAL_WHAT = "Choose the next executable change toward the utterance's goal. An option either adds one offered part, whose group is chosen by a separate following question, or connects two existing parts by one directed flow arrow. An explicitly hypothetical requested connection is a Working proposal, not proof of an existing source relationship. Use the current graph and edges to decide which requested changes are still missing; selected is adopted part history, not a completion oracle. An arrow is offered only when both of its ends exist, so a requested part that is still missing comes before its arrows. Choose none when the requested changes are already present, no option is clearly needed, or the request is ambiguous. Do not add a connection merely because two parts are present; it must be requested by the utterance. An offered group part is added like any other part, and a part is placed only into an existing group, including one this goal already added, so a requested group that is still missing comes before the parts requested inside it."
  + " Explicitly requested display names must match the added part's displayed name; do not substitute a generic name merely because its purpose or kind matches. Count already present matching instances in the requested parent before adding another; distinct candidate keys with the same label permit repeated instances, and each key is usable once.";
// The second frame, bound to the part the first chose, asks only where it goes.
const GOAL_WHERE = "Which existing group does the utterance request this part to be added inside? A group already added by this goal is also an existing group here. Arrows may connect parts in different groups, so a part's group does not follow from the groups of the parts it is connected to. Choose none when the utterance requests none of these existing groups for it, or does not identify a unique one.";
// A Goal's scope is checked by the server, not taken from the page on trust.
const SCOPE_NOTE = " state.scope names the parts in focus, which the server matched against the current source;"
  + " every offered arrow touches one of them. It is not an earlier judgment or authority, and no source text is given."
  + " state.graph and state.edges may then be only a local view - the ends of the offered arrow, the groups enclosing them and"
  + " the relations between those two ends - not the whole working graph, and not a completion oracle.";
const REFERENCE_NOTE = " An architecture conversation entry may carry reference: the server reopened its section from the current source."
  + " The historical association with that utterance is still unverified, not proof of its intent or of a unique edge."
  + " Use the earlier utterance together with that section's entities and candidate relationships to understand an anaphoric qualification."
  + " Do not replace an explicit endpoint or semantic qualification with the latest analysis, camera selection or edit focus.";
// A reference can qualify a node, a code part or an existing edge. Only the
// existing-edge question requires a unique match among current edges.
const EDGE_REFERENCE_NOTE = " Match against all current edges; if the conversational qualification does not identify one unique edge, answer none.";
// A Working node is named by its unique id. Its label is only display text:
// labels may repeat, equal another node's id or look like option text, so it
// never names a node on its own and is quoted after "shown as". An id is shown
// as it is only when it is one plain token; any other id is quoted too, so
// neither can be read as option text, a label or another node. In a Goal
// option a label is likewise shown as it is unless it could be misread: it
// holds structure or option characters, is empty or padded, or equals a node
// id of the same request.
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MISREADABLE = /^$|^\s|\s$|["'()[\]{};,\\]|[\p{Cc}\p{Zl}\p{Zp}]/u;
const quoted = label => JSON.stringify(label);
const named = key => PLAIN_ID.test(key) ? key : quoted(key);
const shownAs = (labels, key) => labels.get(key) === key ? named(key) : `${named(key)} (shown as ${quoted(labels.get(key))})`;
const labelled = (ids, label) => MISREADABLE.test(label) || ids.has(label) ? quoted(label) : label;

// The questions for exactly the slots the request offers. Each option is a
// key the request carries; the words around it are this Function's own, and
// every product word - a part's or a diagram's purpose - comes from the
// request's offers. `defined` says what the server's own snapshot defines an
// edge as, or null: an architecture intent passes it, and a plain request,
// which has no snapshot, describes every edge by its two ends only.
export function questionsFor(state, slots, context) {
  if (state.candidates !== undefined) {
    // An offered part is named by its displayed name and its key; the name is
    // display data and may repeat, the key and the candidate id decide.
    const offered = new Map(state.offers.parts.map(part => [part.key, part]));
    const parents = new Map(state.parents.map(parent => [parent.id, parent]));
    const labels = new Map(state.graph.map(region => [region.id, region.label]));
    const ids = new Set([...labels.keys(), ...parents.keys()]);
    const label = text => labelled(ids, text);
    const partOf = part => `${label(part.label)} (${named(part.key)}): ${part.purpose}`;
    const placing = state.placing === null ? null : offered.get(state.placing);
    return {
      delta: {
        instruction: (placing === null ? GOAL_WHAT : `The next change adds the offered part ${partOf(placing)}. ${GOAL_WHERE}`)
          + GOAL_CONTEXT_NOTE + (state.scope === null ? "" : SCOPE_NOTE),
        options: criteria(slots.delta, key => {
          if (key === NONE) return placing === null ? "no offered executable change is clearly requested, or the requested changes are already present"
            : "the utterance requests none of these existing groups for this part, or does not identify a unique one";
          if (placing !== null) {
            const candidate = state.candidates.find(item => item.action === ACTION_ADD_PART && item.id === key);
            return `add one new part ${label(placing.label)} (${named(placing.key)}) directly inside ${label(parents.get(candidate.parent).label)} (${named(candidate.parent)})`;
          }
          const arrow = state.candidates.find(item => item.action === ACTION_ADD_EDGE && item.id === key);
          if (arrow !== undefined) return `a directed flow arrow from ${label(labels.get(arrow.from))} (${named(arrow.from)}) to ${label(labels.get(arrow.to))} (${named(arrow.to)})`;
          const { part } = state.candidates.find(item => item.action === ACTION_ADD_PART && partOption(item.part) === key);
          return `add one new part ${partOf(offered.get(part))}`;
        }),
      },
    };
  }
  if (context.kind === ARCHITECTURE_LOCATE_KIND) return locateQuestion(context.entity, context.evidence, slots);
  if (context.kind === ARCHITECTURE_JUDGE_KIND) return judgeQuestions(context.section, slots);
  if (context.kind === ARCHITECTURE_GOAL_INTENT_KIND) {
    const labels = new Map(state.graph.regions.map(region => [region.id, region.label]));
    const node = key => shownAs(labels, key);
    // A role node of the served source states that role's purpose, from the
    // server's own manifest; any other node states none.
    const served = key => {
      const purpose = context.rolePurposeOf?.(key) ?? null;
      return purpose === null ? "" : `, a role node of the served source: ${quoted(purpose)}`;
    };
    // Descriptive current Working data only, not source provenance or unique intent.
    const connections = key => "; current Working connections: " + state.graph.edges
      .filter(edge => edge.from === key || edge.to === key)
      .map(edge => (edge.from === key ? "out " : "in ") + edge.kind + " "
        + node(edge.from === key ? edge.to : edge.from)).join("; ");
    const note = " context.recent lists earlier utterances as recognized or typed and their effects."
      + " They are unverified and may be misrecognized; use them only to understand what the current utterance refers to."
      + " The current utterance and Working graph are the facts; earlier effects are history, not the current graph."
      + " The server reopened each non-null reference from the current canonical source."
      + " Its historical association remains unverified, not proof of intent or a unique edge."
      + " Use the earlier utterance together with that section's entities and candidate relationships to understand an anaphoric qualification."
      + " Do not replace an explicit endpoint or semantic qualification with the latest analysis.";
    const endpointNote = " Match semantic qualifications using the current Working nodes' labels and connections, not only literal names; these describe Working, not verified source facts.";
    return {
      action: {
        instruction: "Which change to the Working graph does the utterance request? Identify unsupported changes as their own actions, not as adding an edge." + note,
        options: criteria(slots.action, action => action === ACTION_COMPOSE
          ? "the utterance asks for a prepared diagram as a whole, by what it is for, rather than one edit"
          : ACTION_WORDS[action]),
      },
      source: {
        instruction: "If the utterance asks to add an edge, which current Working node is its start? An earlier utterance and its reopened section may qualify that node; choose none if it does not identify a unique start." + note + endpointNote,
        options: criteria(slots.source, key => key === NONE ? "no unique current node is identified as the start" : `the edge starts at ${node(key)}` + served(key) + connections(key)),
      },
      target: {
        instruction: "If the utterance asks to add an edge, which current Working node is its end? An earlier utterance and its reopened section may qualify that node; choose none if it does not identify a unique end." + note + endpointNote,
        options: criteria(slots.target, key => key === NONE ? "no unique current node is identified as the end" : `the edge ends at ${node(key)}` + served(key) + connections(key)),
      },
    };
  }
  const defined = context.kind === ARCHITECTURE_INTENT_KIND ? context.relationOf : () => null;
  const labelOf = new Map(state.graph.regions.map(region => [region.id, region.label]));
  const node = key => shownAs(labelOf, key);
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
        + "by the identifier or URL the source uses for it."
        + " Whole means the source-defined structure-only overview, without judging roles or run-time behavior;"
        + " choose it only when that is what the utterance asks for."
        + " Do not use whole as a fallback for an unnamed detail request."
        + " Choose one part when the current metadata uniquely identifies it, even if the utterance does not name its path."
        + " If a detail request cannot identify one part from that metadata, choose none so it can be located from source text.",
      options: criteria(slots.focus, key => (key === WHOLE
        ? "the source-defined structure-only overview of the code as a whole, without judging roles or run-time behavior"
        : key === NONE
          ? "no unique part or structure-only whole is clear from the current metadata, or it asks for neither"
          : `the part ${labelOf.get(key)}`)),
    };
  }
  for (const question of Object.values(questions)) question.instruction += CONTEXT_NOTE
    + (context.kind === ARCHITECTURE_INTENT_KIND ? REFERENCE_NOTE : "");
  if (context.kind === ARCHITECTURE_INTENT_KIND && questions.edge) questions.edge.instruction += EDGE_REFERENCE_NOTE;
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
// One positive condition: whether the current utterance asks to see this part,
// directly or by what it refers to; the other option is any other case.
function locateQuestion(entity, evidence, slots) {
  const file = entity.kind === "file";
  const lined = [...new Set(evidence.lines.map(line => line.path))];
  return {
    [relevantSlot(entity.id)]: {
      instruction: (file
        ? `Does the current utterance ask to see the content of the file ${entity.label}, directly or by what it refers to?`
        : `Does the current utterance ask to see ${entity.label}, which lies outside the source, directly or by what it refers to?`)
        + ` state.architecture.evidence.bodies holds ${evidence.bodies.map(body => body.path).join(", ")} whole`
        + (lined.length === 0 ? "." : `; state.architecture.evidence.lines holds single lines of ${lined.join(", ")}, each with its path and line number.`)
        + " Judge only from that text and the utterance."
        + LOCATE_CONTEXT_NOTE + " An earlier entry's reference is the section the server reopened for it.",
      options: criteria(slots[relevantSlot(entity.id)], key => key === YES
        ? "the current utterance asks to see it, directly or by what it refers to"
        : "any other case"),
    },
  };
}
