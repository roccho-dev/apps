import { ACTION_COMPOSE, DRAFT_MAX } from "./contract.mjs";
import { ACTION_NEW } from "./turn.mjs";

// Everything the page shows, derived from state it is handed. Nothing here
// decides, stores or listens: the graphs are drawn from logs, the lists from
// the session, and every sentence the person reads comes from a result's code.

const REASONS = Object.freeze({
  "none-requested": "no graph change was requested",
  "undo-by-button": "undo is not done by voice or text; use the 元に戻す button",
  "diagram-not-offered": "その種類の図はまだ用意していません。個別の変更は今まで通り指示できます",
  "diagram-restate": "どの図を作るのか聞き取れませんでした。作りたい図の目的をもう一度言ってください",
  "diagram-no-room": "図を置く場所にほかの部品があります。その部品を動かすか作業図を破棄してから、もう一度言ってください",
  "diagram-unplaceable": "the view cannot place that diagram",
  "placement-restate": "配置の指示を聞き取れませんでした。動かす部品・隣の部品・方向をそろえて、もう一度言ってください",
  "placement-missing-move": "動かす部品が聞き取れませんでした。どの部品を動かしますか。部品の名前だけでも、指示全体でも言ってください",
  "placement-missing-anchor": "隣に置く相手の部品が聞き取れませんでした。どの部品の隣ですか。部品の名前だけでも、指示全体でも言ってください",
  "placement-missing-direction": "置く方向が聞き取れませんでした。左・右・上・下のどれですか。方向だけでも、指示全体でも言ってください",
  "frame-unreadable": "いま表示中の図を読み取れないので、位置を確かめられません",
  "frame-behind": "表示中の図がまだ追いついていないので、位置を確かめられません",
  "spot-off-pane": "その場所は今の表示の外になります",
  "anchor-off-pane": "基準の部品が今の表示の外にあります",
  "mover-off-pane": "動かす部品が今の表示の外にあります",
  "spot-taken": "その場所には別の部品があります",
  "already-there": "その部品はすでにそこにあります",
  "no-part-named": "the request did not name a part to add",
  "not-confident": "not confident enough to propose a change",
  "no-room-for-part": "図に部品を置く場所がありません",
  "no-two-nodes": "the request did not name two existing nodes",
  "no-edge-named": "the request did not name an existing edge",
  "repair-failed": "足りなかった部分が聞き取れませんでした。指示全体をもう一度言ってください",
  "repair-context-changed": "図が変わったので補えませんでした。指示全体をもう一度言ってください",
  "repair-self": "同じ部品の隣には置けません。指示全体をもう一度言ってください",
  "draft-full": "作業図の未反映は上限です。確定図に反映・元に戻す・作業図を破棄のいずれかを選んでください",
  "nothing-said": "nothing was said or typed",
  "no-title": "新しい図の名前を入力してください",
  "title-too-long": "図の名前が長すぎます",
  "same-region": "source and target are the same region",
  "edge-exists": "relation already exists",
  "edge-gone": "the chosen edge no longer exists",
  "reversed-exists": "the reversed edge already exists",
  "beside-itself": "a part cannot be placed beside itself",
  stale: "the answer is stale: the working graph changed after the request was sent",
  "answer-invalid": "the answer is outside the offered criteria",
  "provider-rejected": "the provider rejected the change",
  "revert-moved": "a later change already moved this part; nothing was reverted",
  "revert-unsupported": "only an added part can be reverted",
  "revert-removed": "a later change already removed this part; nothing was reverted",
  "revert-holds-parts": "this part now holds other parts; nothing was reverted",
  "revert-has-edge": "this part now has an edge; nothing was reverted",
  "revert-nothing": "that entry changed no edge",
  "revert-altered": "a later change already altered this edge; nothing was reverted",
  "revert-reused": "a later change already reused this edge; nothing was reverted",
  conflict: "別のタブが先に確定図を変更しました。作業図はそのまま残しています",
  rejected: "decision log was rejected",
  "not-persisted": "decision log was not persisted",
  unverified: "the stored decision log could not be verified",
  "judge-failed": "the judgment binding request failed",
  "judge-timeout": "the judgment binding did not answer within",
  "judge-contract": "the judgment binding answered outside the contract",
  "voice-failed": "voice input failed",
  "display-failed": "the step could not be drawn",
  error: "unexpected error",
});

