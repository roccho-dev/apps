import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
// The approved acceptance runtime supplies this pinned dependency, never npm at run time.
const { chromium } = createRequire(import.meta.url)("playwright-core");

// The architecture page end to end, in exactly one explicitly named mode:
//
//   fixture  every /api/judge answer is crafted by this test at the network from
//            the request the page actually sent. It proves the page's own
//            mechanics - request, plan, claims, draft, Undo, Apply, reload -
//            and is never evidence about Jev or the code.
//   fixture-stop injects a first-turn 502 and proves cross-stage STOP only.
//   fixture-semantic-stop is reverse-only: valid answers omit one required role.
//   live     nothing is intercepted and nothing is crafted. The real service
//            judges this code; the run is PASS only if the required flows are
//            actually drawn and classified, NOT_PASS otherwise. Its input is
//            typed: it is never evidence about the microphone path.
//
// Every utterance prints one JSON line (event "turn") and every run ends with
// one (event "summary"), on stdout: which requests the page made, how each
// ended and in how long, the closed answers, and what the page then showed.
// Never a request's state, headers or any source, stored or secret text.
//
// And in exactly one explicitly named scenario - the same stages, checks and
// requirements, only the words of the utterances differ:
//
//   natural  the utterances as a person says them, by what a part does. This
//            is the acceptance scenario.
//   named    each utterance names its target part by its file path or
//            identifier - never a role or relation it should be given - and
//            the correction names its edge by both ends and kind. It shows
//            only whether the code can be reached and judged when named; it
//            is never a PASS of the natural scenario.
//
// contextual-reverse evaluates source, reverses one calls edge as a hypothetical,
// then strictly restores Working with Undo, without Apply/reload or authority proof.
// goal-addition uses a separate Goal button: one public preparation request,
// finite additions, independent post-STOP graph oracle, then whole-Goal Undo.
// goal-nest adds a group to OCI, a part into that group and one into OCI, then
// connects them; only its added group and that group's ancestors may grow.
// goal-source: whole, app focus, then a Goal scoped by that remembered focus
// draws one new arrow; whole Undo, conversation clear, same utterance unscoped.
// node architecture-e2e.mjs --mode fixture|fixture-stop|fixture-semantic-stop|live --scenario natural|named|contextual-reverse|goal-addition|goal-flow|goal-nest|goal-source <url>
const [flag, mode, scenarioFlag, scenario, url, caseFlag, caseJson, ...extra] = process.argv.slice(2);
if (flag !== "--mode" || !["fixture", "fixture-none", "fixture-stop", "fixture-semantic-stop", "fixture-baseline", "fixture-weak", "live"].includes(mode) || scenarioFlag !== "--scenario"
  || !["natural", "named", "contextual-reverse", "goal-addition", "goal-flow", "goal-nest", "goal-source"].includes(scenario) || !url
  || (mode === "fixture-semantic-stop" && scenario !== "contextual-reverse") || extra.length !== 0
  || (caseFlag !== undefined && (caseFlag !== "--goal-case" || caseJson === undefined))
  || (caseFlag !== undefined && !["goal-addition", "goal-flow", "goal-nest", "goal-source"].includes(scenario))
  || (["fixture-none", "fixture-weak", "fixture-baseline"].includes(mode) && !["goal-addition", "goal-flow", "goal-nest"].includes(scenario))
  || (mode === "fixture-baseline" && caseFlag === undefined)) {
  throw new Error("usage: architecture-e2e.mjs --mode fixture|fixture-stop|fixture-semantic-stop|live --scenario natural|named|contextual-reverse|goal-addition|goal-flow|goal-nest|goal-source <url>");
}
const REVERSE = scenario === "contextual-reverse";
const NEST = scenario === "goal-nest";
const FLOW = scenario === "goal-flow" || NEST;
const GOAL = scenario === "goal-addition" || FLOW;
const SOURCE = scenario === "goal-source";
const SEMANTIC_STOP = mode === "fixture-semantic-stop";
const STOP_FIXTURE = mode === "fixture-stop";
const FIXTURE = mode !== "live";
// The preregistered deterministic lexical baseline (PR #60), one definition.
// It reads only a public Goal request state and the public bundle parts, never
// evaluator data. The CPU replay restores this same source in the page; the
// explicit fixture-baseline mode answers with it as a controlled seen
// regression, never as Jev.
const lexicalChoice = (state, parts) => {
  const norm = value => value.normalize("NFKC").toLowerCase();
  const text = norm(state.utterance);
  const regionOf = new Map(state.selected.map(item => [item.key, item.region]));
  const adopted = new Set(state.selected.map(item => item.region));
  const needles = new Map();
  const name = (word, part, region) => {
    const key = norm(word);
    if (key.length === 0) return;
    const entry = needles.get(key) ?? { parts: new Set(), regions: new Set() };
    if (part !== null) entry.parts.add(part);
    if (region !== undefined) entry.regions.add(region);
    needles.set(key, entry);
  };
  // Public part keys/labels (an adopted part names its region); seed regions by their actual labels.
  for (const part of parts) for (const word of [part.key, part.label]) name(word, part.key, regionOf.get(part.key));
  for (const region of state.graph) if (!adopted.has(region.id)) name(region.label.replace(/ [1-9]\d*$/u, ""), null, region.id);
  const mentions = [];
  for (let at = 0; at < text.length;) {
    const hit = [...needles.keys()].filter(word => text.startsWith(word, at)).sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) { at += 1; continue; }
    mentions.push({ ...needles.get(hit), consumed: false });
    at += hit.length;
  }
  for (const item of state.selected) {
    const mention = mentions.find(other => !other.consumed && other.parts.has(item.key));
    if (mention !== undefined) mention.consumed = true;
  }
  const parents = new Set(state.parents.map(parent => parent.id));
  for (const [index, mention] of mentions.entries()) {
    if (mention.consumed) continue;
    const group = mentions.slice(0, index).reverse().find(other => [...other.regions].some(id => parents.has(id)));
    const add = group && state.candidates.find(candidate => candidate.action === "add-part"
      && mention.parts.has(candidate.part) && group.regions.has(candidate.parent));
    if (add) return add.id;
  }
  const ends = mention => [...mention.regions].filter(id => !parents.has(id) && state.graph.find(region => region.id === id)?.parent !== null);
  const open = mentions.filter(mention => !mention.consumed);
  for (let from = 0; from < open.length; from += 1) for (let to = from + 1; to < open.length; to += 1) {
    const edge = state.candidates.find(candidate => candidate.action === "add-edge"
      && ends(open[from]).includes(candidate.from) && ends(open[to]).includes(candidate.to));
    if (edge) return edge.id;
  }
  return "none";
};
// A finite evaluator input, never a product request or fixture-answer source.
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const endpointIdentity = endpoint => JSON.stringify(endpoint.addedPart !== undefined
  ? ["addedPart", endpoint.addedPart] : ["baselineRegion", endpoint.baselineRegion]);
const flowIdentity = flow => JSON.stringify([endpointIdentity(flow.from), endpointIdentity(flow.to)]);
const sameNoneBaseline = (before, after) => ["draft", "claims", "stored", "root", "confirmedGraph"]
  .every(key => JSON.stringify(after[key]) === JSON.stringify(before[key]))
  && JSON.stringify(after.graph.records) === JSON.stringify(before.graph.records);
const exactChildPins = (added, pins) => JSON.stringify(added.map(record => record.id).sort())
  === JSON.stringify(pins.map(pin => pin.regionId).sort());
// Same predicates used by the grades: a changed claim/view or a duplicated
// owner pin must not pass merely because graph/count/membership match.
const unchanged = { graph: { records: [] }, draft: [], claims: [], stored: null, root: null, confirmedGraph: null };
assert.equal(sameNoneBaseline(unchanged, unchanged), true);
for (const key of ["draft", "claims", "stored", "root", "confirmedGraph"])
  assert.equal(sameNoneBaseline(unchanged, { ...unchanged, [key]: ["changed"] }), false);
assert.equal(exactChildPins([{ id: "a" }, { id: "b" }], [{ regionId: "b" }, { regionId: "a" }]), true);
assert.equal(exactChildPins([{ id: "a" }, { id: "b" }], [{ regionId: "a" }, { regionId: "a" }]), false);
const evaluation = caseFlag === undefined ? null : JSON.parse(caseJson);
if (caseFlag !== undefined) {
  assert.ok(exactKeys(evaluation, ["version", "id", "goal", "order", "expected"])
    && evaluation.version === "voice-ui.goal-evaluation.v1" && typeof evaluation.id === "string" && evaluation.id.length > 0
    && typeof evaluation.goal === "string" && evaluation.goal.trim().length > 0
    && ["normal", "reverse"].includes(evaluation.order)
    && exactKeys(evaluation.expected, ["kind", "regions", "flows"])
    && ["change", "none"].includes(evaluation.expected.kind)
    && Array.isArray(evaluation.expected.regions) && Array.isArray(evaluation.expected.flows), "closed finite evaluator input");
}
// In the natural fixture a part is never named: the intent answers none, and
// the part is located - so the locate frames and their judge are what the
// fixture exercises, failures included. The named fixture names it.
const LOCATES = FIXTURE && scenario !== "named";
// The neutral app boundary never exposes a provider model identity.
// Extra envelope fields are refused; no fixture can prove model homogeneity.
const LABEL = `architecture-e2e[${mode}/${scenario}]`;
const UTTERANCES = {
  natural: {
    whole: "このアプリの構成を図にして",
    app: "画面のコードの役割を詳しく見せて",
    credential: "認証とJevへの接続を詳しく見せて",
    storage: "ブラウザ保存に関わる部分を詳しく見せて",
    save: "保存の仕組みを詳しく見せて",
    correction: "その保存の関係は違うので消して",
  },
  named: {
    whole: "このアプリの構成を図にして",
    app: "web/app.mjs を詳しく見せて",
    credential: "JEV_API_KEY を詳しく見せて",
    storage: "localStorage を詳しく見せて",
    save: "src/log.mjs を詳しく見せて",
    correction: "web/app.mjs から localStorage への stores-in の関係を消して",
  },
}[REVERSE || GOAL || SOURCE ? "natural" : scenario];
const REVERSE_UTTERANCE = "さっき詳しく見た画面が判定を頼む呼び出しを、試案として逆向きにして";
const PAGE = new URL("/architecture", url).href;
const ROOT_KEY = "voice-ui.decision-log.v1";

// The contract as the target serves it, never a copy kept here.
const served = await fetch(new URL("/app/src/contract.mjs", url));
assert.equal(served.status, 200, "the target serves its contract module");
const contract = await import(`data:text/javascript;base64,${Buffer.from(await served.text()).toString("base64")}`);
const config = await (await fetch(new URL("/architecture/data/config.v1.json", url))).json();
const KEY = config.persistence.key;
// The snapshot's public manifest as the target serves it: its parts, which a
// locate asks about, and the commit every architecture request must name.
const MANIFEST = await (await fetch(new URL(config.data.source, url))).json();
const ENTITY_IDS = MANIFEST.entities.map(entity => entity.id);
const SERVED_COMMIT = MANIFEST.source.commit;
// The most requests one utterance can make: its intent, one locate frame per
// part, and a judge of every part - one frame per file, and one per two files
// some candidate pair joins.
const FILE_IDS = MANIFEST.entities.filter(entity => entity.kind === "file").map(entity => entity.id);
const MOST = 1 + ENTITY_IDS.length + FILE_IDS.length + new Set(MANIFEST.candidates
  .filter(candidate => FILE_IDS.includes(candidate.from) && FILE_IDS.includes(candidate.to))
  .map(candidate => [candidate.from, candidate.to].sort().join(" "))).size;

const publicBundle = GOAL ? await (await fetch(new URL(config.data.bundle, url))).json() : null;
const seed = publicBundle?.diagrams.find(diagram => diagram.key === "container-example");
const expectedCase = evaluation?.expected ?? { kind: "change", regions: NEST ? [
  { partKey: "group", parentLabel: "OCI" }, { partKey: "db", parent: { addedPart: "group" } }, { partKey: "api", parentLabel: "OCI" },
] : [
  { partKey: "api", parentLabel: "OCI" }, { partKey: "db", parentLabel: "OCI" },
], flows: FLOW ? [{ from: { addedPart: "api" }, to: { addedPart: "db" } }] : [] };
// An expected parent is a unique seed group by label, or a group part added
// by the same oracle; every such chain must end at a seed group.
const parentShape = region => exactKeys(region, ["partKey", "parentLabel"]) ? "seed"
  : exactKeys(region, ["partKey", "parent"]) && exactKeys(region.parent, ["addedPart"]) ? "added" : null;
const NESTED = expectedCase.regions.some(region => parentShape(region) === "added");
// goal-source names one expected arrow by two served manifest entities; live
// goal-source runs only on such evaluator data.
if (SOURCE) {
  assert.ok(FIXTURE || evaluation !== null, "live goal-source requires a finite --goal-case input");
  assert.ok(!FIXTURE || evaluation === null, "the controlled goal-source takes no evaluator data");
  assert.ok(evaluation === null || evaluation.order === "normal", "goal-source has no reversed presentation");
  if (evaluation !== null) assert.ok(evaluation.expected.kind === "change" && evaluation.expected.regions.length === 0
    && evaluation.expected.flows.length === 1 && exactKeys(evaluation.expected.flows[0], ["from", "to"])
    && ["from", "to"].every(end => exactKeys(evaluation.expected.flows[0][end], ["baselineRegion"])
      && ENTITY_IDS.includes(evaluation.expected.flows[0][end].baselineRegion))
    && evaluation.expected.flows[0].from.baselineRegion !== evaluation.expected.flows[0].to.baselineRegion, "one expected arrow between served manifest entities");
}
if (GOAL) {
  assert.ok(expectedCase.regions.length <= publicBundle.parts.length && expectedCase.flows.length <= 90, "finite oracle size");
  assert.ok(expectedCase.regions.every(region => parentShape(region) !== null), "closed expected regions");
  const partKeys = expectedCase.regions.map(region => region.partKey);
  assert.equal(new Set(partKeys).size, partKeys.length, "unique expected parts");
  for (const region of expectedCase.regions) assert.ok(publicBundle.parts.some(part => part.key === region.partKey)
    && (parentShape(region) === "seed" ? seed.lanes.filter(lane => lane.label === region.parentLabel).length === 1
      : region.parent.addedPart !== region.partKey && partKeys.includes(region.parent.addedPart)
        && publicBundle.parts.some(part => part.key === region.parent.addedPart && part.kind === "group")),
  "public part and a unique seed parent or an expected added group");
  for (const region of expectedCase.regions) {
    let node = region;
    for (let step = 0; parentShape(node) === "added" && step <= expectedCase.regions.length; step++)
      node = expectedCase.regions.find(other => other.partKey === node.parent.addedPart);
    assert.equal(parentShape(node), "seed", "every expected parent chain reaches a seed group");
  }
  const endpoint = value => exactKeys(value, ["addedPart"]) && partKeys.includes(value.addedPart)
    || exactKeys(value, ["baselineRegion"]) && seed.steps.filter(step => step.ref === value.baselineRegion).length === 1;
  for (const flow of expectedCase.flows) assert.ok(exactKeys(flow, ["from", "to"]) && endpoint(flow.from) && endpoint(flow.to)
    && JSON.stringify(flow.from) !== JSON.stringify(flow.to), "public directed flow endpoints");
  assert.equal(new Set(expectedCase.flows.map(flowIdentity)).size, expectedCase.flows.length, "unique expected flows");
  assert.ok(expectedCase.kind === "none" ? expectedCase.regions.length === 0 && expectedCase.flows.length === 0
    : expectedCase.regions.length + expectedCase.flows.length > 0, "explicit change or NONE oracle");
}
const orderInterventions = [];
const presentation = sent => {
  if (evaluation?.order !== "reverse" || sent.kind !== contract.GOAL_REQUEST_KIND) return sent;
  const next = { ...sent, state: { ...sent.state, candidates: [...sent.state.candidates].reverse() } };
  assert.deepEqual({ ...next, state: { ...next.state, candidates: sent.state.candidates } }, sent);
  assert.deepEqual([...next.state.candidates].sort((a, b) => a.id.localeCompare(b.id)),
    [...sent.state.candidates].sort((a, b) => a.id.localeCompare(b.id)));
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  orderInterventions.push({ before: sent.state.candidates.map(candidate => candidate.id),
    after: next.state.candidates.map(candidate => candidate.id), beforeHash: digest(sent), afterHash: digest(next),
    sameEntriesAndOtherState: true, attribution: FIXTURE ? "controlled presentation only" : "route.continue request intervention; not independently observed provider wire" });
  return next;
};

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const context = await browser.newContext(REVERSE || GOAL || SOURCE ? { viewport: { width: 1280, height: 720 } } : {});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(String(error)));

