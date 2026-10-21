# voice-ui 完成閉包の評価の器（R1）

合意：[apps#94 comment 6313847759](https://github.com/roccho-dev/apps/issues/94#issuecomment-6313847759)（W の CLAIM v2＋R の修正 5 点）。完成条件の正本は [#118 c6310563121](https://github.com/roccho-dev/apps/pull/118#issuecomment-6310563121) §7・§8・§9（提案、未採用）。R が書き、W は触らない。

> **この器の CI green が示すのは、器（schema・記録の形・同じ分母の検査）の整合だけ。製品の判定の合格ではない（§8-12）。** 判定は R が `ledgers/` に記録した判定票だけで、その版が GitHub 上で読み戻せる SHA のときだけ END1 に数える。

## 置き場

| path | 中身 | 今の状態 |
|---|---|---|
| `expectations/*.json` | 期待@e（Required・Forbidden・Allowed・UNKNOWN と原文） | 形（`expectation.template.json`）だけ |
| `gold/sets.json` | 独立 Gold の置き場：提示図 2 枚（`presented-1`・`presented-2`）と **Atlas 全体**（`atlas`） | 置き場だけ。中身・封印なし |
| `gold/<set>/` | Gold の中身 | 未作成 |
| `ledgers/seals.jsonl` | 封印 | 空 |
| `ledgers/judgments.jsonl` | 判定票 | 空 |
| `ledgers/costs.jsonl` | 費用 | 空 |
| `examples/records.jsonl` | 形の例（SHA は仮の値。判定ではない） | 検査の対象外 |
| `verify.mjs` | 検査 script | — |

検査：`node docs/voice-ui/closure-20261021/verify.mjs`（Nix では `packages/voice-ui/tests/closure-20261021.test.mjs` が呼ぶ）。

## 封印の手順（中身はまだ入れない）

1. R が期待@e または Gold を `expectations/` か `gold/<set>/` に置く。どの候補の出力も見る前に行う。
2. JSON は鍵を全階層で辞書順にし、空白なしで直列化した UTF-8 bytes の sha256（`canonical-json-sha256`）。画像などは原 bytes の sha256（`raw-sha256`）。
3. `ledgers/seals.jsonl` に 1 行足す：`target`（expectation・gold・holdout）、`set`、`path`、`digest`、`bytes`、`sha256`、`sealed_by: "R"`、`sealed_at`、`before_exposure: true`。
4. 封印した後に中身を変えるなら、新しい版の封印を足す。古い行は消さない。出力を見た後の封印は封印として認めない。

## 記録の schema（JSONL、1 行 1 記録、余分な鍵は拒否）

- **判定票** `voice-ui.closure.judgment/1`：`cycle`（周回）、`round`（EV の回 n、1〜4）、`lane`（A・B・E2E）、`item`、`step`（§7 の 1〜15、14 は 14a・14b）、`product {arm old|new, apps 40 桁, ui 40 桁|null, github_readable}`、`evaluator {arm old|new, id, sha256}`、`expectation_sha256`、`gold_seal_sha256`、`verdict`（PASS・FAIL・UNKNOWN）、`judge: "R"`、`counts_toward_end1`、`source`、`at`。
  - PASS は封印した Gold を引く。`counts_toward_end1: true` は `github_readable: true` のときだけ（C のローカルの写しの判定は参考）。
- **封印** `voice-ui.closure.seal/1`：上の手順 3。
- **費用** `voice-ui.closure.cost/1`：`cycle`、`round`、`provider`（jev・typellm・ci・browser）、`calls`（数、または `"UNKNOWN"`）、`ledger {file, line}`、`phase_id`、`at`。
  - 数（0 を含む）は台帳の行を引く。引けないものは UNKNOWN で、0 として扱わない（§8-13）。

## 同じ分母と 4 セル

- 同じ `cycle`・`round`・`lane` の中では、どの組（product の old/new × evaluator の old/new）も同じ item の集合を 1 回ずつ判定する。UNKNOWN も分母に残す（§8-8）。
- A だけ・B だけ・E2E は lane で分け、別の分母として並べる（§5、§9 の 2 項目め）。
- evaluator の new を含む組があれば、old/old・old/new・new/old・new/new の 4 セルが全部そろわないと拒否する（評価器の変更による点数の上昇を製品の改善とみなさない、§8-10）。
- k≤2（PR ごと、周回全体）と n≤4（1 周回の EV の回）は、合意 6313847759 の閉包の規則による。この器が機械で確かめるのは n だけ。
