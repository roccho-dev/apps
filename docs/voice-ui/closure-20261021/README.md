# voice-ui 完成閉包の評価の器（R1）

合意：[apps#94 comment 6313847759](https://github.com/roccho-dev/apps/issues/94#issuecomment-6313847759)（W の CLAIM v2＋R の修正 5 点）。完成条件の正本は [#118 c6310563121](https://github.com/roccho-dev/apps/pull/118#issuecomment-6310563121) §7・§8・§9（提案、未採用）。R が書き、W は触らない。

> **この器の CI green が示すのは、器（記録の形と、記録が引く封印・receipt・台帳行との結び付き）の整合だけ。製品の判定の合格ではない（§8-12）。** 判定は R が `ledgers/judgments.jsonl` に記録した判定票だけ。

## 置き場

| path | 中身 | 今の状態 |
|---|---|---|
| `expectations/*.json` | 期待@e（Required・Forbidden・Allowed・UNKNOWN と原文） | 形（`expectation.template.json`）だけ |
| `gold/sets.json`・`gold/<set>/` | 独立 Gold：提示図 2 枚（`presented-1`・`presented-2`）と **Atlas 全体**（`atlas`） | 置き場だけ。中身・封印なし |
| `ledgers/cycles.jsonl` | 周回の開始・終端 | 空 |
| `ledgers/seals.jsonl`・`judgments.jsonl`・`costs.jsonl` | 封印・判定票・費用 | 空 |
| `receipts/github/<sha>.json` | GitHub の読み戻しの記録（`GET /repos/<repo>/commits/<sha>` の応答） | 無し |
| `receipts/ledger/*.jsonl` | 予算台帳の該当行の写し（bytes そのまま） | 無し |
| `fixtures/baseline/` | 試験用の完全な小さな器（中身は fixture で判定ではない。receipt は 2026-10-21 に実際に読み戻した 928bcc1・8890af76、台帳行は予算台帳の行 126 の写し） | 試験専用 |
| `verify.mjs` | 検査 script | — |

検査：`node docs/voice-ui/closure-20261021/verify.mjs [dir]`（Nix では `packages/voice-ui/tests/closure-20261021.test.mjs` が呼ぶ）。error はどれも規則の code で始まる。

## 封印

1. R が期待@e または Gold を置く。どの候補の出力も見る前に行う。
2. JSON は鍵を全階層で辞書順・空白なしにした UTF-8 の sha256（`canonical-json-sha256`）、それ以外は原 bytes の sha256（`raw-sha256`）。`bytes` は file の実の長さ。
3. `ledgers/seals.jsonl` に `target`（expectation・gold・holdout）、`set`、`path`、`digest`、`bytes`、`sha256`、`sealed_by: "R"`、`sealed_at`、`before_exposure: true` を足す。
4. verify は封印を **file の実 bytes から計算し直す**（`E_SEAL_MISSING`・`E_SEAL_BYTES`・`E_SEAL_DIGEST`）。封印した期待は有効な candidate で、判定に使う Gold の set を `gold_set` で 1 つ名指しする。判定票が引く Gold の封印はその set のものでなければならない（`E_GOLD_SET`）。
5. 判定票が引く封印は、target が合っていて（`E_GOLD_TARGET`・`E_EXPECTATION_TARGET`）、その判定の `at` より **前** に封印されていなければならない（`E_SEAL_LATE`）。`before_exposure` の自己申告だけでは足りない。

## 記録

- **周回** `voice-ui.closure.cycle/1`：`cycle-open {cycle, seq, previous, at}` と `cycle-end {cycle, end: END1|END2, at}`。seq は 1 から連番で、前の周回が終端してからでないと次を開けない（`E_CYCLE_SEQ`・`E_CYCLE_OPEN_BEFORE_END`）。判定票と費用は開いた周回の中でだけ記録できる（`E_CYCLE_UNOPENED`・`E_CYCLE_TIME`）。round は周回ごとに 1 から欠けなく数え、上限は 4（`E_ROUND_GAP`）。cycle の名前を変えても回数は数え直せない。
- **判定票** `voice-ui.closure.judgment/2`：`cycle`、`round`、`lane`（A・B・E2E・JUDGE。JUDGE は §9 の 4 項目め＝Jev 評価器の適格性を独立 Gold で測る別の分母）、`item`、`step`（§7、14 は 14a・14b）、`product {arm, apps, ui, receipts}`、`evaluator {arm, id, sha256}`、`expectation_sha256`、`gold_seal_sha256`、`verdict`、`judge: "R"`、`counts_toward_end1`、`source`、`at`。
  - `counts_toward_end1: true` は、`receipts` に apps（と ui があれば ui）の **その SHA の読み戻しの記録** があるときだけ（`E_END1_RECEIPT`）。記録が無ければ UNKNOWN で、参考にとどまる。
  - **R の義務（器では防げない）**：Nix の sandbox は GitHub に届かないので、verify は receipt の形と SHA の一致しか確かめられず、手で書いた偽の receipt を見抜けない。END1 に数える判定票を書くたびに、R がその場で `gh api repos/<repo>/commits/<sha>` を実行し、その応答から receipt を作る。他者が書いた receipt をそのまま使わない。
- **費用** `voice-ui.closure.cost/2`：`calls` が数（0 を含む）なら `ledger {file, line, line_sha256}` が器の中の実在の行を bytes どおり引き、jev・typellm はその行の `phase-reconcile` の `sent` と数が一致する（`E_COST_LEDGER`・`E_COST_MISMATCH`）。引けないものは `"UNKNOWN"` で、0 として扱わない（§8-13）。

## 同じ分母と 4 セル（組＝cycle・round・lane・封印した期待）

- 分母は封印した期待の Required と Forbidden の id。どのセルもそれをちょうど 1 回ずつ判定する。UNKNOWN も分母に残る（`E_DENOMINATOR`、§8-8）。
- product の old と new の両方を判定する（`E_SINGLE_CELL`）。各 arm は 1 つの SHA の組で、old と new は違う（`E_PRODUCT_ARM`）。
- 評価器は arm の名前ではなく `id`・`sha256` で見分ける。arm ごとに 1 つの評価器で、old と new は違う（`E_EVALUATOR_ARM`）。new の評価器があれば 4 セルがそろう（`E_FOUR_CELL`、§8-10）。
- k≤2（PR ごと、周回全体）は合意の規則で、この器は数えない。

## 試験の意味

`closure-20261021.test.mjs` は fixture の器が通ることと、W の相互確認で見つかったすり抜け 10 件それぞれを改変として与え、その規則の code で拒否されることを確かめる。規則を 1 つ外すと、その試験が落ちる。