// Every request the page makes to /api/judge, held by the browser's own request
// object, as it was sent and as it ended: answered with a status and a body
// read whole - or "body-unreadable" - or failed with the browser's own error
// text, and how long until then. A body is read once, and every read is
// awaited before anything is reported. Each is marked once a turn reports it.
const exchanges = [];
page.on("request", request => {
  if (new URL(request.url()).pathname !== "/api/judge") return;
  exchanges.push({
    request, sent: JSON.parse(request.postData()), at: Date.now(), status: null, error: null, ms: null, body: null, read: null, reported: false,
  });
});
const exchangeOf = request => exchanges.find(entry => entry.request === request);
page.on("response", response => {
  const entry = exchangeOf(response.request());
  if (entry === undefined) return;
  entry.status = response.status();
  entry.read = response.json().then(body => {
    entry.body = body;
  }, () => {
    entry.error = "body-unreadable";
  }).finally(() => {
    entry.ms = Date.now() - entry.at;
  });
});
page.on("requestfailed", request => {
  const entry = exchangeOf(request);
  if (entry === undefined) return;
  entry.error = "transport-failed";
  entry.ms = Date.now() - entry.at;
});
const drain = () => Promise.all(exchanges.map(entry => entry.read));

// What of an exchange may be printed: its kind, a locate frame's part, a
// judge's focus, body file ids and the frame of them it asks, how it ended,
// the unavailable provider identity and the closed answers as choice and confidence.
const sanitized = entry => {
  let answers = null;
  try {
    const slots = slotsOf(entry.sent);
    if (slots !== null) answers = contract.readAnswers(entry.body?.answers, slots);
  } catch {}
  return ({
  kind: entry.sent.kind,
  ...(entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND
    ? { focus: entry.sent.state.architecture.focus, bodies: entry.sent.state.architecture.bodies, frame: entry.sent.state.frame }
    : entry.sent.kind === contract.ARCHITECTURE_LOCATE_KIND ? { focus: entry.sent.state.architecture.focus } : {}),
  status: entry.status,
  error: entry.error !== null && entry.error !== undefined
    ? ["body-unreadable", "transport-failed"].includes(entry.error) ? entry.error : "UNKNOWN"
    : entry.body?.error === null || entry.body?.error === undefined ? null
      : Object.values(contract.ERRORS).includes(entry.body.error) ? entry.body.error : "UNKNOWN",
  upstreamStatus: entry.status === 502 && entry.body?.error === contract.ERRORS.providerError
    && Number.isInteger(entry.body?.upstreamStatus) && entry.body.upstreamStatus >= 300 && entry.body.upstreamStatus <= 599
    ? entry.body.upstreamStatus : "UNKNOWN",
  diagnostic: entry.status === 502 && entry.body?.error === contract.ERRORS.providerError
    && entry.body?.upstreamStatus === 400 && entry.body?.diagnostic === "context-limit-vocabulary-observed"
    ? "context-limit-vocabulary-observed" : "UNKNOWN",
  ms: entry.ms,
  providerIdentity: "UNKNOWN",
  answers: answers === null ? null
    : Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, [answer.choice, answer.confidence]])),
  });
};
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);

// The frames a judge's section is asked in, as the served contract plans
// them; and the questions a request put to Jev, as it derives them for its
// kind - for a judge, those of the one frame it names, or null when its
// section's plan holds no such frame.
const framesOf = section => contract.judgeFramesFor(section) ?? [];
const slotsOf = sent => {
  if (sent.kind === contract.ARCHITECTURE_LOCATE_KIND) return contract.locateSlotsFor(sent.state.architecture.focus);
  if (sent.kind !== contract.ARCHITECTURE_JUDGE_KIND) return contract.slotsFor(sent.state);
  const framed = framesOf(sent.state.architecture).find(item => JSON.stringify(item.frame) === JSON.stringify(sent.state.frame));
  return framed === undefined ? null : contract.judgeSlotsFor(framed.section);
};

// Fixture mode only: the answer to a request, crafted from its own questions -
// an intent's, a locate frame's or a judge frame's. For a stage that proves a
// failure, `fault` may replace the answer to one request of the utterance, by
// its place (0 the intent): with a status and body of its own, with an unexpected envelope field, or with answers of its own. A judge naming a frame its section's
// plan does not hold is refused, as the Function refuses it.
const craft = (picks, fault = () => null) => {
  let index = 0;
  return async route => {
    const sent = presentation(JSON.parse(route.request().postData()));
    const slots = slotsOf(sent);
    const faulty = slots === null ? { status: 422, body: { error: contract.ERRORS.architectureMismatch } } : fault(index);
    index += 1;
    if (faulty?.status !== undefined) {
      await route.fulfill({ status: faulty.status, contentType: "application/json; charset=utf-8", body: JSON.stringify(faulty.body) });
      return;
    }
    const answers = Object.fromEntries(Object.entries(slots).map(([name, options]) => {
      const picked = picks(name, sent);
      const structured = picked !== null && typeof picked === "object";
      const value = structured ? picked : { choice: picked, confidence: 0.9 };
      if (structured) assert.ok(options.includes(value.choice), name + ": the controlled uncertain choice is actually offered");
      return [name, { type: "choice", choice: options.includes(value.choice) ? value.choice : contract.NONE, confidence: value.confidence }];
    }));
    await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ kind: contract.DECISION_KIND, answers: faulty?.answers ?? answers, ...(faulty?.extra ?? {}) }) });
  };
};

