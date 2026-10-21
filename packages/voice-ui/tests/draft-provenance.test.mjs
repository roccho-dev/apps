import assert from "node:assert/strict";
import test from "node:test";
import { renderDraft } from "../src/render.mjs";

// Text-only DOM port: validates source association and literal text, not paint.
const document = {};
document.createElement = tagName => {
  const element = { tagName, dataset: {}, ownerDocument: document, children: [], ownText: "" };
  Object.defineProperty(element, "textContent", {
    get: () => element.ownText + element.children.map(child => typeof child === "string" ? child : child.textContent).join(""),
    set: value => { element.ownText = String(value); element.children = []; },
  });
  element.append = (...children) => element.children.push(...children);
  element.replaceChildren = (...children) => { element.children = children; element.ownText = ""; };
  return element;
};
const add = (id, input, group) => ({
  step: { action: "add-part", changes: [{ kind: "region", change: "added", id, label: "DB" }] },
  input, ...(group === undefined ? {} : { group }),
});
const render = draft => {
  const before = JSON.stringify(draft), list = document.createElement("ul"), count = document.createElement("span");
  renderDraft(list, count, { draft, used: 1, bundle: { parts: [], diagrams: [] } });
  assert.equal(JSON.stringify(draft), before, "rendering cannot invent or mutate input, Decisions or groups");
  return list.children;
};
const quotes = row => row.children.filter(child => child.tagName === "q");

for (const source of ["typed", "voice"]) test(`grouped ${source} additions reference their single real input, including group zero`, () => {
  const input = { source, text: 'OCIにDBを3個追加 <b>そのまま</b>', seq: 0 };
  const rows = render([add("part-1", input, 0), add("part-2", null, 0), add("part-3", null, 0)]);
  assert.deepEqual(rows.map(row => row.dataset.source), [source, source, source]);
  assert.deepEqual(rows.map(row => row.dataset.group), ["0", "0", "0"]);
  assert.deepEqual(rows.map(row => row.dataset.continuation), [undefined, "true", "true"]);
  assert.equal(quotes(rows[0])[0].dataset.input, "");
  for (const row of rows.slice(1)) {
    assert.ok(row.textContent.startsWith("同じ入力の続き: " + input.text));
    assert.equal(row.textContent.includes("取り消し"), false);
    assert.deepEqual(quotes(row).map(q => q.dataset), [{ inputRef: "0" }]);
    assert.equal(quotes(row)[0].textContent, input.text);
    assert.equal(quotes(row)[0].children.length, 0, "input remains literal text");
  }
  assert.equal(rows.flatMap(quotes).filter(q => Object.hasOwn(q.dataset, "input")).length, 1);
});

test("continuations retain their own group's input, never another group or a prior render", () => {
  const rows = render([
    add("a", { source: "typed", text: "first", seq: 1 }, 1),
    add("b", { source: "voice", text: "second", seq: 2 }, 2),
    add("c", null, 1), add("d", null, 2), add("e", null, 3), add("f", null),
  ]);
  assert.deepEqual(quotes(rows[2]).map(q => q.textContent), ["first"]);
  assert.deepEqual(quotes(rows[3]).map(q => q.textContent), ["second"]);
  for (const row of [...rows.slice(4), ...render([add("g", null, 1)])]) {
    assert.equal(row.dataset.source, "unattributed");
    assert.ok(row.textContent.startsWith("入力情報なし"));
    assert.equal(quotes(row).length, 0);
  }
});

test("a real saved-history inverse and a new map have distinct action provenance", () => {
  const rows = render([
    { step: { action: "revert", changes: [{ kind: "region", change: "removed", id: "part-1", label: "DB" }] }, input: null },
    { step: { action: "new-map", changes: [{ kind: "region", change: "added", id: "root", label: "新しい図" }] }, input: null },
  ]);
  assert.deepEqual(rows.map(row => row.dataset.source), ["revert", "new-map"]);
  assert.ok(rows[0].textContent.startsWith("取り消し → "));
  assert.equal(rows[1].textContent, "新規作成 → 新しい図「新しい図」");
  assert.equal(rows.flatMap(quotes).length, 0, "system actions cannot invent utterances");
});

test("a repaired real input keeps both original source and supplement", () => {
  const input = { source: "typed", text: "DB", origin: { source: "voice", text: "OCIに追加" } };
  const [row, continuation] = render([add("a", input, 4), add("b", null, 4)]);
  assert.equal(row.dataset.originSource, "voice");
  assert.ok(row.textContent.startsWith("認識文: OCIに追加 + 補足 入力文: DB"));
  assert.deepEqual(quotes(row).map(q => q.dataset), [{ origin: "" }, { input: "" }]);
  assert.deepEqual(quotes(continuation).map(q => q.dataset), [{ inputRef: "4" }]);
});