// The sentence for a result code, with what the provider or platform said
// after it when there is anything.
export const reasonText = (reason, detail = null) => {
  const words = REASONS[reason] ?? reason;
  return detail === null ? words : reason === "judge-timeout" ? `${words} ${detail}` : `${words}: ${detail}`;
};

// Where both panes point their cameras: the provider's own layout of the
// working graph, fitted to the pane's box. No frame when there is nothing to
// fit - no graph, a graph the view cannot lay out, or a pane with no box.
export function frameFor({ graph, width, height, protocol }) {
  if (graph === null || !(width > 0 && height > 0)) return null;
  try {
    const { rootBounds } = protocol.layoutBoundsFor(graph.records, { pattern: protocol.GRAPH_PATTERN });
    return { bbox: [...rootBounds], viewport: [width, height] };
  } catch {
    return null;
  }
}

// One pane: the log drawn by the pinned provider's embed, asked for the
// diagram alone (its chrome-free presentation), or nothing when there is no
// graph. The embed never edits its input; this app owns every control.
//
// The new drawing is made in a candidate that covers the whole pane, hidden,
// while the map already shown stays exactly as it is. Only once the embed is
// ready is the old map removed and the candidate shown where it was drawn:
// its iframe is never moved, which would reload it. A drawing that fails
// removes the candidate alone and rethrows, so the pane keeps the map it had.
export async function drawGraph({ graph, frame, mount, protocol, renderProjection, document }) {
  if (graph === null) {
    mount.replaceChildren();
    return;
  }
  const envelope = await protocol.createEnvelope(graph.log, null, {
    pattern: protocol.GRAPH_PATTERN,
    ...(frame === null ? {} : { frame }),
  });
  if (document.defaultView.getComputedStyle(mount).position === "static") mount.style.position = "relative";
  const candidate = document.createElement("div");
  candidate.style.cssText = "position:absolute;inset:0;visibility:hidden;pointer-events:none;";
  mount.append(candidate);
  try {
    await renderProjection({ document, input: { envelope }, surfaceMount: candidate, presentation: "chrome-free" });
  } catch (error) {
    candidate.remove();
    throw error;
  }
  for (const child of [...mount.children]) {
    if (child !== candidate) child.remove();
  }
  candidate.style.visibility = "";
  candidate.style.pointerEvents = "";
}

const line = (document, kind, value) => {
  const element = document.createElement("p");
  element.dataset.history = kind;
  element.textContent = value;
  return element;
};

// "+from->to" for an added edge, "-from->to" for a removed one,
// "+id「label」" for a part, "+id@x,y,w,h" for a pin.
const describe = fact => {
  const sign = fact.change === "added" ? "+" : fact.change === "removed" ? "-" : "~";
  if ((fact.kind ?? "relation") === "relation") return `${sign}${fact.from}->${fact.to}`;
  if (fact.kind === "region") return `${sign}${fact.id}${fact.label ? `「${fact.label}」` : ""}`;
  if (fact.kind === "layout") return `${sign}${fact.id}@${fact.bounds.join(",")}`;
  return `${sign}${fact.kind}${fact.id ? ` ${fact.id}` : ""}`;
};

// 確定図's history: where the saved graph started and every applied Decision,
// each with a button that adds its opposite to 作業図 when that is safe.
export function renderHistory(panel, { projection, revertable, failure = null }) {
  const document = panel.ownerDocument;
  panel.replaceChildren();
  if (projection !== null) {
    panel.append(line(document, "initial",
      `initial: ${projection.initial.regions.join(", ")} (${projection.initial.relations.length} edges)`));
    const applied = document.createElement("ol");
    applied.dataset.history = "confirmed";
    projection.entries.forEach((entry, index) => {
      const item = document.createElement("li");
      item.dataset.entry = entry.id;
      const facts = entry.facts.map(describe);
      item.dataset.facts = facts.join(" ");
      item.append(document.createTextNode(facts.join(", ")));
      const revert = document.createElement("button");
      revert.type = "button";
      revert.textContent = "取り消しを作業図に追加";
      revert.dataset.revert = String(index);
      revert.dataset.revertable = String(revertable[index]);
      item.append(" ", revert);
      applied.append(item);
    });
    panel.append(applied);
    panel.append(line(document, "count", `confirmed: ${applied.childElementCount}`));
  }
  if (failure !== null) panel.append(line(document, "failure", failure));
}