const ready = () => page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending", null, { timeout: 120000 });
const settle = () => page.waitForFunction(() => document.body.dataset.state !== "pending", null, { timeout: 120000 });
const labelVisible = label => page.evaluate(label => {
  const iframe = document.querySelector("#working-surface iframe[data-package=semantic-map]");
  const doc = iframe.contentDocument;
  return [...doc.querySelectorAll("svg text, svg foreignObject")].some(node => {
    const rect = node.getBoundingClientRect(), style = iframe.contentWindow.getComputedStyle(node);
    return node.textContent.includes(label) && rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.bottom > 0 && rect.left < iframe.clientWidth && rect.top < iframe.clientHeight
      && style.display !== "none" && style.visibility !== "hidden";
  });
}, label);
// Maxgraph orders each cell's painted shape immediately before its label
// group. Bind the unique actual label, not a label clip or layout pin marker.
const paintedGoal = (container, records, edge = null) => page.evaluate(({ container, records, edge }) => {
  const iframe = document.querySelector("#working-surface iframe[data-package=semantic-map]");
  const doc = iframe.contentDocument;
  const visible = node => {
    if (!node) return false;
    for (let parent = node; parent !== null; parent = parent.parentElement) {
      const style = iframe.contentWindow.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const box = node => {
    if (!node) return null;
    const r = node.getBoundingClientRect(), style = iframe.contentWindow.getComputedStyle(node);
    return [r.left, r.top, r.width, r.height].every(Number.isFinite)
      && r.width > 0 && r.height > 0 && visible(node) && style.display !== "none" && style.visibility !== "hidden"
      ? [r.left, r.top, r.width, r.height] : null;
  };
  const uniquePrimitive = geometry => geometry.length === 1 ? geometry[0] : null;
  const shape = (label, boundary = false) => {
    const labels = [...doc.querySelectorAll("svg text, svg foreignObject")].filter(node => node.textContent.trim() === label);
    if (labels.length !== 1) return null;
    for (let group = labels[0].parentElement; group?.localName === "g"; group = group.parentElement) {
      const previous = group.previousElementSibling;
      if (previous?.localName === "g" && !previous.querySelector("text, foreignObject")
        && previous.querySelector("rect, path, ellipse, polygon")) {
        const geometry = [...previous.children].filter(node => {
          if (!["rect", "path", "ellipse", "polygon"].includes(node.localName)) return false;
          const style = iframe.contentWindow.getComputedStyle(node);
          if (boundary) return node.localName === "rect" && style.stroke !== "none"
            && style.strokeDasharray !== "none" && Number(style.strokeOpacity) > 0 && Number(style.opacity) > 0;
          if (node.getAttribute("pointer-events") !== "all") return false;
          return Number(style.opacity) > 0 && ((style.fill !== "none" && Number(style.fillOpacity) > 0)
            || (style.stroke !== "none" && Number(style.strokeOpacity) > 0));
        });
        const primitive = uniquePrimitive(geometry);
        return primitive !== null && primitive.namespaceURI === "http://www.w3.org/2000/svg"
          && typeof primitive.getScreenCTM === "function" && typeof primitive.getTotalLength === "function"
          && typeof primitive.getPointAtLength === "function"
          && box(primitive) !== null ? primitive : null;
      }
    }
    return null;
  };
  const frame = box(shape(container.label, true));
  const primitives = records.map(record => shape(record.label, record.kind === "group"));
  const shapes = records.map((record, i) => ({ id: record.id, rawLabel: record.label, bounds: box(primitives[i]) }));
  const inside = bounds => frame !== null && bounds !== null && bounds[0] >= frame[0] && bounds[1] >= frame[1]
    && bounds[0] + bounds[2] <= frame[0] + frame[2] && bounds[1] + bounds[3] <= frame[1] + frame[3];
  const overlap = (a, b) => a !== null && b !== null && a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
    && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  // The pinned classic marker starts at its tip (createArrow); ConnectorShape
  // paints the stroke and this filled marker in the same cell group. Match
  // actual screen-space terminals to the unique painted node shapes. This is
  // not an inference from the logical relation or a label clip.
  // Actual points on the painted perimeter give an upper bound on its nearest
  // distance, including multiple subpaths: never connect them with fake chords.
  const outline = (node, p, isVisible = visible(node)) => {
    if (!node || !isVisible || !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) return null;
    try {
      const matrix = node.getScreenCTM(), length = node.getTotalLength();
      const ctm = matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
      const determinant = matrix && matrix.a * matrix.d - matrix.b * matrix.c;
      if (!ctm || !ctm.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0
        || !Number.isFinite(length) || length <= 0) return null;
      const n = Math.ceil(length * Math.hypot(matrix.a, matrix.b, matrix.c, matrix.d) / 0.5);
      if (!Number.isSafeInteger(n) || n < 1 || n > 32768) return null;
      let distanceUpper = Infinity;
      for (let i = 0; i <= n; i++) {
        const point = node.getPointAtLength(length * i / n);
        const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
        const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
        if (![x, y].every(Number.isFinite)) return null;
        distanceUpper = Math.min(distanceUpper, Math.hypot(x - p[0], y - p[1]));
      }
      return { tag: node.localName, ctm, samples: n + 1, distanceUpper };
    } catch { return null; }
  };
  // Controlled refusal inputs exercise the very same measurement path, not
  // producer geometry or evidence that a real rendered node was measured.
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const probe = { localName: "controlled", getScreenCTM: () => identity,
    getTotalLength: () => 1, getPointAtLength: length => ({ x: length, y: 0 }) };
  const hidden = doc.createElementNS("http://www.w3.org/2000/svg", "g");
  const hiddenChild = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  hidden.style.display = "none";
  hidden.appendChild(hiddenChild); // Detached controlled tree, not the actual graph.
  const refused = [null,
    { ...probe, getScreenCTM: () => null },
    { ...probe, getScreenCTM: () => ({ ...identity, a: NaN }) },
    { ...probe, getScreenCTM: () => ({ ...identity, d: 0 }) },
    { ...probe, getScreenCTM: () => ({ a: 1e155, b: 1e155, c: 1e155, d: 1e155, e: 0, f: 0 }),
      getTotalLength: () => 1e-155 },
    { ...probe, getTotalLength: () => 0 },
    { ...probe, getTotalLength: () => Infinity },
    { ...probe, getTotalLength: () => 32768 },
    { ...probe, getPointAtLength: () => ({ x: NaN, y: 0 }) }];
  if (outline(probe, [0, 0], true)?.distanceUpper !== 0
    || refused.some(node => outline(node, [0, 0], true) !== null)
    || outline(probe, [0, 0], false) !== null || visible(hiddenChild)
    || uniquePrimitive([]) !== null || uniquePrimitive([probe, probe]) !== null)
    throw new Error("actual-outline controlled refusal failed");
  const arrows = [];
  const observedEdges = [];
  if (edge !== null) for (const group of doc.querySelectorAll("svg g")) {
    const paths = [...group.children].filter(node => {
      if (node.localName !== "path") return false;
      const r = node.getBoundingClientRect(), s = iframe.contentWindow.getComputedStyle(node);
      return [r.left, r.top, r.width, r.height].every(Number.isFinite) && (r.width > 0 || r.height > 0)
        && s.display !== "none" && s.visibility !== "hidden";
    });
    const lines = paths.filter(node => {
      const s = iframe.contentWindow.getComputedStyle(node);
      return s.fill === "none" && s.stroke !== "none" && Number(s.opacity) > 0 && Number(s.strokeOpacity) > 0;
    });
    const markers = paths.filter(node => {
      const s = iframe.contentWindow.getComputedStyle(node);
      return s.fill !== "none" && s.stroke !== "none" && Number(s.opacity) > 0 && Number(s.fillOpacity) > 0
        && /z\s*$/iu.test(node.getAttribute("d") ?? "");
    });
    if (lines.length !== 1 || markers.length !== 1) {
      if (paths.length > 0) observedEdges.push({ lines: lines.length, markers: markers.length,
        paths: paths.map(node => { const s = iframe.contentWindow.getComputedStyle(node);
          return { d: node.getAttribute("d"), fill: s.fill, stroke: s.stroke, opacity: s.opacity,
            fillOpacity: s.fillOpacity, strokeOpacity: s.strokeOpacity,
            parent: node.parentElement.localName, parentChildren: node.parentElement.children.length }; }) });
      continue;
    }
    const line = lines[0], marker = markers[0];
    const point = (node, length) => {
      const matrix = node.getScreenCTM();
      if (matrix === null || !Number.isFinite(length)) return null;
      const p = node.getPointAtLength(length), screen = new iframe.contentWindow.DOMPoint(p.x, p.y).matrixTransform(matrix);
      return [screen.x, screen.y].every(Number.isFinite) ? [screen.x, screen.y] : null;
    };
    const length = line.getTotalLength(), markerLength = marker.getTotalLength();
    if (!(Number.isFinite(length) && length > 0 && Number.isFinite(markerLength) && markerLength > 0)) continue;
    const start = point(line, 0), end = point(line, length), tip = point(marker, 0);
    const beforeEnd = point(line, Math.max(0, length - 1));
    const from = outline(primitives[records.findIndex(item => item.id === edge.from)], start);
    const to = outline(primitives[records.findIndex(item => item.id === edge.to)], tip);
    const matrix = marker.getScreenCTM();
    const scale = matrix === null ? NaN : Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
    const stroke = Number.parseFloat(iframe.contentWindow.getComputedStyle(marker).strokeWidth) * scale;
    // Pinned createArrow shortens the tip by 1.118 stroke widths; SVG canvas
    // serializes coordinates at finite pixel precision. No layout-size slack.
    const padding = Number.isFinite(stroke) && stroke > 0 ? 1.118 * stroke + 1 : NaN;
    const directed = end !== null && tip !== null && beforeEnd !== null
      && (end[0] - beforeEnd[0]) * (tip[0] - end[0]) + (end[1] - beforeEnd[1]) * (tip[1] - end[1]) > 0;
    observedEdges.push({ start, end, tip, stroke, padding, lineLength: length, markerLength,
      fromOutline: from, toOutline: to,
      fromConnected: from !== null && from.distanceUpper <= padding,
      toConnected: to !== null && to.distanceUpper <= padding, directed });
    if (from !== null && to !== null && from.distanceUpper <= padding && to.distanceUpper <= padding && directed)
      arrows.push({ start, end, tip, stroke, padding, lineLength: length, markerLength });
  }
  return { association: "pinned-maxgraph-shape-before-unique-raw-label",
    viewport: [0, 0, iframe.clientWidth, iframe.clientHeight],
    container: { id: container.id, kind: "painted-dashed-group-boundary", bounds: frame }, shapes,
    edge: edge === null ? null : { from: edge.from, to: edge.to,
      association: "pinned-classic-marker-tip-and-stroke-in-one-cell-group", observed: observedEdges, matches: arrows,
      complete: arrows.length === 1 },
    contained: shapes.every(item => inside(item.bounds)),
    nonoverlap: shapes.every((item, i) => shapes.every((other, j) => i === j || !overlap(item.bounds, other.bounds))),
    complete: frame !== null && shapes.every(item => item.bounds !== null) };
}, { container, records, edge });
// One arrow on the current frame, by the existing painted observer: the
// matched stroke start and marker tip lie inside the zero-margin iframe
// viewport and both end shapes intersect it, whatever their labels show; on
// the same frame its reverse (unless itself expected) and an arrow to another
// part whose shape is in view must not connect. Frames are never combined.
const within = (view, point) => Array.isArray(point) && point[0] >= view[0] && point[1] >= view[1]
  && point[0] <= view[0] + view[2] && point[1] <= view[1] + view[3];
const meets = (view, box) => Array.isArray(box) && box[0] < view[0] + view[2] && box[0] + box[2] > view[0]
  && box[1] < view[1] + view[3] && box[1] + box[3] > view[1];
const measureArrow = async (container, endpoints, edge, { reverseExpected = false, related = () => false } = {}) => {
  const ends = [edge.from, edge.to].map(id => endpoints.find(record => record.id === id) ?? null);
  if (ends.includes(null)) return { inView: false, edge: null, reverse: null, disconnected: null, met: false };
  const all = await paintedGoal(container, endpoints, null);
  const other = endpoints.find((record, index) => !ends.includes(record) && !related(edge.from, record.id)
    && meets(all.viewport, all.shapes[index].bounds)) ?? null;
  const records = other === null ? ends : [...ends, other];
  const painted = await paintedGoal(container, records, edge);
  const match = painted.edge.matches.length === 1 ? painted.edge.matches[0] : null;
  const endBounds = painted.shapes.slice(0, 2).map(shape => shape.bounds);
  const inView = match !== null && within(painted.viewport, match.start) && within(painted.viewport, match.tip)
    && endBounds.every(box => meets(painted.viewport, box));
  const reverse = reverseExpected ? "not-applicable" : (await paintedGoal(container, records, { from: edge.to, to: edge.from })).edge;
  const disconnected = other === null ? null : (await paintedGoal(container, records, { from: edge.from, to: other.id })).edge;
  return { viewport: painted.viewport, endBounds, other: other?.id ?? null, inView, edge: painted.edge, reverse, disconnected,
    met: inView && painted.edge.complete && painted.edge.matches.length === 1
      && (reverse === "not-applicable" || !reverse.complete) && disconnected !== null && !disconnected.complete };
};
const screen = () => page.evaluate(([key, rootKey]) => ({
  state: document.body.dataset.state,
  status: document.querySelector("#status").textContent,
  failure: document.querySelector("[data-history=failure]")?.textContent ?? null,
  draft: [...document.querySelectorAll("#draft li")].map(item => item.dataset.changes),
  draftCount: document.querySelector("#draft-count").textContent,
  sourceStatus: document.querySelector("#architecture-status").textContent,
  shown: !document.querySelector("#architecture").hidden,
  claims: [...document.querySelectorAll("#architecture-claims li")].map(item => ({
    record: item.dataset.record, origins: item.dataset.origins.split(" "),
  })),
  coverage: [...document.querySelectorAll("#architecture-coverage li")].map(item => item.textContent),
  context: [...document.querySelectorAll("#context-recent li")].map(item => JSON.parse(item.dataset.entry)),
  graph: (() => {
    const runtime = document.querySelector("#working-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
    return runtime && Array.isArray(runtime.records) && runtime.records.length > 0 && typeof runtime.head === "string"
      ? { head: runtime.head, records: runtime.records, view: runtime.view } : null;
  })(),
  stored: localStorage.getItem(key),
  confirmedGraph: (() => {
    const runtime = document.querySelector("#confirmed-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
    return runtime && Array.isArray(runtime.records) && runtime.records.length > 0 && typeof runtime.head === "string"
      ? { head: runtime.head, records: runtime.records, view: runtime.view } : null;
  })(),
  notice: document.querySelector("#working-notice").textContent,
  camera: document.querySelector("#camera-part").value,
  pending: document.body.dataset.pending ?? null,
  root: localStorage.getItem(rootKey),
}), [KEY, ROOT_KEY]);
const domOf = now => ({
  state: now.state, status: now.status, failure: now.failure, draftSteps: now.draft.length, draftCount: now.draftCount,
  claims: now.claims.map(claim => `${claim.record} ${claim.origins.join("+")}`),
  draft: now.draft, context: now.context, graph: now.graph, confirmedGraph: now.confirmedGraph, notice: now.notice, camera: now.camera, pending: now.pending,
});
// What the page showed last, for the summary.
let last = null;

// The requests one utterance must make, from the answers it actually got: an
// intent; then a judge of exactly [the part] when the intent names one part
// confidently; or, when it names neither the whole nor a part confidently, one
// locate frame per part the snapshot knows, and a judge of exactly every part
// its own frame answered yes confidently, sorted, if there is any. A judge is
// one request for every frame the served contract plans for the section its
// first request carries - at least one. Nothing else.
const expectedOf = sent => {
  const kinds = [contract.ARCHITECTURE_INTENT_KIND];
  const intent = sent[0]?.body?.answers;
  if (intent?.action?.choice !== contract.ACTION_ARCHITECTURE || !(intent.action.confidence >= contract.MIN_CONFIDENCE)) return { kinds, focus: null, frames: [] };
  const { choice, confidence } = intent.focus ?? {};
  const sure = confidence >= contract.MIN_CONFIDENCE;
  if (choice === contract.WHOLE && sure) return { kinds, focus: null, frames: [] };
  const judged = (before, focus) => {
    const first = sent[before.length]?.sent;
    const planned = first?.kind === contract.ARCHITECTURE_JUDGE_KIND ? framesOf(first.state.architecture).map(item => item.frame) : [];
    const frames = planned.length === 0 ? [null] : planned;
    return { kinds: [...before, ...frames.map(() => contract.ARCHITECTURE_JUDGE_KIND)], focus, frames };
  };
  if (choice !== contract.NONE && choice !== contract.WHOLE && sure) return judged(kinds, [choice]);
  const locates = ENTITY_IDS.map(() => contract.ARCHITECTURE_LOCATE_KIND);
  const found = sent.slice(1, 1 + ENTITY_IDS.length).flatMap(entry => {
    const [part] = entry.sent.state?.architecture?.focus ?? [];
    const answer = entry.body?.answers?.[contract.relevantSlot(part)];
    return answer?.choice === contract.YES && answer.confidence >= contract.MIN_CONFIDENCE ? [part] : [];
  }).sort();
  return found.length === 0
    ? { kinds: [...kinds, ...locates], focus: null, frames: [] }
    : judged([...kinds, ...locates], found);
};

// One utterance in the named stage. The page is pending from the click until
// it has finished the utterance, however it ended; then the requests it
// actually made are checked against what their own answers call for: their
// kinds and order, every one answered 200 with a complete answer, every one
// naming the served snapshot, one locate frame per part in the snapshot's
// order, each carrying the intent's utterance and conversation exactly, and a
// judge bound to exactly the parts asked for, every request of it carrying the
// same section and the utterance, and naming that section's frames once each
// in the contract's order. Anything else is a finding of this stage - never a
// wait for more.
const actions = { new: 0, send: 0, undo: 0, apply: 0, reload: 0, ...(FIXTURE ? { discard: 0 } : {}), ...(GOAL || SOURCE ? { goal: 0 } : {}) };
const click = async control => { actions[control]++; await page.locator("#" + control).click(); };
let stopBaseline = null;
const say = async (stage, utterance, picks) => {
  const route = new URL("/api/judge", url).href;
  if (STOP_FIXTURE) stopBaseline = await screen();
  if (FIXTURE) await page.route(route, craft(picks, () => STOP_FIXTURE ? { status: 502, body: { error: contract.ERRORS.providerError, upstreamStatus: 401 } } : null), { times: MOST });
  const before = exchanges.length;
  await page.locator("#text").fill(utterance);
  await click("send");
  await settle();
  await drain();
  if (FIXTURE) await page.unroute(route);
  const sent = exchanges.slice(before);
  const now = await screen();
  last = now;
  const answered = sent.filter(entry => entry.status !== null).length;
  let expected, planningError = null;
  try { expected = expectedOf(sent); } catch (error) {
    planningError = String(error?.message ?? error).split("\n")[0];
    expected = { kinds: [], focus: null, frames: [] };
  }
  report({ event: "turn", stage, expected: expected.kinds, requests: sent.length, answered, failed: sent.filter(entry => entry.error !== null).length,
    exchanges: sent.map(sanitized), dom: domOf(now) });
  for (const entry of sent) entry.reported = true;
  const defects = [];
  const valid = (condition, message) => { if (!condition) defects.push(message); };
  valid(planningError === null, `request plan could not be validated: ${planningError}`);
  try {
  const kinds = sent.map(entry => entry.sent.kind);
  valid(JSON.stringify(kinds) === JSON.stringify(expected.kinds), `${stage}: requests ${kinds.join(", ")} where the answers call for ${expected.kinds.join(", ")}`);
  valid(sent.every(entry => entry.status === 200 && entry.error === null && entry.body !== null
    && typeof entry.body === "object" && !Array.isArray(entry.body)
    && JSON.stringify(Object.keys(entry.body).sort()) === JSON.stringify(["answers", "kind"])
    && entry.body.kind === contract.DECISION_KIND && slotsOf(entry.sent) !== null && contract.readAnswers(entry.body?.answers, slotsOf(entry.sent)) !== null),
    `${stage}: every request answered 200 with a complete answer`);
  valid(sent.every(entry => entry.sent.kind === contract.REQUEST_KIND || entry.sent.state?.architecture?.source?.commit === SERVED_COMMIT),
    `${stage}: every request names the served snapshot`);
  const frames = sent.filter(entry => entry.sent.kind === contract.ARCHITECTURE_LOCATE_KIND);
  valid(frames.length === 0 || JSON.stringify(frames.map(entry => entry.sent.state.architecture.focus)) === JSON.stringify(ENTITY_IDS.map(id => [id])),
    `${stage}: one locate frame per part, in the snapshot's order`);
  valid(frames.every(entry => entry.sent.state.utterance === sent[0].sent.state.utterance
    && JSON.stringify(entry.sent.state.context) === JSON.stringify(sent[0].sent.state.context)),
  `${stage}: every locate frame carries the intent's utterance and conversation exactly`);
  const judges = sent.filter(entry => entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND);
  valid(judges.every(entry => JSON.stringify(entry.sent.state.architecture.focus) === JSON.stringify(expected.focus)),
    `${stage}: the judge is bound to exactly ${JSON.stringify(expected.focus)}`);
  valid(judges.every(entry => JSON.stringify(entry.sent.state.architecture) === JSON.stringify(judges[0].sent.state.architecture)
    && entry.sent.state.utterance === sent[0].sent.state.utterance)
    && (judges.length === 0 || JSON.stringify(judges.map(entry => entry.sent.state.frame)) === JSON.stringify(expected.frames)),
  `${stage}: every judge frame carries the one section and the utterance, and the frames are that section's, once each and in order`);
  } catch (error) {
    defects.push(`protocol validation could not complete: ${String(error?.message ?? error).split("\n")[0]}`);
  }
  valid(errors.length === 0, `no page error: ${errors.join(" | ")}`);
  if (defects.length > 0) {
    protocolFailure = { stage, defects };
    stoppedAt = stage;
    throw PROTOCOL_HALT;
  }
  return { now, sent };
};
// The natural fixture only: one utterance - the save one, unless another is
// named with the part it is located to - whose request at place `at` (0 its
// intent, then one locate frame per part, then its judge's frames) fails as
// `fault` says. The page must ask nothing after it, and draw, draft and store
// nothing: the draft, the claims and both stored values stay exactly as they
// were just before this utterance.
const failing = async (stage, at, fault, why, { utterance = UTTERANCES.save, focus = LOG } = {}) => {
  const route = new URL("/api/judge", url).href;
  const baseline = await screen();
  await page.route(route, craft(picksFor(focus), index => (index === at ? fault : null)), { times: MOST });
  const before = exchanges.length;
  await page.locator("#text").fill(utterance);
  await click("send");
  await settle();
  await drain();
  await page.unroute(route);
  const sent = exchanges.slice(before);
  const now = await screen();
  last = now;
  const expected = Array.from({ length: at + 1 }, (_, index) => (index === 0 ? contract.ARCHITECTURE_INTENT_KIND
    : index <= ENTITY_IDS.length ? contract.ARCHITECTURE_LOCATE_KIND : contract.ARCHITECTURE_JUDGE_KIND));
  report({ event: "turn", stage, expected, requests: sent.length, answered: sent.filter(entry => entry.status !== null).length,
    failed: sent.filter(entry => entry.error !== null).length, exchanges: sent.map(sanitized), dom: domOf(now) });
  for (const entry of sent) entry.reported = true;
  need(JSON.stringify(sent.map(entry => entry.sent.kind)) === JSON.stringify(expected),
    `${stage}: nothing is asked after the failing request (${sent.length} requests, ${expected.length} expected)`);
  // What the page sent agrees with itself and the served plan - so a fault at
  // a judge's second frame lands on that frame, not on its first sent twice.
  // Nothing is said of what a server would hold; no judge sent, nothing to check.
  const judges = sent.filter(entry => entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND);
  need(judges.every((entry, index) => JSON.stringify(entry.sent.state.architecture.focus) === JSON.stringify([focus])
    && JSON.stringify(entry.sent.state.architecture) === JSON.stringify(judges[0].sent.state.architecture)
    && entry.sent.state.utterance === sent[0].sent.state.utterance
    && JSON.stringify(entry.sent.state.frame) === JSON.stringify(framesOf(judges[0].sent.state.architecture)[index]?.frame)),
  `${stage}: every judge frame sent is of [${focus}], the one section and the utterance, and they are that section's first frames in order`);
  const { displayedReason, genericReason } = await page.evaluate(async code => {
    const { reasonText } = await import("/app/src/render.mjs");
    return { displayedReason: reasonText(code), genericReason: reasonText("error") };
  }, why);
  need(typeof displayedReason === "string" && displayedReason.trim().length > 0
    && displayedReason !== genericReason
    && now.state === "failed" && (now.failure ?? "").includes(displayedReason), `${stage}: the utterance fails with ${why} (state ${now.state}: ${now.failure ?? now.status})`);
  need(JSON.stringify(now.draft) === JSON.stringify(baseline.draft) && JSON.stringify(now.claims) === JSON.stringify(baseline.claims)
    && baseline.graph !== null && JSON.stringify(now.graph) === JSON.stringify(baseline.graph)
    && now.stored === baseline.stored && now.root === baseline.root, `${stage}: nothing is drawn, drafted or stored`);
};
const claimOf = (now, record) => now.claims.find(claim => claim.record === record) ?? null;
// A role Jev gave a file, as drawn: the has-role edge, and the role's node.
const hasRole = (now, entity, role) => claimOf(now, `relation arch-has-role-${entity}-to-${role}`)?.origins.join(" ") === "model-inferred"
  && claimOf(now, `region arch-role-${role}`)?.origins.join(" ") === "scope-declared";

const verdicts = [];
const need = (condition, what) => { if (!condition) verdicts.push(what); };

// The stages in order. A stage whose outcome a later one stands on ends the
// run when it fails - nothing is undone or built on a state the next stage
// assumes - and every stage not reached is reported as not run.
const FAULTS = ["failed-frame", "incomplete-frame", "frame-extra-envelope", "judge-extra-envelope", "incomplete-judge-frame"];
const STAGES = SOURCE ? ["open", "whole", "app", "source-goal", "source-undo", "clear", "unscoped"] : GOAL ? ["open", "prepare", "goal", ...(expectedCase.kind === "none" ? [] : ["goal-undo"])] : REVERSE ? ["open", "app", "reverse", "reverse-undo"] : ["open", "whole", "whole-undo",
  ...(FIXTURE ? ["camera-undo", "camera-discard-draft", "camera-undo-render-failure", "camera-discard", "camera-discard-new"] : []),
  "app", "credential", "storage", "save", ...(FIXTURE ? ["save-again"] : []),
  ...(LOCATES ? FAULTS : []), "correction", ...(FIXTURE ? ["camera-surviving-undo"] : []),
  "apply", "reload", ...(FIXTURE ? ["camera-pending", "resize-pending"] : [])];
const reached = [];
let stoppedAt = null;
const HALT = new Error("a stage a later one stands on failed");
const PROTOCOL_HALT = new Error("protocol failure: no later action is permitted");
let protocolFailure = null;
const prerequisite = (condition, stage) => {
  if (condition) return;
  stoppedAt = stage;
  throw HALT;
};

const APP = "web-app-mjs";
const FUNCTION = "functions-api-judge-mjs";
const WORKER = "functions-pages-worker-mjs";
const ADAPTER = "web-adapters-judgment-mjs";
const LOG = "src-log-mjs";

// What the crafted answers say in fixture mode; in live mode Jev says it.
const ROLES = {
  [APP]: ["voice-input", "jev-boundary", "graph-mutation", "persistence"],
  [FUNCTION]: ["jev-boundary", "auth"],
  [WORKER]: ["jev-boundary", "auth"],
  "dev-serve-mjs": ["auth", "config"],
  "src-config-mjs": ["config"],
  "web-data-config-v1-json": ["config"],
  "dev-architecture-config-v1-json": ["config"],
  [LOG]: ["persistence"],
};
const RELATIONS = {
  [`c-${APP}--${ADAPTER}`]: "calls",
  [`c-${APP}--ext-localstorage`]: "stores-in",
  [`c-${APP}--${LOG}`]: "calls",
  [`c-${WORKER}--ext-jev-api-key`]: "authenticates-with",
  [`c-${WORKER}--ext-voice-ui-judge-provider`]: "calls",
};
const picksFor = focus => (name, sent) => {
  if (sent.kind === contract.ARCHITECTURE_JUDGE_KIND) {
    const role = Object.entries(ROLES).flatMap(([entity, roles]) => roles.map(key => [contract.roleSlot(entity, key), key]))
      .find(([slot]) => slot === name);
    if (role !== undefined) return SEMANTIC_STOP && name === contract.roleSlot(APP, "jev-boundary") ? contract.NONE : contract.YES;
    return name.startsWith("relation-") ? RELATIONS[name.slice("relation-".length)] : contract.NONE;
  }
  if (sent.kind === contract.ARCHITECTURE_LOCATE_KIND) return name === contract.relevantSlot(focus) ? contract.YES : contract.NONE;
  if (name === "action") return contract.ACTION_ARCHITECTURE;
  if (name === "focus") return LOCATES && focus !== contract.WHOLE ? contract.NONE : focus;
  return contract.NONE;
};
// In the natural fixture, a focus stage went through its locate.
const located = result => !LOCATES || result.sent.some(entry => entry.sent.kind === contract.ARCHITECTURE_LOCATE_KIND);
const codeIn = sent => JSON.stringify(sent).includes("export function") || JSON.stringify(sent).includes("\"evidence\"");

const inferredAt = (now, id) => claimOf(now, `relation ${id}`)?.origins.includes("model-inferred") === true;

let thrown = null;
let cleanup = null;
let rootBefore;
let applied = null;
let reloaded = null;
let contextEvidence = null;
let goalEvidence = null;
const GOAL_TITLE = "Goal example";
const goalScenario = async () => {
  const goalText = evaluation?.goal ?? (FLOW ? "OCIの中にAPIとDBを追加し、APIからDBへ矢印をつないで。他は変えない" : "OCIの中にAPIとDBを追加して");
  reached.push("open");
  await page.goto(PAGE, { waitUntil: "commit", timeout: 120000 });
  await ready();
  await page.locator("#text").fill(GOAL_TITLE);
  await click("new"); await settle();
  const route = new URL("/api/judge", url).href;
  reached.push("prepare");
  if (FIXTURE) await page.route(route, craft(name => name === "action" ? contract.ACTION_COMPOSE
    : name === "diagram" ? "container-example" : contract.NONE), { times: 1 });
  await page.locator("#text").fill("OCIコンテナと別グループがある準備図を作って");
  await click("send"); await settle(); await drain();
  if (FIXTURE) await page.unroute(route);
  const before = await screen(); last = before;
  const beforeLog = await page.evaluate(() => document.querySelector("#working-surface iframe[data-package=semantic-map]")
    ?.contentWindow?.semanticMapRuntime?.log ?? null);
  const preparationAnswers = exchanges.map(entry => contract.readAnswers(entry.body?.answers, slotsOf(entry.sent)));
  const seedChoice = preparationAnswers[0]?.diagram?.choice;
  const regions = before.graph?.records.filter(record => record.type === "region") ?? [];
  const root = regions.find(record => record.parent === null);
  const parentLabel = id => regions.find(record => record.id === id)?.label;
  const seedSignature = rows => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
  const seedExpected = [
    ...seed.lanes.map(lane => [lane.label, "group", root?.label]),
    ...seed.steps.map(step => [step.label, step.kind, seed.lanes.find(lane => lane.ref === step.lane).label]),
  ];
  const seedActual = regions.filter(record => record !== root)
    .map(record => [record.label, record.kind, parentLabel(record.parent)]);
  const container = before.graph?.records.find(record => record.type === "region" && record.kind === "group" && record.label === "OCI");
  need((FIXTURE ? exchanges.length === 1 : exchanges.length >= 1)
    && exchanges.every((entry, index) => entry.status === 200 && preparationAnswers[index] !== null)
    && before.state === "drafted" && container !== undefined,
    "complete preparation responses draw the public existing group");
  need(seedChoice === seed.key && root !== undefined && regions.filter(record => record.parent === null).length === 1
    && seedSignature(seedActual) === seedSignature(seedExpected)
    && before.graph.records.filter(record => record.type === "relation").length === seed.links.length,
    "the actual selected public preparation has every group and helper with the declared parent and kind");
  prerequisite(verdicts.length === 0, "prepare");
  const baselineIds = new Map(seed.steps.map(step => {
    const matches = regions.filter(record => record.label === step.label && record.kind === step.kind
      && parentLabel(record.parent) === seed.lanes.find(lane => lane.ref === step.lane).label);
    assert.equal(matches.length, 1, "actual prepared seed endpoint is unique");
    return [step.ref, matches[0].id];
  }));
  const prepared = exchanges.length;
  const crafted = [];
  if (FIXTURE) await page.route(route, craft((name, sent) => {
    if (mode === "fixture-none") return contract.NONE;
    // A controlled seen regression answered by the same public lexical selector.
    if (mode === "fixture-baseline") { crafted.push(lexicalChoice(sent.state, publicBundle.parts)); return crafted.at(-1); }
    // A controlled weak first answer: an offered choice below the confidence floor.
    if (mode === "fixture-weak") return { choice: sent.state.candidates[0].id, confidence: 0.3 };
    const group = sent.state.selected.find(item => item.key === "group")?.region;
    const next = (NEST ? [["group", container.id], ["db", group], ["api", container.id]] : [["api", container.id], ["db", container.id]])
      .find(([key]) => !sent.state.selected.some(item => item.key === key));
    if (next !== undefined) return sent.state.candidates.find(candidate => candidate.part === next[0] && candidate.parent === next[1])?.id ?? contract.NONE;
    const from = sent.state.selected.find(item => item.key === "api")?.region;
    const to = sent.state.selected.find(item => item.key === "db")?.region;
    return FLOW ? sent.state.candidates.find(candidate => candidate.action === "add-edge" && candidate.from === from && candidate.to === to)?.id ?? contract.NONE : contract.NONE;
  }, () => STOP_FIXTURE ? { status: 502, body: { error: contract.ERRORS.providerError } } : null), { times: 8 });
  else if (evaluation?.order === "reverse") await page.route(route, async intercepted => {
    const next = presentation(JSON.parse(intercepted.request().postData()));
    await intercepted.continue({ postData: JSON.stringify(next) });
  });
  reached.push("goal");
  await page.locator("#text").fill(goalText);
  await click("goal");
  // Intermediate successful draws are drafted while the same Goal still
  // owns the surface. Wait for its ownership release, not a per-step state.
  await page.waitForFunction(() => document.querySelector("#goal-cancel").hidden
    && document.body.dataset.state !== "pending", null, { timeout: 180000 });
  await drain();
  if (FIXTURE || evaluation?.order === "reverse") await page.unroute(route);
  const after = await screen(); last = after;
  const attempt = await page.evaluate(() => JSON.parse(document.body.dataset.goal));
  const sent = exchanges.slice(prepared);
  // One independent oracle for an actual after-state of this Goal: the drawn
  // product graph, or the replayed baseline graph. noneMet grades a NONE oracle.
  const grade = (records, noneMet) => {
  const added = records.filter(record => record.type === "region" && !before.graph.records.some(old => old.id === record.id));
  const newPins = records.filter(record => record.type === "layout"
    && !before.graph.records.some(old => JSON.stringify(old) === JSON.stringify(record)));
  // Parents resolve top-down: a seed group by its label before the Goal, an
  // added group as the one actual added record its own expectation matches.
  const matchOf = row => {
    const matches = added.filter(record => record.label.replace(/ [1-9]\d*$/u, "") === row.label
      && record.kind === row.kind && record.parent === row.parent);
    return matches.length === 1 ? matches[0].id : null;
  };
  const expected = expectedCase.regions.map(() => null);
  for (let pass = 0; pass < expectedCase.regions.length; pass++) expectedCase.regions.forEach((region, index) => {
    if (expected[index] !== null) return;
    const part = publicBundle.parts.find(part => part.key === region.partKey);
    if (parentShape(region) === "seed") {
      const parents = regions.filter(record => record.kind === "group" && record.label === region.parentLabel);
      assert.equal(parents.length, 1, "actual expected parent is unique");
      expected[index] = { label: part.label, kind: part.kind, parent: parents[0].id };
      return;
    }
    const owner = expected[expectedCase.regions.findIndex(other => other.partKey === region.parent.addedPart)];
    if (owner !== null) expected[index] = { label: part.label, kind: part.kind, parent: matchOf(owner) };
  });
  assert.ok(expected.every(row => row !== null), "every expected parent resolves");
  const actual = added.map(({ label, kind, parent }) => ({ label: label.replace(/ [1-9]\d*$/u, ""), kind, parent }));
  const newEdges = records.filter(record => record.type === "relation" && !before.graph.records.some(old => old.id === record.id));
  const endpointId = endpoint => {
    if (endpoint.baselineRegion !== undefined) return baselineIds.get(endpoint.baselineRegion);
    const index = expectedCase.regions.findIndex(region => region.partKey === endpoint.addedPart), target = expected[index];
    return matchOf(target);
  };
  const expectedEdges = expectedCase.flows.map(flow => ({ from: endpointId(flow.from), to: endpointId(flow.to), kind: "flow", label: "" }));
  // Only a nested oracle admits growth: a baseline pin of a non-root ancestor
  // of an actual added group, replaced once, same origin and never smaller.
  const afterRegion = id => records.find(record => record.type === "region" && record.id === id);
  const growable = new Set();
  if (NESTED) for (const group of added.filter(record => record.kind === "group"))
    for (let id = group.parent; afterRegion(id) !== undefined && afterRegion(id).parent !== null; id = afterRegion(id).parent) growable.add(id);
  const grown = NESTED ? before.graph.records.filter(record => record.type === "layout"
    && !records.some(next => JSON.stringify(next) === JSON.stringify(record))) : [];
  const grownMet = grown.every(record => {
    const next = records.filter(item => item.type === "layout" && item.regionId === record.regionId);
    return growable.has(record.regionId) && next.length === 1
      && JSON.stringify({ ...next[0], bounds: null }) === JSON.stringify({ ...record, bounds: null })
      && next[0].bounds[0] === record.bounds[0] && next[0].bounds[1] === record.bounds[1]
      && next[0].bounds[2] >= record.bounds[2] && next[0].bounds[3] >= record.bounds[3];
  });
  const baselinePreserved = grownMet && before.graph.records.every(record => grown.includes(record)
    || records.some(next => JSON.stringify(next) === JSON.stringify(record)));
  const semanticMet = signature(actual) === signature(expected) && edgeSignature(newEdges) === edgeSignature(expectedEdges)
    && baselinePreserved && (expectedCase.kind !== "none" || noneMet(newPins));
  const pinsExact = exactChildPins([...added, ...grown.map(record => ({ id: record.regionId }))], newPins);
  return { added, newPins, expected, actual, newEdges, expectedEdges, afterRegion, grown, baselinePreserved, semanticMet, pinsExact };
  };
  const signature = rows => JSON.stringify(rows.map(({ label, kind, parent }) => JSON.stringify([label, kind, parent])).sort());
  const edgeSignature = edges => JSON.stringify(edges.map(({ from, to, kind, label }) => JSON.stringify([from, to, kind, label])).sort());
  const firstNone = sent.length === 1 && sent[0].sent.state.candidates.length > 0
    && contract.readAnswers(sent[0].body?.answers, slotsOf(sent[0].sent))?.delta?.choice === contract.NONE;
  const { added, newPins, expected, actual, newEdges, expectedEdges, afterRegion, grown, baselinePreserved, semanticMet, pinsExact }
    = grade(after.graph.records, pins => firstNone && pins.length === 0 && sameNoneBaseline(before, after));
  const api = added.find(record => record.label.replace(/ [1-9]\d*$/u, "") === "API");
  const db = added.find(record => record.label.replace(/ [1-9]\d*$/u, "") === "DB");
  const labelsVisible = await Promise.all(added.map(record => labelVisible(record.label)));
  const paintedRecords = after.graph.records.filter(record => record.type === "region" && record.parent === container.id);
  const painted = await paintedGoal(container, paintedRecords, FLOW ? { from: api?.id, to: db?.id } : null);
  const reversedPaint = FLOW ? await paintedGoal(container, paintedRecords, { from: db?.id, to: api?.id }) : null;
  const disconnectedPaint = FLOW ? await paintedGoal(container, paintedRecords,
    { from: api?.id, to: paintedRecords.find(record => record.id !== api?.id && record.id !== db?.id)?.id }) : null;
  const paintedGroups = await Promise.all([...(expectedCase.kind === "none" ? [container.id] : new Set(expected.map(record => record.parent)))].map(id =>
    paintedGoal(afterRegion(id) ?? { label: null }, after.graph.records.filter(record => record.type === "region" && record.parent === id))));
  const edgePaints = await Promise.all(expectedEdges.map(edge => paintedGoal(container,
    after.graph.records.filter(record => record.type === "region" && record.parent !== null && record.kind !== "group"), edge)));
  const edgeCounterPaints = await Promise.all(expectedEdges.map(async edge => {
    const endpoints = after.graph.records.filter(record => record.type === "region" && record.parent !== null && record.kind !== "group");
    const expectedPair = (from, to) => expectedEdges.some(expected => expected.from === from && expected.to === to);
    const reverseApplicable = !expectedPair(edge.to, edge.from);
    const other = endpoints.find(record => record.id !== edge.from && record.id !== edge.to && !expectedPair(edge.from, record.id));
    return { from: edge.from, to: edge.to,
      reverseApplicable, disconnectedApplicable: other !== undefined,
      reverse: reverseApplicable ? await paintedGoal(container, endpoints, { from: edge.to, to: edge.from }) : null,
      disconnected: other ? await paintedGoal(container, endpoints, { from: edge.from, to: other.id }) : null };
  }));
  // goal-nest only. The default overview is read as the provider scene reports
  // it (its own open groups and represented regions): a small added group may
  // be closed there, which is recorded and never graded as painted. The
  // existing camera control then opens that group, and the nested child, its
  // label and each expected arrow are proven on that actual frame.
  const sceneOf = () => page.evaluate(() => {
    const scene = document.querySelector("#working-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapApp?.snapshot().scene;
    return scene ? { detailIds: [...scene.detailIds], regionIds: [...scene.regionIds] } : null;
  });
  const groupMet = group => group.complete && group.contained && group.nonoverlap;
  const expectedPair = (from, to) => expectedEdges.some(expected => expected.from === from && expected.to === to);
  const nestedGroup = NEST ? added.find(record => record.kind === "group" && added.some(child => child.parent === record.id)) ?? null : null;
  const nestedChildren = nestedGroup === null ? [] : added.filter(record => record.parent === nestedGroup.id);
  let nest = null;
  if (NEST) {
    const scene = await sceneOf();
    const overview = { view: after.graph.view, groupOpen: nestedGroup !== null && scene?.detailIds.includes(nestedGroup.id) === true,
      childrenRepresented: nestedChildren.map(record => scene?.regionIds.includes(record.id) === true),
      childrenPainted: paintedGroups.find(group => group.container.id === nestedGroup?.id)?.shapes.map(shape => shape.bounds !== null) ?? [] };
    overview.closed = nestedGroup !== null && scene !== null && !overview.groupOpen
      && overview.childrenRepresented.every(value => !value) && overview.childrenPainted.every(value => !value);
    let camera = null;
    if (nestedGroup !== null) {
      await page.locator("#camera-part").selectOption(nestedGroup.id); await settle();
      const opened = await screen(); const openedScene = await sceneOf();
      const endpoints = after.graph.records.filter(record => record.type === "region" && record.parent !== null && record.kind !== "group");
      const unchanged = now => JSON.stringify(now.graph?.records) === JSON.stringify(after.graph.records)
        && now.stored === after.stored && now.root === after.root;
      // The group camera alone proves the opened group, its children and their paint.
      camera = { part: opened.camera, state: opened.state, status: opened.status, view: opened.graph?.view ?? null,
        confirmedView: opened.confirmedGraph?.view ?? null,
        recordsUnchanged: JSON.stringify(opened.graph?.records) === JSON.stringify(after.graph.records),
        storedUnchanged: opened.stored === after.stored && opened.root === after.root,
        groupOpen: openedScene?.detailIds.includes(nestedGroup.id) === true,
        childrenRepresented: nestedChildren.map(record => openedScene?.regionIds.includes(record.id) === true),
        groupLabels: await Promise.all(added.map(record => labelVisible(record.label))),
        groupPaint: await paintedGoal(nestedGroup, after.graph.records.filter(record => record.type === "region" && record.parent === nestedGroup.id)) };
      // Each expected arrow: the group camera, then the existing camera on its
      // from end, then its to end; the first frame showing the whole matched
      // arrow is graded with that same frame negatives.
      const arrow = edge => measureArrow(container, endpoints, edge,
        { reverseExpected: expectedPair(edge.to, edge.from), related: (from, id) => expectedPair(from, id) });
      const edges = [];
      for (const edge of expectedEdges) {
        const frames = [{ camera: nestedGroup.id, ...(await arrow(edge)) }];
        for (const part of [edge.from, edge.to]) {
          if (frames.at(-1).inView) break;
          await page.locator("#camera-part").selectOption(part); await settle();
          frames.push({ camera: part, ...(await arrow(edge)), recordsUnchanged: unchanged(await screen()) });
        }
        if (frames.length > 1) { await page.locator("#camera-part").selectOption(nestedGroup.id); await settle(); }
        const frame = frames.at(-1);
        edges.push({ from: edge.from, to: edge.to, frame, met: frame.met && frames.every(item => item.recordsUnchanged !== false),
          frames: frames.map(item => ({ camera: item.camera, viewport: item.viewport, endBounds: item.endBounds, inView: item.inView,
            matches: item.edge?.matches.map(({ start, tip }) => ({ start, tip })) ?? [] })) });
      }
      camera.edges = edges;
      // An added label shows on the group camera or on its own existing camera.
      camera.labelsVisible = [];
      for (const [index, record] of added.entries()) {
        if (camera.groupLabels[index]) { camera.labelsVisible.push(true); continue; }
        await page.locator("#camera-part").selectOption(record.id); await settle();
        camera.labelsVisible.push(unchanged(await screen()) && await labelVisible(record.label));
      }
      await page.locator("#camera-part").selectOption(""); await settle();
      const back = await screen(); last = back;
      camera.overviewRestored = back.camera === "" && JSON.stringify(back.graph?.view) === JSON.stringify(after.graph.view)
        && JSON.stringify(back.graph?.records) === JSON.stringify(after.graph.records)
        && back.stored === after.stored && back.root === after.root;
    }
    nest = { overview, camera };
    nest.cameraMet = camera !== null && camera.state === "camera" && camera.part === nestedGroup.id && camera.view !== null
      && (camera.confirmedView === null ? after.confirmedGraph === null : JSON.stringify(camera.confirmedView) === JSON.stringify(camera.view))
      && camera.recordsUnchanged && camera.storedUnchanged && camera.groupOpen && camera.childrenRepresented.every(Boolean)
      && camera.labelsVisible.every(Boolean) && groupMet(camera.groupPaint) && camera.edges.length === expectedEdges.length
      && camera.groupLabels.every((visible, index) => !nestedChildren.includes(added[index]) || visible)
      && camera.edges.every(edge => edge.met)
      && camera.overviewRestored;
  }
  const labelsMet = labelsVisible.length === expected.length && (NEST
    ? nest.cameraMet && labelsVisible.every((visible, index) => visible || nest.overview.closed && nestedChildren.includes(added[index]))
    : labelsVisible.every(Boolean));
  const groupsMet = NEST
    ? nest.cameraMet && paintedGroups.every(group => group.container.id === nestedGroup?.id ? nest.overview.closed || groupMet(group) : groupMet(group))
    : paintedGroups.every(groupMet);
  const edgePaintMet = NEST ? nest.cameraMet : edgePaints.every(proof => proof.edge.complete)
    && edgeCounterPaints.every(proof => (!proof.reverseApplicable || !proof.reverse.edge.complete)
      && (!proof.disconnectedApplicable || !proof.disconnected.edge.complete));
  const paintMet = labelsMet && groupsMet && edgePaintMet;
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Independent public-information baseline: literal catalogue/parent name
  // matching. No gold remainder or baseline decision goes to the product.
  const baselineStart = performance.now();
  const firstPublicState = sent[0]?.sent.state;
  const namedParents = (firstPublicState?.parents ?? []).filter(parent => goalText.toLowerCase().includes(parent.label.toLowerCase()));
  const baselineKeys = (firstPublicState?.offers.parts ?? []).filter(part => goalText.toLowerCase().includes(part.key)).map(part => part.key);
  const baseline = namedParents.length !== 1 ? [] : baselineKeys.map(key => {
    const part = publicBundle.parts.find(part => part.key === key);
    return { label: part.label, kind: part.kind, parent: namedParents[0].id };
  });
  const baselineElapsedMs = performance.now() - baselineStart;
  goalEvidence = { reason: attempt.reason, goalMet: semanticMet, requests: sent.length, setupRequests: prepared,
    evaluation: { id: evaluation?.id ?? scenario, version: "voice-ui.goal-evaluation.v1", inputHash: digest(evaluation ?? { goal: goalText, expected: expectedCase, order: "normal" }),
      source: SERVED_COMMIT, order: evaluation?.order ?? "normal", orderInterventions, expected, expectedEdges,
    firstNone, baselinePreserved, grownPins: grown.map(record => record.regionId), semanticGrade: "NOT_PROVEN", paintGrade: "NOT_PROVEN" },
    preparationDiagram: seedChoice, preparationSignature: seedActual,
    selected: attempt.selected, actual, rawAdded: added.map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
    painted, paintedGroups, edgePaints, edgeCounterPaints, reversedPaint, disconnectedPaint, nest, newPins, pinsExact, newEdges, labelsVisible, baseline, baselineMet: expectedEdges.length === 0 && signature(baseline) === signature(expected),
    timeBudgetMet: Number.isFinite(attempt.elapsedMs) && attempt.elapsedMs < 180000,
    elapsed: { productMs: attempt.elapsedMs, productScope: "HTTP+planning+draw",
      baselineMs: baselineElapsedMs, baselineScope: "literal-selection-CPU-only", baselineProviderCalls: 0 },
    internalModelExecutions: "UNKNOWN", providerCost: "UNKNOWN",
    addedValue: "NOT_PROVEN", graphBefore: digest(before.graph.records), graphAfter: digest(after.graph.records),
    undoRestored: false, noSave: after.stored === before.stored && after.root === before.root,
    exchanges: sent.map(sanitized), setupExchanges: exchanges.slice(0, prepared).map(sanitized),
    requestHistories: sent.map(entry => entry.sent.state.selected),
    questionCounts: sent.map(entry => Object.keys(slotsOf(entry.sent)).length),
    providerIdentity: "UNKNOWN", acceptedIntegration: "NOT_PROVEN" };
  need(sent.length >= 1 && sent.length <= 8 && sent.every(entry => entry.sent.kind === contract.GOAL_REQUEST_KIND
    && entry.sent.state.utterance === goalText && contract.isRequest(entry.sent)), "bounded requests carry the one Goal and closed public state");
  need(attempt.requests === sent.length, "logical request accounting matches actual application requests");
  need(after.stored === before.stored && after.root === before.root, "Goal never saves");
  if (STOP_FIXTURE) {
    assert.equal(sent.length, 1); assert.equal(sent[0].status, 502);
    assert.equal(attempt.reason, "judge-failed"); assert.deepEqual(attempt.selected, []);
    assert.deepEqual(after.graph.records, before.graph.records); assert.deepEqual(after.draft, before.draft);
    assert.deepEqual(verdicts, []);
    return;
  }
  // The preregistered deterministic lexical baseline (PR #60): one selector over
  // the actual public request only, replayed in the page through the served
  // production Goal core. Its session is rebuilt by the served production
  // session/turn/architecture constructors from the actual title and recorded
  // preparation requests and answers; each rebuilt preparation request, the
  // resulting log/head/records and the first Goal request must equal what was
  // actually observed. It never sees the oracle.
  const replay = await page.evaluate(async ({ log, title, preparation, utterance, bundleUrl, sourceUrl, selectorSource }) => {
    const modules = ["/app/src/goal.mjs", "/app/src/bundle.mjs", "/ui/semantic-map/protocol/index.js",
      "/app/src/session.mjs", "/app/src/turn.mjs", "/app/src/architecture.mjs"];
    const loaded = new Set(performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname));
    const [{ runGoal }, { readBundle }, protocol, { createSession, startNew, propose, draftForJudgment, recentConversation },
      { requestFor, focusFor }, { readManifest, withArchitecture }] = await Promise.all(modules.map(path => import(path)));
    const bundle = readBundle(await (await fetch(bundleUrl)).json());
    const manifest = readManifest(await (await fetch(sourceUrl)).json());
    let session = (await startNew(createSession({ accepted: null, stored: null }), { title, protocol })).session;
    const preparedEqual = [];
    for (const { sent, answers } of preparation) {
      const working = session.working;
      const layout = protocol.layoutBoundsFor(working.records, { pattern: protocol.GRAPH_PATTERN });
      const steps = draftForJudgment(session);
      const plain = requestFor({ working, utterance: sent.state.utterance, bundle, layout, offeredFrame: null, draft: steps,
        focus: focusFor({ draft: steps, lastApplied: [] }), pending: null, recent: recentConversation(session).recent });
      const bound = withArchitecture(plain, manifest);
      const request = { ...bound.request, state: { ...bound.request.state,
        context: { recent: recentConversation(session, { architecture: true }).recent } } };
      preparedEqual.push(JSON.stringify(request) === JSON.stringify(sent));
      session = (await propose(session, { turn: bound.turn, answers, protocol, bundle, layout, visibleFrame: null,
        input: Object.freeze({ source: "typed", text: sent.state.utterance }), repair: null })).session;
    }
    const working = session.working;
    const provenance = { issuedPartIds: [...session.issuedPartIds], nextSeq: session.nextSeq,
      conversation: session.conversation.length, draft: session.draft.length };
    const lexical = (0, eval)("(" + selectorSource + ")");
    const select = state => lexical(state, bundle.parts);
    let first = null;
    const choices = [];
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
      ask: async request => {
        first ??= JSON.parse(JSON.stringify(request));
        choices.push(select(request.state));
        return { kind: "answered", decision: { answers: { delta: { type: "choice", choice: choices.at(-1), confidence: 1 } } } };
      },
      adopt: async next => { session = next; } });
    return { head: working.head, startRecords: working.records, first, choices, reason: result.reason, requests: result.requests,
      sameLog: working.log === log, preparedEqual, provenance,
      records: session.working.records, modulesLoadedByPage: modules.every(path => loaded.has(path)) };
  }, { log: beforeLog, title: GOAL_TITLE, utterance: goalText, selectorSource: lexicalChoice.toString(),
    preparation: exchanges.slice(0, prepared).map(entry => ({ sent: entry.sent, answers: entry.body?.answers })),
    bundleUrl: new URL(config.data.bundle, url).href, sourceUrl: new URL(config.data.source, url).href });
  const fairNone = replay.choices[0] === contract.NONE && JSON.stringify(replay.records) === JSON.stringify(before.graph.records);
  const fair = grade(replay.records, () => fairNone);
  goalEvidence.fairBaseline = { selector: "PR60 deterministic lexical, NFKC lowercase longest mention", reason: replay.reason,
    requests: replay.requests, choices: replay.choices, grade: fair.semanticMet ? "PASS" : "NOT_MET", actual: fair.actual,
    newEdges: fair.newEdges.map(({ from, to, kind }) => ({ from, to, kind })),
    // Observed: log, head, records, each preparation request and the first Goal
    // request. Constructor-derived only: issued IDs, sequence, conversation and
    // draft count; new reserved IDs are not proven by the first request.
    replay: { preparedEqual: replay.preparedEqual.length > 0 && replay.preparedEqual.every(Boolean),
      sameStart: replay.sameLog && replay.head === before.graph.head && JSON.stringify(replay.startRecords) === JSON.stringify(before.graph.records),
      firstRequestEqual: replay.first !== null && JSON.stringify(replay.first) === JSON.stringify(sent[0]?.sent),
      modulesLoadedByPage: replay.modulesLoadedByPage, constructorProvenance: replay.provenance },
    scope: "CPU replay of semantic outcome only; no HTTP, paint, speed or Jev superiority claim" };
  if (!(goalEvidence.fairBaseline.replay.preparedEqual && goalEvidence.fairBaseline.replay.sameStart
    && goalEvidence.fairBaseline.replay.firstRequestEqual)) goalEvidence.fairBaseline.grade = "NOT_MET (score withheld: start differs)";
  need(goalEvidence.fairBaseline.replay.preparedEqual && goalEvidence.fairBaseline.replay.sameStart && goalEvidence.fairBaseline.replay.firstRequestEqual
    && goalEvidence.fairBaseline.replay.modulesLoadedByPage,
  "the baseline rebuilds the actual pre-Goal session with the served constructors and asks the actual first request");
  if (mode === "fixture-baseline") {
    goalEvidence.fairBaseline.craftedChoices = crafted;
    goalEvidence.fairBaseline.craftEqual = JSON.stringify(crafted) === JSON.stringify(replay.choices);
    need(goalEvidence.fairBaseline.craftEqual, "the Node fixture answers and the in-page replay choices of the one selector are equal");
  }
  need(sent.every(entry => entry.status === 200 && contract.readAnswers(entry.body?.answers, slotsOf(entry.sent)) !== null), "every Goal response is complete");
  need(["none", "no-executable-delta", "budget-requests", "budget-time"].includes(attempt.reason) && semanticMet,
    "independent expected graph is reached after a known mechanical stop, never from the stop alone");
  need(labelsMet, NEST ? "added labels intersect the overview, but a child of an observed closed group, which the selected group camera shows"
    : "all actual added labels intersect the unchanged Working viewport");
  need(groupsMet, NEST ? "painted children sit inside their painted group without overlap; a closed added group is proven open on its camera"
    : "actual painted children are wholly inside the painted OCI shape and do not overlap siblings");
  if (expectedEdges.length > 0) need(edgePaintMet,
    "each expected actual painted classic arrow connects its declared endpoints, not the reverse or another visible part");
  need(pinsExact, "each actual added child gains exactly one new layout pin and no other owner gains one, but an allowed grown ancestor");
  need(goalEvidence.timeBudgetMet && attempt.elapsedMs >= 0, "the independently graded Goal time envelope is met");
  need(baselinePreserved, "Goal preserves every baseline record, but a grown ancestor pin under a nested oracle");
  goalEvidence.evaluation.semanticGrade = semanticMet && goalEvidence.noSave && goalEvidence.timeBudgetMet
    && Number.isFinite(attempt.elapsedMs) && attempt.elapsedMs >= 0 && attempt.requests === sent.length
    && sent.length >= 1 && sent.length <= 8 && sent.every(entry => entry.status === 200
      && entry.error === null && contract.isRequest(entry.sent) && entry.sent.state.utterance === goalText
      && contract.readAnswers(entry.body?.answers, slotsOf(entry.sent)) !== null)
    && ["none", "no-executable-delta", "budget-requests", "budget-time"].includes(attempt.reason)
    && pinsExact ? "PASS" : "NOT_MET";
  goalEvidence.evaluation.paintGrade = paintMet ? "PASS" : "NOT_MET";
  if (expectedCase.kind === "none") {
    for (const key of ["draft", "claims", "stored", "root", "confirmedGraph"]) assert.deepEqual(after[key], before[key], key);
    for (const entry of exchanges) entry.reported = true;
    return;
  }
  // Only an adopted step is taken back; a Goal that adopted nothing changed nothing.
  if (after.graph.head === before.graph.head) {
    for (const key of ["draft", "claims", "stored", "root", "confirmedGraph"]) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(after.graph.records, before.graph.records);
    goalEvidence.goalEffect = "none";
    for (const entry of exchanges) entry.reported = true;
    return;
  }
  goalEvidence.goalEffect = "adopted";
  reached.push("goal-undo"); await click("undo"); await settle();
  const reverted = await screen(); last = reverted;
  for (const key of ["draft", "claims", "stored", "root", "confirmedGraph"]) assert.deepEqual(reverted[key], before[key], key);
  assert.deepEqual(reverted.graph.records, before.graph.records);
  goalEvidence.undoRestored = true;
  for (const entry of exchanges) entry.reported = true;
};
// goal-source on one page: the whole account, the page code in focus, then a
// Goal scoped by that remembered focus, which resolves its arrow by an intent
// request before each change. In fixture mode the app focus is located as four
// parts; the first resolve holds the first pair of drawn parts, by sorted ID,
// touching the focus with no relation in either direction, every resolve names
// it and the Goal request takes its one arrow, so the next resolve finds it
// drawn and the Goal stops with no executable delta: a trial arrow, never a
// source fact. In live mode the finite --goal-case names the expected
// arrow by served manifest entities and no answer is crafted. Whole Goal Undo,
// clearing the conversation, then the same utterance has no reference left.
const SOURCE_GOAL = "さっき詳しく見た画面のコードにつながる試案の矢印を1本つないで";
let sourceEvidence = null;
const goalDone = () => page.waitForFunction(() => document.querySelector("#goal-cancel").hidden
  && document.body.dataset.state !== "pending", null, { timeout: 180000 });
const sourceScenario = async () => {
  const goalText = evaluation?.goal ?? SOURCE_GOAL;
  reached.push("open");
  await page.goto(PAGE, { waitUntil: "commit", timeout: 120000 });
  await ready();
  await page.locator("#text").fill("voice-ui の構成");
  await click("new"); await settle();
  reached.push("whole");
  const whole = await say("whole", UTTERANCES.whole, picksFor(contract.WHOLE));
  prerequisite(whole.now.state === "drafted", "whole");
  // The drawn whole account stays; its size is recorded.
  const wholeSize = { regions: whole.now.graph.records.filter(record => record.type === "region").length,
    relations: whole.now.graph.records.filter(record => record.type === "relation").length };
  reached.push("app");
  // The controlled fixture locates the app focus as the four files that name
  // browser storage, so the Goal is scoped by a located multi-part focus; the
  // utterance and live preparation are unchanged.
  const SOURCE_FOCUS = ["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"];
  const app = await say("app", UTTERANCES.app, (name, sent) => sent.kind === contract.ARCHITECTURE_LOCATE_KIND
    ? (SOURCE_FOCUS.some(id => name === contract.relevantSlot(id)) ? contract.YES : contract.NONE) : picksFor(APP)(name, sent));
  const reference = app.now.context.at(-1)?.reference ?? null;
  if (FIXTURE) need(SOURCE_FOCUS.every(id => ENTITY_IDS.includes(id)) && JSON.stringify(reference?.focus) === JSON.stringify(SOURCE_FOCUS),
    "the controlled app focus is located as the four files that name browser storage");
  need(app.now.state === "drafted" && reference?.source.commit === SERVED_COMMIT
    && JSON.stringify(reference.focus) === JSON.stringify(app.sent.at(-1)?.sent.state.architecture.focus),
  "the app focus is drawn and the DOM remembers its actual judged source and focus");
  prerequisite(verdicts.length === 0, "app");
  const before = app.now;
  const route = new URL("/api/judge", url).href;
  const related = (edges, from, to) => edges.some(edge => edge.from === from && edge.to === to || edge.from === to && edge.to === from);
  const focusRegions = (reference?.focus ?? []).map(id => `arch-${id}`);
  const flow = evaluation?.expected.flows[0] ?? null;
  let chosen = null;
  if (FIXTURE) await page.route(route, craft((name, sent) => {
    if (sent.kind === contract.ARCHITECTURE_INTENT_KIND) {
      if (chosen === null) {
        const ids = sent.state.graph.regions.map(region => region.id).sort();
        search: for (const from of ids) for (const to of ids) {
          if (from !== to && (focusRegions.includes(from) || focusRegions.includes(to)) && !related(sent.state.graph.edges, from, to)) {
            chosen = { from, to }; break search;
          }
        }
      }
      return name === "action" ? (chosen === null ? contract.NONE : contract.ACTION_ADD_EDGE)
        : name === "source" ? chosen?.from ?? contract.NONE : name === "target" ? chosen?.to ?? contract.NONE : contract.NONE;
    }
    return sent.state.candidates.find(item => item.action === "add-edge" && item.from === chosen?.from && item.to === chosen?.to)?.id ?? contract.NONE;
  }), { times: 8 });
  const prior = exchanges.length;
  reached.push("source-goal");
  await page.locator("#text").fill(goalText);
  await click("goal"); await goalDone(); await drain();
  if (FIXTURE) await page.unroute(route);
  const after = await screen(); last = after;
  const attempt = await page.evaluate(() => JSON.parse(document.body.dataset.goal));
  const sent = exchanges.slice(prior);
  for (const entry of sent) entry.reported = true;
  // The Goal request by its kind: a scoped Goal first asks its resolve intent.
  const request = sent.find(entry => entry.sent.kind === contract.GOAL_REQUEST_KIND)?.sent.state ?? null;
  // The expected arrow: the controlled choice, or the evaluator data resolved
  // against the served manifest and the actual pre-Goal Working.
  const target = FIXTURE ? (chosen === null ? null : { from: chosen.from, to: chosen.to })
    : flow === null ? null : { from: "arch-" + flow.from.baselineRegion, to: "arch-" + flow.to.baselineRegion };
  const endpointOf = (records, id) => records.find(record => record.type === "region" && record.id === id
    && record.parent !== null && record.kind !== "group") ?? null;
  const beforeRelations = before.graph.records.filter(record => record.type === "relation");
  // Eligible is structural, on the full pre-Goal Working and the focus; offered
  // is what the Goal request actually carried. A different resolved pair is
  // not offered: NOT_MET, never success.
  const eligible = target !== null && target.from !== target.to
    && endpointOf(before.graph.records, target.from) !== null && endpointOf(before.graph.records, target.to) !== null
    && (focusRegions.includes(target.from) || focusRegions.includes(target.to))
    && !related(beforeRelations, target.from, target.to);
  const offered = eligible && request !== null
    && request.candidates.some(item => item.action === "add-edge" && item.from === target.from && item.to === target.to);
  const newEdges = after.graph.records.filter(record => record.type === "relation" && !before.graph.records.some(old => old.id === record.id));
  const nonLayout = records => records.filter(record => record.type !== "layout");
  sourceEvidence = { source: SERVED_COMMIT, mode, focus: reference?.focus ?? null, utterance: goalText,
    wholeSize, goalWorkingSize: { regions: before.graph.records.filter(record => record.type === "region").length,
      relations: beforeRelations.length },
    scopeMatchesReference: request !== null && JSON.stringify(request.scope)
      === JSON.stringify(reference === null ? null : { source: reference.source, focus: reference.focus }),
    contextMatches: request !== null && JSON.stringify(request.context.recent)
      === JSON.stringify(before.context.map(({ reference: _, ...entry }) => entry)),
    candidates: request?.candidates.length ?? 0,
    edgesTouchFocus: request !== null && request.candidates.filter(item => item.action === "add-edge")
      .every(item => focusRegions.includes(item.from) || focusRegions.includes(item.to)),
    target, targetBy: FIXTURE ? "controlled: first sorted pair touching the focus with no relation either way, named by every resolve" : "evaluator goal-case",
    eligible, offered, resolves: sent.filter(entry => entry.sent.kind === contract.ARCHITECTURE_INTENT_KIND).length,
    reason: attempt.reason, requests: attempt.requests, exchanges: sent.map(sanitized),
    newEdges: newEdges.map(({ id, from, to, kind }) => ({ id, from, to, kind })),
    newEdgeDrawn: eligible && newEdges.length === 1 && newEdges[0].from === target.from && newEdges[0].to === target.to
      && JSON.stringify(nonLayout(after.graph.records).filter(record => record.id !== newEdges[0].id))
        === JSON.stringify(nonLayout(before.graph.records)),
    paint: null, understanding: "NOT_PROVEN" };
  need(sourceEvidence.scopeMatchesReference && sourceEvidence.contextMatches, "the Goal carries the remembered source focus and the prior plain conversation");
  need(sourceEvidence.candidates >= 1 && sourceEvidence.candidates <= 254 && sourceEvidence.edgesTouchFocus, "the scoped catalogue is bounded and every arrow touches the focus");
  need(eligible, "the expected arrow joins two drawn parts, touches the focus and has no relation either way on the pre-Goal Working; otherwise INELIGIBLE");
  need(offered, "the Goal request offers the expected arrow; a different resolved pair is NOT_MET");
  need((FIXTURE ? attempt.reason === "no-executable-delta" && attempt.requests === 3
      && JSON.stringify(sent.map(entry => entry.sent.kind))
        === JSON.stringify([contract.ARCHITECTURE_INTENT_KIND, contract.GOAL_REQUEST_KIND, contract.ARCHITECTURE_INTENT_KIND])
    : ["none", "no-executable-delta", "budget-requests", "budget-time"].includes(attempt.reason)) && sourceEvidence.newEdgeDrawn,
  "the Goal draws exactly the one new expected arrow, keeps every old record, and stops mechanically");
  // The actual painted arrow at its named ends, by the existing observer, with
  // its reverse and a disconnected visible part as negatives. The container is
  // the shared actual parent, or the actual root.
  if (sourceEvidence.newEdgeDrawn) {
    const endpoints = after.graph.records.filter(record => record.type === "region" && record.parent !== null && record.kind !== "group");
    const ends = [target.from, target.to].map(id => endpointOf(after.graph.records, id));
    const container = after.graph.records.find(record => record.type === "region"
      && (ends[0].parent === ends[1].parent ? record.id === ends[0].parent : record.parent === null));
    const afterRelations = after.graph.records.filter(record => record.type === "relation");
    const measure = async camera => {
      const visible = await Promise.all(endpoints.map(record => labelVisible(record.label)));
      const measured = await measureArrow(container, endpoints, target, { related: (from, id) => related(afterRelations, from, id) });
      return { camera, container: container.id, ...measured, endsVisible: ends.map(record => visible[endpoints.indexOf(record)]) };
    };
    // The overview first, then the existing camera on the from end, then the
    // to end, then the camera on the new arrow itself, each on unchanged
    // records and storage; the first frame that shows the whole matched arrow
    // is graded, with its own negatives. The arrow camera must be offered by
    // exactly one option; otherwise that frame is recorded unmet and nothing
    // stands in for it.
    const frames = [await measure("")];
    for (const camera of [target.from, target.to, newEdges[0].id]) {
      if (frames.at(-1).inView) break;
      if (camera === newEdges[0].id) {
        const offered = await page.locator("#camera-part option")
          .evaluateAll((options, id) => options.filter(option => option.value === id).length, camera);
        if (offered !== 1) { frames.push({ camera, offered, inView: false, met: false, edge: { matches: [] } }); break; }
      }
      await page.locator("#camera-part").selectOption(camera); await settle();
      const focused = await screen();
      frames.push({ ...(await measure(camera)),
        recordsUnchanged: JSON.stringify(focused.graph?.records) === JSON.stringify(after.graph.records) && focused.stored === after.stored });
    }
    if (frames.length > 1) { await page.locator("#camera-part").selectOption(""); await settle(); }
    const paint = { ...frames.at(-1), frames: frames.map(({ camera, viewport, endBounds, endsVisible, inView, edge }) =>
      ({ camera, viewport, endBounds, endsVisible, inView, matches: edge.matches.map(({ start, tip }) => ({ start, tip })) })) };
    paint.met = paint.met && frames.every(frame => frame.recordsUnchanged !== false);
    sourceEvidence.paint = paint;
  }
  need(sourceEvidence.paint?.met === true, "on one actual frame the matched stroke start and marker tip lie in the zero-margin viewport and both associated end shapes intersect it; its reverse and a disconnected part do not connect");
  prerequisite(verdicts.length === 0, "source-goal");
  reached.push("source-undo");
  const beforeUndo = exchanges.length;
  await click("undo"); await settle();
  const undone = await screen(); last = undone;
  sourceEvidence.undoRestored = exchanges.length === beforeUndo && undone.graph?.head === before.graph.head
    && ["graph", "draft", "claims", "stored", "root", "confirmedGraph"].every(key => JSON.stringify(undone[key]) === JSON.stringify(before[key]));
  need(sourceEvidence.undoRestored, "whole-Goal Undo restores the pre-Goal Working, draft, claims, storage and confirmed view");
  reached.push("clear");
  await page.locator("#context-clear").click(); await settle();
  const cleared = await screen(); last = cleared;
  sourceEvidence.clearKeepsGraphs = cleared.context.length === 0
    && ["graph", "draft", "claims", "stored", "root", "confirmedGraph"].every(key => JSON.stringify(cleared[key]) === JSON.stringify(undone[key]));
  need(sourceEvidence.clearKeepsGraphs, "clearing the conversation leaves Working and Accepted byte-equal");
  reached.push("unscoped");
  const beforeUnscoped = exchanges.length;
  if (FIXTURE) await page.route(route, craft(() => contract.NONE), { times: 8 });
  await page.locator("#text").fill(goalText);
  await click("goal"); await goalDone(); await drain();
  if (FIXTURE) await page.unroute(route);
  const unscoped = await page.evaluate(() => JSON.parse(document.body.dataset.goal));
  const final = await screen(); last = final;
  sourceEvidence.unscoped = { reason: unscoped.reason, requests: unscoped.requests, newExchanges: exchanges.length - beforeUnscoped };
  need(unscoped.reason === "candidate-overflow" && unscoped.requests === 0 && exchanges.length === beforeUnscoped
    && JSON.stringify(final.graph) === JSON.stringify(cleared.graph),
  "without the remembered reference the same utterance overflows before any provider request");
  report({ event: "source-evidence", ...sourceEvidence });
};
const runScenario = async () => {
  if (SOURCE) return sourceScenario();
  if (GOAL) return goalScenario();
  // The slash-less path is sent to the architecture page's own path.
  reached.push("open");
  const opened = await page.goto(PAGE, { waitUntil: "commit", timeout: 120000 });
  assert.ok(opened.url().endsWith("/architecture/"), `a 308 leads to /architecture/, not ${opened.url()}`);
  await ready();
  const start = await screen();
  last = start;
  assert.equal(start.shown, true, "the architecture account is shown on this page");
  assert.notEqual(start.state, "failed", `the prepared source must be available: ${start.failure}`);
  assert.match(start.sourceStatus, /^出典: apps-voice-ui@[0-9a-f]{40}$/u);
  assert.ok(start.coverage.some(line => /dynamic import/u.test(line)), "what was not analyzed is listed");
  assert.ok(start.coverage.some(line => /取り込み対象外: dist\.py/u.test(line)), "what was not admitted is listed");
  rootBefore = start.root;

  // The person names a new map; nothing is saved yet.
  await page.locator("#text").fill("voice-ui の構成");
  await click("new");
  await settle();
  assert.equal((await screen()).state, "drafted");

  if (!REVERSE) {
  // (1) The whole architecture: structure only, one request, no code sent.
  reached.push("whole");
  const whole = await say("whole", UTTERANCES.whole, picksFor(contract.WHOLE));
  need(whole.sent.length === 1 && whole.sent[0].sent.kind === contract.ARCHITECTURE_INTENT_KIND, "the whole view is one intent");
  need(whole.sent.every(entry => !codeIn(entry.sent)), "the page never sends source text");
  need(whole.now.state === "drafted", `the whole view was drafted (state ${whole.now.state}: ${whole.now.failure ?? whole.now.status})`);
  need(claimOf(whole.now, `region arch-${APP}`)?.origins.includes("source-declared"), "the page's file is drawn from the source");
  need(whole.now.claims.every(claim => !claim.origins.includes("model-inferred") && !claim.origins.includes("scope-declared")),
    "the whole view judges nothing: no role, no role node, no chosen relation");
  need(/未反映: 2 \/ 8/u.test(whole.now.draftCount), `the whole view counts as one utterance (${whole.now.draftCount})`);
  // Undo would otherwise take back the new map itself.
  prerequisite(whole.now.state === "drafted", "whole");

  // Undo takes the whole utterance back - every Decision it added.
  let cameraControlBefore;
  let cameraControlRequests;
  if (FIXTURE) {
    await page.locator("#camera-part").selectOption(`arch-${APP}`);
    await settle();
    cameraControlBefore = await screen();
    cameraControlRequests = exchanges.length;
    assert.equal(cameraControlBefore.camera, `arch-${APP}`);
  }
  reached.push("whole-undo");
  await click("undo");
  await settle();
  const undone = await screen();
  last = undone;
  if (FIXTURE) {
    reached.push("camera-undo");
    assert.equal(undone.camera, "", "Undo reconciles the disappeared draft camera to overview");
    assert.equal(undone.draft.length, 1, "selected draft camera does not block Undo");
    assert.equal(exchanges.length, cameraControlRequests, "camera and Undo make no judgment requests");
    for (const key of ["stored", "root", "confirmedGraph"]) assert.deepEqual(undone[key], cameraControlBefore[key], key);
    report({ event: "camera-undo", requests: 0, dom: domOf(undone) });
  }
  report({ event: "turn", stage: "whole-undo", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(undone) });
  need(undone.draft.length === 1 && undone.claims.every(claim => !claim.record.startsWith("region arch-")),
    `Undo takes the whole view back (${undone.draft.length} steps left)`);
  prerequisite(undone.draft.length === 1, "whole-undo");
  if (FIXTURE) {
    // A separate crafted draft exercises failed rendering and Discard.
    // The natural/live scenario above and all its original utterances stay unchanged.
    reached.push("camera-discard-draft");
    const draft = await say("camera-discard-draft", UTTERANCES.whole, picksFor(contract.WHOLE));
    assert.equal(draft.now.state, "drafted");
    await page.locator("#camera-part").selectOption(`arch-${APP}`);
    await settle();
    const before = await screen();
    const requests = exchanges.length;
    await page.evaluate(() => {
      const mount = document.querySelector("#working-surface"), append = mount.append;
      mount.append = function (...nodes) { mount.append = append; throw new Error("controlled first-pane insertion failure"); };
    });
    reached.push("camera-undo-render-failure");
    await click("undo");
    await settle();
    const failed = await screen();
    last = failed;
    assert.equal(failed.state, "failed");
    for (const key of ["camera", "graph", "draft", "claims", "stored", "root", "confirmedGraph"]) assert.deepEqual(failed[key], before[key], key);
    assert.equal(exchanges.length, requests, "failed Undo makes no judgment requests");
    report({ event: "camera-undo-render-failure", requests: 0, dom: domOf(failed) });
    reached.push("camera-discard");
    await click("discard");
    await settle();
    const discarded = await screen();
    last = discarded;
    assert.equal(discarded.graph, null);
    assert.equal(discarded.camera, "", "Discard with no Accepted graph clears the disappeared camera");
    assert.equal(discarded.draft.length, 0);
    for (const key of ["stored", "root", "confirmedGraph"]) assert.deepEqual(discarded[key], before[key], key);
    report({ event: "camera-discard", requests: 0, dom: domOf(discarded) });
    reached.push("camera-discard-new");
    await page.locator("#text").fill("voice-ui の構成");
    await click("new");
    await settle();
    const renewed = await screen();
    last = renewed;
    assert.equal(renewed.state, "drafted", "New is not blocked by the discarded camera");
    assert.equal(renewed.camera, "");
    assert.equal(renewed.draft.length, 1);
    assert.equal(exchanges.length, requests, "Discard and New make no judgment requests");
    for (const key of ["stored", "root", "confirmedGraph"]) assert.deepEqual(renewed[key], before[key], key);
    report({ event: "camera-discard-new", requests: 0, dom: domOf(renewed) });
  }

  }
  // (2) The page's own code: its roles, its call to the Worker, its storage.
  reached.push("app");
  const app = await say("app", UTTERANCES.app, picksFor(APP));
  need(app.sent.at(-1)?.sent.kind === contract.ARCHITECTURE_JUDGE_KIND, "a focused utterance ends in a judge of its parts");
  need(located(app), "the natural fixture located the page's part");
  need(app.sent.every(entry => entry.status === 200), `every request was answered (${app.sent.map(entry => entry.status).join(", ")})`);
  need(app.sent.every(entry => !codeIn(entry.sent)), "the page sends no code in any request; the server adds it");
  for (const role of ["voice-input", "jev-boundary", "graph-mutation", "persistence"]) need(hasRole(app.now, APP, role), `the page's file is judged ${role}`);
  need(claimOf(app.now, `region arch-${APP}`)?.origins.join(" ") === "source-declared", "the file itself stays the source's");
  need(inferredAt(app.now, `arch-calls-${APP}-to-${ADAPTER}`), "the page invokes the judgment adapter, not a transitive direct Worker call");
  need(claimOf(app.now, "relation arch-import-functions-pages-worker-mjs-to-functions-api-judge-mjs")?.origins.includes("source-declared"),
    "the Worker imports the Function, as the source declares");
  need(inferredAt(app.now, `arch-stores-in-${APP}-to-ext-localstorage`), "the page stores in localStorage");
  // Every later stage stands on the structure this utterance drew.
  prerequisite(app.now.state === "drafted", "app");

  if (REVERSE) {
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });
    const firstReference = app.now.context.at(-1);
    need(app.sent[0]?.sent.state.utterance === UTTERANCES.app, "the first actual request carries the fixed source utterance");
    need(firstReference?.text === UTTERANCES.app && firstReference.source === "typed" && firstReference.outcome === "step"
      && firstReference.reference?.source.handle === MANIFEST.source.handle
      && firstReference.reference.source.commit === SERVED_COMMIT
      && JSON.stringify(firstReference.reference.focus) === JSON.stringify(app.sent.at(-1)?.sent.state.architecture.focus),
      "the first DOM reference matches its actual judged source and focus");
    const originalId = `arch-calls-${APP}-to-${ADAPTER}`;
    const original = app.now.graph?.records.find(record => record.type === "relation" && record.id === originalId);
    need(original?.kind === "calls", "the source evaluation draws the expected calls relation");
    need(app.now.graph?.records.filter(record => record.type === "relation" && record.from === original?.from
      && record.to === original?.to && record.kind === "calls").length === 1, "the calls target is unique, distinct from imports");
    need(!app.now.graph?.records.some(record => record.type === "relation" && record.from === original?.to
      && record.to === original?.from), "the reversed endpoint pair is absent");
    prerequisite(verdicts.length === 0, "app");
    reached.push("reverse");
    const reversed = await say("reverse", REVERSE_UTTERANCE, name => name === "action"
      ? contract.ACTION_REVERSE_EDGE : name === "edge" ? originalId : contract.NONE);
    const request = reversed.sent[0]?.sent.state;
    const prior = request?.context.recent.find(entry => entry.text === UTTERANCES.app);
    const reverseId = `voice-${original.to}-to-${original.from}`;
    const added = reversed.now.graph?.records.find(record => record.type === "relation" && record.id === reverseId);
    need(reversed.sent.length === 1 && reversed.sent[0].sent.kind === contract.ARCHITECTURE_INTENT_KIND,
      "the fresh reverse evaluation is exactly one intent, not another body judgment");
    need(reversed.sent[0]?.body?.answers?.action?.choice === contract.ACTION_REVERSE_EDGE
      && reversed.sent[0]?.body?.answers?.edge?.choice === originalId, "the fresh typed answer selects the calls edge");
    need(request?.utterance === REVERSE_UTTERANCE, "the second actual request carries the fixed hypothetical utterance");
    need(JSON.stringify(prior) === JSON.stringify(firstReference),
      "the actual follow-up carries exactly the first DOM conversation entry and source reference");
    need(request?.graph.edges.some(edge => edge.id === originalId && edge.from === original.from && edge.to === original.to),
      "the actual follow-up carries the selected Working relation");
    need(reversed.now.state === "drafted" && reversed.now.draft.length === app.now.draft.length + 1
      && reversed.now.graph?.head !== app.now.graph.head, "the typed reversal changes the actual projected Working graph");
    need(JSON.stringify(reversed.now.draft.slice(0, -1)) === JSON.stringify(app.now.draft)
      && reversed.now.draft.at(-1) === `-${original.from}->${original.to} +${original.to}->${original.from}`,
      "one appended draft exposes the remove/connect pair and preserves earlier drafts");
    need(!reversed.now.graph?.records.some(record => record.id === originalId)
      && added?.from === original.to && added?.to === original.from && added?.kind === original.kind
      && added?.label === original.label, "Remove+Connect replaces exactly the calls direction and retains kind/label");
    need(JSON.stringify(reversed.now.graph?.records.filter(record => record.id !== reverseId))
      === JSON.stringify(app.now.graph.records.filter(record => record.id !== originalId)), "all other projected records are unchanged");
    need(claimOf(reversed.now, `relation ${reverseId}`) === null
      && JSON.stringify(reversed.now.claims) === JSON.stringify(app.now.claims.filter(claim => claim.record !== `relation ${originalId}`)),
      "the hypothetical reverse has no false source/user claim; only the removed relation claim disappears");
    for (const key of ["stored", "root", "confirmedGraph"]) need(JSON.stringify(reversed.now[key]) === JSON.stringify(start[key]), `${key} stays unchanged`);
    prerequisite(verdicts.length === 0, "reverse");
    reached.push("reverse-undo");
    const beforeUndo = exchanges.length;
    await click("undo");
    await settle();
    const restored = await screen();
    last = restored;
    assert.equal(exchanges.length, beforeUndo, "Undo makes no judgment request");
    for (const key of ["claims", "draft", "stored", "root", "confirmedGraph"]) assert.deepEqual(restored[key], app.now[key], key);
    assert.deepEqual(restored.graph.records, app.now.graph.records);
    assert.equal(restored.graph.head, app.now.graph.head);
    contextEvidence = { source: SERVED_COMMIT, priorSequence: prior.seq, priorFocus: prior.reference.focus,
      workingEdge: originalId, reversedEdge: reverseId, graphBefore: app.now.graph.head,
      graphAfter: reversed.now.graph.head, undoRestored: true, noSave: true,
      viewport: page.viewportSize(), acceptedIntegration: "NOT_PROVEN" };
    report({ event: "context-evidence", ...contextEvidence, dom: domOf(restored) });
    return;
  }

  // (3) The credential: the Function authenticates with it and calls the provider.
  reached.push("credential");
  const auth = await say("credential", UTTERANCES.credential, picksFor("ext-jev-api-key"));
  need(located(auth), "the natural fixture located the credential");
  need(auth.sent.every(entry => entry.status === 200), `the credential focus was answered (${auth.sent.map(entry => entry.status).join(", ")})`);
  need(inferredAt(auth.now, `arch-authenticates-with-${WORKER}-to-ext-jev-api-key`), "the Worker holds and passes the credential");
  need(inferredAt(auth.now, `arch-calls-${WORKER}-to-ext-voice-ui-judge-provider`), "the Worker invokes the imported provider binding");
  need(claimOf(auth.now, "region arch-ext-voice-ui-judge-provider")?.origins.join(" ") === "unknown", "the non-admitted provider alias stays unknown");
  need(claimOf(auth.now, "region arch-ext-jev-api-key")?.origins.join(" ") === "unknown", "the credential itself stays unknown");
  need(hasRole(auth.now, WORKER, "auth"), "the Worker is judged as holding or passing a credential, not as implementing provider HTTP authorization");

  // (4) Storage: every admitted file that names it, whole.
  reached.push("storage");
  const stored = await say("storage", UTTERANCES.storage, picksFor("ext-localstorage"));
  need(located(stored), "the natural fixture located the storage");
  need(stored.sent.every(entry => entry.status === 200), `the storage focus was answered (${stored.sent.map(entry => entry.status).join(", ")})`);
  // The four files that name localStorage, from the served manifest: exactly
  // these for the named part; for a natural request all of them, any other
  // body only because the judged section - the server's own, for exactly the
  // located parts - opens it.
  const STORAGE_FILES = MANIFEST.candidates.filter(candidate => candidate.to === "ext-localstorage").map(candidate => candidate.from).sort();
  const storageBodies = [...(stored.sent.at(-1)?.sent.kind === contract.ARCHITECTURE_JUDGE_KIND ? stored.sent.at(-1).sent.state.architecture.bodies : [])].sort();
  need(JSON.stringify(STORAGE_FILES) === JSON.stringify(["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"]),
    `the snapshot's files that name localStorage are the original four (${STORAGE_FILES.join(", ")})`);
  need(scenario === "named"
    ? JSON.stringify(storageBodies) === JSON.stringify(STORAGE_FILES)
    : STORAGE_FILES.every(file => storageBodies.includes(file)),
  `the storage section opens ${scenario === "named" ? "exactly" : "all of"} the four files that name it (${storageBodies.join(", ")})`);
  need(hasRole(stored.now, "src-config-mjs", "config"), "the config module is judged config");

  // (5) A fresh source-bound judgment may add a missing role or acknowledge
  // an already present role. No-change alone is not success.
  reached.push("save");
  need(inferredAt(stored.now, `arch-calls-${APP}-to-${LOG}`), "the page -> decision log relation is already there");
  const beforeSave = await screen();
  const saveAgain = () => say("save", UTTERANCES.save, picksFor(LOG));
  const save = await saveAgain();
  const judgedPersistence = result => result.sent.some(entry => entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND
    && entry.sent.state.architecture.focus.includes(LOG)
    && entry.body?.answers?.[contract.roleSlot(LOG, "persistence")]?.choice === contract.YES
    && entry.body.answers[contract.roleSlot(LOG, "persistence")].confidence >= contract.MIN_CONFIDENCE);
  const acknowledged = (before, after) => {
    const last = after.context.at(-1);
    return last?.text === UTTERANCES.save && last.source === "typed" && last.outcome === "no-change"
      && last.seq > (before.context.at(-1)?.seq ?? 0)
      && JSON.stringify(after.context.slice(0, -1)) === JSON.stringify(before.context.slice(-(contract.CONTEXT_MAX - 1)));
  };
  const stable = (before, after) => JSON.stringify(after.claims) === JSON.stringify(before.claims)
    && JSON.stringify(after.draft) === JSON.stringify(before.draft)
    && before.graph !== null && JSON.stringify(after.graph) === JSON.stringify(before.graph);
  need(located(save), "the natural fixture located the decision log");
  need(save.sent.every(entry => entry.status === 200) && judgedPersistence(save), "fresh focused completed judgments affirm log persistence");
  const existing = hasRole(beforeSave, LOG, "persistence");
  need(existing
    ? save.now.state === "no-change" && stable(beforeSave, save.now) && acknowledged(beforeSave, save.now)
    : save.now.state === "drafted",
  `the log's role is ${existing ? "freshly acknowledged with stable graph/draft and appended conversation" : "newly drafted"} (state ${save.now.state})`);
  need(hasRole(save.now, LOG, "persistence"), "the decision log is judged persistence with its required provenance");
  need(claimOf(save.now, `relation arch-import-${APP}-to-${LOG}`)?.origins.includes("source-declared"), "the page imports the decision log");
  need(save.now.claims.every(claim => !(claim.record.startsWith("relation arch-import-") && claim.origins.includes("model-inferred"))),
    "an import edge is never model-inferred");
  if (FIXTURE) {
    prerequisite(existing ? save.now.state === "no-change" : save.now.state === "drafted", "save");
    reached.push("save-again");
    const repeat = await saveAgain();
    need(judgedPersistence(repeat) && repeat.now.state === "no-change" && stable(save.now, repeat.now)
      && acknowledged(save.now, repeat.now), "a repeated fresh affirmative role preserves graph/draft and appends its acknowledgement");
    if (!existing) {
      await click("undo");
      await settle();
      const back = await screen();
      need(!hasRole(back, LOG, "persistence") && claimOf(back, "region arch-role-persistence") !== null,
        "Undo removes the newly added log role and keeps the shared persistence node");
      need(hasRole((await saveAgain()).now, LOG, "persistence"), "a fresh judgment draws the missing role again");
    }
  }
  if (LOCATES) {
    // A failure part-way through an utterance leaves everything as it was: a
    // frame that fails, a frame answered 200 without its question, a locate or judge
    // with an unexpected envelope field, and - for storage, whose judge has
    // several frames - a judge's second frame answered 200 without its questions: after each, nothing is asked.
    const middle = 1 + Math.floor(ENTITY_IDS.length / 2);
    reached.push("failed-frame");
    await failing("failed-frame", middle, { status: 502, body: { error: contract.ERRORS.providerError } }, contract.ERRORS.providerError);
    reached.push("incomplete-frame");
    await failing("incomplete-frame", middle, { answers: {} }, "judge-contract");
    reached.push("frame-extra-envelope");
    await failing("frame-extra-envelope", middle, { extra: { model: "unexpected-provider-label" } }, "judge-contract");
    reached.push("judge-extra-envelope");
    await failing("judge-extra-envelope", 1 + ENTITY_IDS.length, { extra: { model: "unexpected-provider-label" } }, "judge-contract");
    reached.push("incomplete-judge-frame");
    await failing("incomplete-judge-frame", 1 + ENTITY_IDS.length + 1, { answers: {} }, "judge-contract",
      { utterance: UTTERANCES.storage, focus: "ext-localstorage" });
  }
  const judgedDraft = (await screen()).draft.length;

  // (6) A correction by the person: the judged storage relation is taken out -
  // one more utterance - and Undo takes it back.
  reached.push("correction");
  const storageEdge = `arch-stores-in-${APP}-to-ext-localstorage`;
  const corrected = await say("correction", UTTERANCES.correction, (name, sent) => {
    if (name === "action") return "remove-edge";
    if (name === "edge") return sent.state.graph.edges.find(edge => edge.id === storageEdge)?.id;
    return contract.NONE;
  });
  const removedOne = corrected.now.draft.length === judgedDraft + 1 && claimOf(corrected.now, `relation ${storageEdge}`) === null;
  need(removedOne, `the person's correction removes the judged relation as one more step (state ${corrected.now.state}: `
    + `${corrected.now.failure ?? corrected.now.status})`);
  if (removedOne) {
    let beforeUndo, requests;
    if (FIXTURE) {
      reached.push("camera-surviving-undo");
      await page.locator("#camera-part").selectOption(`arch-${APP}`);
      await settle();
      beforeUndo = await screen();
      requests = exchanges.length;
    }
    await click("undo");
    await settle();
    const back = await screen();
    last = back;
    need(claimOf(back, `relation ${storageEdge}`) !== null, "Undo brings the judged relation back");
    if (FIXTURE) {
      assert.equal(back.camera, `arch-${APP}`, "Undo preserves a camera whose region survives");
      assert.notEqual(back.state, "failed");
      assert.equal(back.draft.length, judgedDraft);
      for (const key of ["stored", "root", "confirmedGraph"]) assert.deepEqual(back[key], beforeUndo[key], key);
      assert.equal(exchanges.length, requests, "surviving-camera Undo makes no judgment requests");
      report({ event: "camera-surviving-undo", requests: 0, dom: domOf(back) });
      // Return this added fixture checkpoint to the original Apply/reload view.
      await page.locator("#camera-part").selectOption("");
      await settle();
    }
  }

  // Apply saves the new map and every view.
  reached.push("apply");
  await click("apply");
  await settle();
  applied = await screen();
  last = applied;
  report({ event: "turn", stage: "apply", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(applied) });
  need(applied.state === "applied", `Apply saved the document (state ${applied.state}: ${applied.failure ?? applied.status})`);
  need(applied.stored?.startsWith('{"schema":"voice-ui.architecture-document/1"'), "the architecture key holds the document");
  need(applied.root === rootBefore, "the plain page's stored value is untouched");
  need(applied.confirmedGraph !== null && JSON.stringify(applied.confirmedGraph.view) === JSON.stringify(applied.graph?.view), "Apply gives both panes the same settled view");
  need(applied.notice.includes("保存済み") && !applied.notice.includes("消えます"), "verified Apply has no unsaved warning");
  need(applied.stored !== null && !applied.stored.includes("export function") && !applied.stored.includes("confidence"),
    "no source text, raw answer or confidence is saved");

  // Reload restores the same graph with every claim and role, checked against the source.
  reached.push("reload");
  actions.reload++;
  await page.reload({ waitUntil: "commit" });
  await ready();
  reloaded = await screen();
  last = reloaded;
  report({ event: "turn", stage: "reload", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(reloaded) });
  need(reloaded.state === "restored", `reload restores the document (state ${reloaded.state}: ${reloaded.failure ?? reloaded.status})`);
  need(reloaded.stored === applied.stored, "reload does not rewrite the document");
  need(reloaded.confirmedGraph !== null && JSON.stringify(reloaded.confirmedGraph.view) === JSON.stringify(reloaded.graph?.view), "reload gives both panes the same settled view");
  need(reloaded.notice.includes("保存済み") && !reloaded.notice.includes("消えます"), "verified restore has no unsaved warning");
  need(JSON.stringify(reloaded.claims) === JSON.stringify(applied.claims), "the same records and origins come back");
  need(applied.graph !== null && reloaded.graph !== null
    && JSON.stringify(reloaded.graph.records) === JSON.stringify(applied.graph.records)
    && JSON.stringify(reloaded.graph.view) === JSON.stringify(applied.graph.view), "the complete rendered records and view come back");
  const originsAfter = [...new Set(reloaded.claims.flatMap(claim => claim.origins))].sort();
  need(JSON.stringify(originsAfter) === JSON.stringify(["model-inferred", "scope-declared", "source-declared", "unknown", "user-asserted"]),
    `all five origins come back (${originsAfter.join(", ")})`);
  need(hasRole(reloaded, LOG, "persistence") && hasRole(reloaded, APP, "persistence"), "the roles come back as drawn");
  need(/^出典: apps-voice-ui@/u.test(reloaded.sourceStatus), "the cited snapshot is still checkable");
  if (FIXTURE) {
    let beforeCamera = reloaded;
    const choices = await page.locator("#camera-part option").evaluateAll(options => options.filter(option => option.value).map(option => ({ id: option.value, label: option.textContent })));
    const file = choices.find(option => option.label === "web/app.mjs");
    assert.ok(file, "the actual source-file camera is offered");
    const long = choices.reduce((best, option) => option.label.length > best.label.length ? option : best, file);
    const heldPlacement = stage => say(stage, "fixture incomplete placement", name => ({
      action: contract.ACTION_PLACE_PART, move: file.id,
      anchor: { choice: choices.find(option => option.id !== file.id).id, confidence: 0.39 }, direction: "right",
    })[name] ?? contract.NONE);
    reached.push("camera-pending");
    const heldCamera = await heldPlacement("camera-pending");
    assert.equal(heldCamera.now.pending, "anchor", "the controlled placement really holds its missing anchor");
    await page.locator("#camera-part").selectOption(file.id);
    await settle();
    const clearedCamera = await screen();
    assert.equal(clearedCamera.pending, null, "camera deliberately clears the existing held placement");
    for (const key of ["draft", "claims", "context", "stored"]) assert.deepEqual(clearedCamera[key], heldCamera.now[key], key);
    assert.deepEqual(clearedCamera.graph.records, heldCamera.now.graph.records);
    assert.equal(clearedCamera.graph.head, heldCamera.now.graph.head);
    report({ event: "camera-clears-pending", dom: domOf(clearedCamera) });
    beforeCamera = clearedCamera;
    for (const chosen of [file, long]) {
      await page.locator("#camera-part").selectOption(chosen.id);
      await settle();
      const focused = await screen();
      assert.equal(focused.state, "camera", focused.status);
      assert.deepEqual(focused.graph.records, beforeCamera.graph.records);
      assert.deepEqual(focused.confirmedGraph.view, focused.graph.view);
      assert.deepEqual(focused.context, beforeCamera.context, "camera does not create conversational reference");
      assert.equal(focused.stored, beforeCamera.stored);
      const visible = await labelVisible(chosen.label);
      if (chosen === file) assert.equal(visible, true, "the actual source-file label is visible in the rendered graph");
      else if (!visible) assert.match(focused.status, /長いラベルは収まらない/u, "long-label limitation is explicit, not a math-only readability claim");
      report({ event: "camera", part: chosen.id, label: chosen.label, labelVisible: visible, dom: domOf(focused) });
    }
    await page.locator("#camera-part").selectOption("");
    await settle();
    const viewport = page.viewportSize();
    reached.push("resize-pending");
    const heldResize = await heldPlacement("resize-pending");
    assert.equal(heldResize.now.pending, "anchor");
    await page.setViewportSize({ ...viewport, height: viewport.height + 20 });
    await page.waitForFunction(() => document.body.dataset.state === "resized");
    const clearedResize = await screen();
    assert.equal(clearedResize.pending, null, "resize deliberately clears the existing held placement");
    for (const key of ["draft", "claims", "context", "stored"]) assert.deepEqual(clearedResize[key], heldResize.now[key], key);
    assert.deepEqual(clearedResize.graph.records, heldResize.now.graph.records);
    assert.equal(clearedResize.graph.head, heldResize.now.graph.head);
    report({ event: "resize-clears-pending", dom: domOf(clearedResize) });
    await Promise.all([
      page.locator("#camera-part").selectOption(file.id),
      page.setViewportSize({ ...viewport, height: viewport.height + 40 }),
    ]);
    await page.waitForFunction(() => {
      const mount = document.querySelector("#working-surface"), runtime = mount.querySelector("iframe")?.contentWindow?.semanticMapRuntime;
      return document.body.dataset.state !== "pending" && runtime?.view?.frame?.viewport?.[1] === mount.clientHeight;
    });
    const resized = await screen();
    assert.deepEqual(resized.confirmedGraph.view, resized.graph.view, "locked resize eventually synchronizes both panes");
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => document.body.dataset.state !== "pending");
    await page.locator("#camera-part").selectOption("");
    await settle();
    // Fail the second pane after the working pane adopted its new frame.
    // This changes neither the graph nor provider requests.
    await page.evaluate(() => {
      const mount = document.querySelector("#confirmed-surface");
      const append = mount.append;
      mount.append = function (...nodes) { mount.append = append; throw new Error("controlled second-pane insertion failure"); };
    });
    await page.locator("#camera-part").selectOption(file.id);
    await settle();
    const failedPair = await screen();
    assert.equal(failedPair.state, "view-unverified");
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#camera-part").isDisabled(), true);
    assert.equal(failedPair.stored, beforeCamera.stored);
    assert.deepEqual(failedPair.graph.records, beforeCamera.graph.records);
    assert.deepEqual(failedPair.draft, beforeCamera.draft);
    assert.match(failedPair.notice, /保存内容は確認済み.*表示を確認できません/u);
    report({ event: "camera-failure", dom: domOf(failedPair) });
    // Resize during the fixture recovery reload: queue until boot has a
    // session, rather than throwing or permanently dropping dimensions.
    await Promise.all([page.reload({ waitUntil: "commit" }), page.setViewportSize({ ...viewport, height: viewport.height + 24 })]);
    await ready();
    await page.waitForFunction(() => {
      const mount = document.querySelector("#working-surface"), runtime = mount.querySelector("iframe")?.contentWindow?.semanticMapRuntime;
      return runtime?.view?.frame?.viewport?.[1] === mount.clientHeight;
    });
    const recovered = await screen();
    assert.equal(recovered.camera, "", "camera is ephemeral, not restored from storage");
    assert.deepEqual(recovered.confirmedGraph.view, recovered.graph.view);
    assert.equal(recovered.stored, beforeCamera.stored);
    assert.deepEqual(recovered.graph.records, beforeCamera.graph.records);
    report({ event: "camera-recovered", dom: domOf(recovered) });
  }
};
try {
  await runScenario();
} catch (error) {
  thrown = error;
  if (stoppedAt === null) stoppedAt = reached.at(-1) ?? "open";
} finally {
  // Every body is read (no read rejects: each ends in its own record) and the
  // browser closed, however the run ended; a failure to close is kept.
  await drain();
  await browser.close().catch(error => {
    cleanup = String(error?.message ?? error).split("\n")[0];
  });
}
need(errors.length === 0, `no page error: ${errors.join(" | ")}`);

const answered = exchanges.filter(entry => entry.status === 200);
const providerIdentity = "UNKNOWN";
const failure = thrown === null || thrown === HALT || thrown === PROTOCOL_HALT ? null : String(thrown?.message ?? thrown).split("\n")[0];
report({
  event: "summary", mode, scenario, contextEvidence, ...(GOAL ? { goalEvidence } : {}), ...(SOURCE ? { sourceEvidence } : {}), source: SERVED_COMMIT, viewport: page.viewportSize(), reached,
  dom: GOAL || SOURCE || last === null ? null : domOf(last), stoppedAt, error: failure, cleanup, protocolFailure, actions, verdicts, notRun: STAGES.filter(stage => !reached.includes(stage)),
  requests: exchanges.length, answered: exchanges.filter(entry => entry.status !== null).length,
  failed: exchanges.filter(entry => entry.error !== null).length,
  non200: exchanges.filter(entry => entry.status !== null && entry.status !== 200).length, providerIdentity,
  // Whatever no turn reported - a turn that ended in an error - in full.
  unreported: exchanges.filter(entry => !entry.reported).map(sanitized),
});

const shown = last?.claims ?? [];
const summary = `${answered.length}/${exchanges.length} HTTP200 neutral judgment exchanges (provider identity UNKNOWN), `
  + `${shown.length} claimed records, ${shown.filter(claim => claim.origins.includes("model-inferred")).length} with model-inferred claims, `
  + `${shown.filter(claim => claim.record.startsWith("relation arch-has-role-")).length} has-role edges`
  + (stoppedAt === null ? "" : ` | stopped after ${stoppedAt}`);