const DIRECTION_WORDS = Object.freeze({ left: "左", right: "右", above: "上", below: "下" });

// What a step does, in words, read off its verified changes. A composed
// diagram names the bundle diagram its step says it came from.
const effectOf = (changes, { action = null, template = null, bundle = null } = {}) => {
  const [first, second] = changes;
  if (action === ACTION_NEW) return `新しい図「${first.label}」`;
  if (action === ACTION_COMPOSE) {
    const diagram = bundle?.diagrams?.find(entry => entry.key === template);
    const regions = changes.filter(change => change.kind === "region");
    const links = changes.filter(change => change.kind !== "region");
    return `図の提案${diagram ? `「${diagram.label}」` : ""}: `
      + regions.map(change => `${change.id}「${change.label}」`).join(" ")
      + (links.length > 0 ? ` / ${links.map(change => `${change.from}->${change.to}`).join(" ")}` : "");
  }
  if (changes.length === 1 && first.kind === "region" && first.change === "placed") {
    return first.anchor === "none"
      ? `配置を戻す ${first.id}`
      : `配置 ${first.id} を ${first.anchor} の${DIRECTION_WORDS[first.direction]}へ`;
  }
  if (changes.length === 1 && first.kind === "region") {
    return `${first.change === "added" ? "部品追加" : "部品削除"} ${first.id}「${first.label}」`;
  }
  if (changes.length === 1 && first.change === "added") return `追加 ${first.from}->${first.to}`;
  if (changes.length === 1 && first.change === "removed") return `削除 ${first.from}->${first.to}`;
  if (changes.length === 2 && first.change === "removed" && second.change === "added"
    && second.from === first.to && second.to === first.from) {
    return `反転 ${first.from}->${first.to} ⇒ ${second.from}->${second.to}`;
  }
  return changes.map(describe).join(" ");
};

const saidBy = source => (source === "voice" ? "認識文: " : "入力文: ");

// 作業図's unapplied steps in order, each with the text it was judged from and
// what it does, and the cap stated. Text is set as text only.
export function renderDraft(list, count, { draft, bundle }) {
  const document = list.ownerDocument;
  list.replaceChildren();
  for (const { step, input } of draft) {
    const item = document.createElement("li");
    item.dataset.step = step.action;
    item.dataset.changes = step.changes.map(describe).join(" ");
    item.dataset.source = input?.source ?? "revert";
    // A step completed by a second utterance shows the first one too.
    if (input?.origin !== undefined) {
      item.dataset.originSource = input.origin.source;
      const originLabel = document.createElement("span");
      originLabel.textContent = saidBy(input.origin.source);
      const originSaid = document.createElement("q");
      originSaid.dataset.origin = "";
      originSaid.textContent = input.origin.text;
      const joined = document.createElement("span");
      joined.textContent = " + 補足 ";
      item.append(originLabel, originSaid, joined);
    }
    const label = document.createElement("span");
    label.textContent = input === null ? "取り消し" : saidBy(input.source);
    item.append(label);
    if (input !== null) {
      const said = document.createElement("q");
      said.dataset.input = "";
      said.textContent = input.text;
      item.append(said);
    }
    const effect = document.createElement("span");
    effect.dataset.effect = "";
    effect.textContent = effectOf(step.changes, { action: step.action, template: step.template ?? null, bundle });
    item.append(" → ", effect);
    list.append(item);
  }
  const full = draft.length >= DRAFT_MAX;
  count.textContent = `未反映: ${draft.length} / ${DRAFT_MAX}`
    + (full ? " - 上限です。確定図に反映・元に戻す・作業図を破棄のいずれかを選んでください。" : "");
}

const OUTCOME_LABELS = Object.freeze({
  "no-change": "変更なし",
  "undo-request": "元に戻す依頼（ボタンで行います）",
  refused: "受け付けませんでした",
  undone: "取り消し済み",
});