if (failure !== null) {
  // An error of the run itself is never a verdict: it is reported and rethrown.
  process.stdout.write(`${LABEL}: ERROR | ${failure}${cleanup === null ? "" : ` | close failed: ${cleanup}`} | ${summary}\n`);
  throw thrown;
}
if (cleanup !== null) {
  // A browser that could not be closed makes the run an error, whatever it found.
  process.stdout.write(`${LABEL}: ERROR | close failed: ${cleanup} | ${summary}\n`);
  process.exitCode = 1;
} else if (GOAL || SOURCE) {
  assert.deepEqual(verdicts, [], "the Goal's bounded mechanics and independently sealed result");
  assert.equal(thrown, null);
  process.stdout.write(`${LABEL}: PASS ${FIXTURE ? "controlled Goal mechanics only" : "local source-dev Goal only"} | ${summary}\n`);
} else if (STOP_FIXTURE) {
  assert.equal(thrown, PROTOCOL_HALT);
  const stopStage = REVERSE ? "app" : "whole";
  assert.equal(stoppedAt, stopStage);
  assert.deepEqual(reached, ["open", stopStage]);
  assert.deepEqual(actions, { new: 1, send: 1, undo: 0, apply: 0, reload: 0, discard: 0 });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].status, 502);
  assert.equal(exchanges[0].body?.error, contract.ERRORS.providerError);
  assert.equal(sanitized(exchanges[0]).upstreamStatus, 401);
  for (const upstreamStatus of [300,599,undefined,null,"401",200,299,600,401.5,NaN,{}]) {
    const entry = { ...exchanges[0], body: { error: contract.ERRORS.providerError, upstreamStatus } };
    const allowed = Number.isInteger(upstreamStatus) && upstreamStatus >= 300 && upstreamStatus <= 599;
    assert.equal(sanitized(entry).upstreamStatus, allowed ? upstreamStatus : "UNKNOWN");
  }
  assert.equal(sanitized({ ...exchanges[0], status: 200 }).upstreamStatus, "UNKNOWN");
  assert.equal(sanitized({ ...exchanges[0], body: { error: contract.ERRORS.providerContract, upstreamStatus: 401 } }).upstreamStatus, "UNKNOWN");
  const observed = { ...exchanges[0], body: { error: contract.ERRORS.providerError, upstreamStatus: 400, diagnostic: "context-limit-vocabulary-observed" } };
  assert.equal(sanitized(observed).diagnostic, "context-limit-vocabulary-observed");
  for (const diagnostic of [undefined,null,"private-diagnostic-canary",{},["context-limit-vocabulary-observed"],400]) {
    const reported = sanitized({ ...observed, body: { ...observed.body, diagnostic } });
    assert.equal(reported.diagnostic, "UNKNOWN");assert.ok(!JSON.stringify(reported).includes("private-diagnostic-canary"));
  }
  assert.equal(sanitized({ ...observed, status: 200 }).diagnostic, "UNKNOWN");
  assert.equal(sanitized({ ...observed, body: { ...observed.body, upstreamStatus: 401 } }).diagnostic, "UNKNOWN");
  assert.equal(sanitized({ ...observed, body: { ...observed.body, error: contract.ERRORS.providerContract } }).diagnostic, "UNKNOWN");
  assert.equal(sanitized({ ...exchanges[0], body: { answers: null } }).answers, null);
  for (const error of ["private-canary", { detail: "private-canary" }, ["private-canary"], 401, true]) {
    const reported = sanitized({ ...exchanges[0], error: null, body: { error, upstreamStatus: 401 } });
    assert.equal(reported.error, "UNKNOWN");
    assert.equal(reported.upstreamStatus, "UNKNOWN");
    assert.ok(!JSON.stringify(reported).includes("private-canary"));
  }
  for (const error of Object.values(contract.ERRORS))
    assert.equal(sanitized({ ...exchanges[0], error: null, body: { error } }).error, error);
  for (const error of ["body-unreadable", "transport-failed"])
    assert.equal(sanitized({ ...exchanges[0], error }).error, error);
  assert.equal(sanitized({ ...exchanges[0], error: "private-canary" }).error, "UNKNOWN");
  assert.equal(last.state, "failed");
  assert.equal(protocolFailure?.stage, stopStage);
  assert.ok(protocolFailure.defects.includes(stopStage + ": every request answered 200 with a complete answer"));
  assert.equal(cleanup, null);
  if (REVERSE) assert.deepEqual(STAGES.filter(stage => !reached.includes(stage)), ["reverse", "reverse-undo"]);
  else {
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("apply"));
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("reload"));
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("camera-pending"));
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("resize-pending"));
  }
  assert.ok(exchanges.every(entry => entry.reported));
  assert.deepEqual(last.graph, stopBaseline.graph);
  assert.deepEqual(last.claims, stopBaseline.claims);
  assert.deepEqual(last.draft, stopBaseline.draft);
  assert.equal(last.stored, stopBaseline.stored);
  assert.equal(last.root, stopBaseline.root);
  assert.deepEqual(verdicts, []);
  process.stdout.write(`${LABEL}: PASS stop mechanics only (simulated protocol RED, no later actions) | ${summary}\n`);
} else if (SEMANTIC_STOP) {
  assert.equal(thrown, HALT);
  assert.equal(stoppedAt, "app");
  assert.equal(protocolFailure, null);
  assert.deepEqual(reached, ["open", "app"]);
  assert.deepEqual(STAGES.filter(stage => !reached.includes(stage)), ["reverse", "reverse-undo"]);
  assert.deepEqual(actions, { new: 1, send: 1, undo: 0, apply: 0, reload: 0, discard: 0 });
  assert.deepEqual(verdicts, ["the page's file is judged jev-boundary"]);
  assert.ok(exchanges.every(entry => entry.status === 200 && entry.reported));
  assert.equal(contextEvidence, null);
  process.stdout.write(`${LABEL}: PASS semantic STOP mechanics only (valid answers, missing required role) | ${summary}\n`);
} else if (protocolFailure !== null) {
  process.stdout.write(`${LABEL}: PROTOCOL_RED | ${protocolFailure.defects.join("; ")} | ${summary}\n`);
  process.exitCode = 1;
} else if (FIXTURE) {
  assert.deepEqual(STAGES.filter(stage => !reached.includes(stage)), [], "all controlled checkpoints must be reached");
  assert.deepEqual(verdicts, [], "the page's mechanics");
  assert.equal(stoppedAt, null, "every stage ran");
  assert.equal(providerIdentity, "UNKNOWN", "the neutral envelope never proves a provider identity");
  process.stdout.write(`${LABEL}: PASS mechanics only (crafted answers) | ${summary}\n`);
} else if (verdicts.length > 0 || stoppedAt !== null) {
  process.stdout.write(`${LABEL}: NOT_PASS | ${verdicts.join("; ")} | ${summary}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${LABEL}: PASS local source-dev only, typed input (not the microphone gate)`
    + `${scenario === "named" ? ", named targets only - never a PASS of the natural scenario" : ""} | ${summary}\n`);
}