// The recent conversation exactly as the next request will send it. Each item
// carries the entry itself for checking; its text is set as text.
export function renderContext(list, skippedLine, { recent, skipped }) {
  const document = list.ownerDocument;
  list.replaceChildren();
  for (const entry of recent) {
    const item = document.createElement("li");
    item.dataset.entry = JSON.stringify(entry);
    const label = document.createElement("span");
    label.textContent = saidBy(entry.source);
    const said = document.createElement("q");
    said.textContent = entry.text;
    const outcome = document.createElement("span");
    outcome.textContent = entry.outcome === "step" ? `${effectOf(entry.effect.changes)}（当時）` : OUTCOME_LABELS[entry.outcome];
    item.append(label, said, " → ", outcome);
    list.append(item);
  }
  skippedLine.textContent = skipped > 0 ? `長すぎるため参照しない発話 ${skipped}件` : "";
}

// Parts still in 作業図 that the pane does not show whole - or, when the frame
// cannot be read, that this cannot be checked. Never "all visible" by default.
export function renderOutOfView(notice, { outside }) {
  if (outside === null) {
    notice.dataset.parts = "";
    notice.textContent = "表示範囲を読み取れないため、表示に収まっていない部品があるか確かめられません";
    return;
  }
  notice.dataset.parts = outside.join(" ");
  notice.textContent = outside.length > 0
    ? `表示に収まっていない部品: ${outside.join(", ")}（作業図には残っています。表示の外か、一部しか見えていません）`
    : "";
}

// The capabilities the data bundle could not provide and why, or nothing when
// it provided every one. Set once when the page loads; the rest of the page
// works without them.
export function renderBundleNotice(notice, { affected, reason }) {
  notice.dataset.affected = affected.join(" ");
  notice.textContent = affected.length > 0
    ? `部品と図のひな形を読み込めなかったため使えません: ${affected.join(", ")} (${reason})。保存済みの図の表示と確定図への反映はできます`
    : "";
}

const DIAGNOSTIC_KEYS = Object.freeze([
  "diag", "diagOutcome", "diagPlaceable", "diagPlaceOffered",
  "diagAction", "diagMove", "diagAnchor", "diagDirection", "diagFrame",
]);
const slotDiagnostic = slot => (slot === undefined ? null : `${slot.choice}:${slot.confidence.toFixed(2)}`);

// Why a turn the judgment binding judged came to nothing, for whoever is looking at this screen
// during a test: a fixed set of short values on the status line, replaced on
// every turn and cleared by any control, never stored or sent. No utterance,
// no provider prompt, no probability distribution.
export function renderDiagnostic(status, diagnostic) {
  for (const key of DIAGNOSTIC_KEYS) delete status.dataset[key];
  if (diagnostic === null) return;
  const { answers, placeable, undoRequest, frame, revision } = diagnostic;
  status.dataset.diag = "judge-no-change";
  status.dataset.diagOutcome = undoRequest ? "undo-request" : "no-change";
  status.dataset.diagPlaceable = String(placeable.length);
  status.dataset.diagPlaceOffered = placeable.length >= 2 ? "yes" : "no";
  for (const [key, name] of [["diagAction", "action"], ["diagMove", "move"], ["diagAnchor", "anchor"], ["diagDirection", "direction"]]) {
    const value = slotDiagnostic(answers[name]);
    if (value !== null) status.dataset[key] = value;
  }
  // Only meaningful once placement was on the table at all.
  if (placeable.length >= 2) {
    status.dataset.diagFrame = frame === null ? "null" : frame.head === revision ? "ok" : "head-mismatch";
  }
}

// Which controls can act now. Nothing works while the surface is busy or the
// screen cannot speak for storage; inputs need a working graph; New exists
// only where there is no log; the working controls need an unapplied step.
export function renderControls(controls, { idle, capturing, noLog, working, draftLength, conversationLength }) {
  const full = draftLength >= DRAFT_MAX;
  controls.send.disabled = !idle || !working;
  controls.mic.disabled = capturing || !idle || !working;
  controls.newMap.hidden = !noLog;
  controls.newMap.disabled = !idle || !noLog || working;
  controls.undo.disabled = !idle || draftLength === 0;
  controls.discard.disabled = !idle || draftLength === 0;
  controls.apply.disabled = !idle || draftLength === 0;
  for (const button of controls.history.querySelectorAll("button[data-revert]")) {
    button.disabled = !idle || full || button.dataset.revertable !== "true";
  }
  controls.contextClear.disabled = !idle || conversationLength === 0;
}
