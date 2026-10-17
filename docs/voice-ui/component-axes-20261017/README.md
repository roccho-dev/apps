# 部品がそろう場合の表現と、不足をそろえる性能

apps#94の次cycle。前cycleの原記録・二修正・一回の未見評価は閉じたまま保つ。Userが「揃っているなら描写できるか」「揃っていなければ揃えられるか」を明確に分けて反復することを承認した。rootが唯一の実装・provider呼出し担当、継続subagent一名が独立評価を担当する。規約はadrs a6284e58ed99243447e135828d983fc07d2d363e、既存Apps#103/UI#362系列で進める。

## 分ける軸

| 軸 | 入力と実経路 | 成功条件 |
| --- | --- | --- |
| G 意味確定・充足判定 | stock在庫＋原文、通常API | intent10/10、明確な8件のavailability8/8、正規化gate10/10。controlのavailabilityはN/A |
| R 表現 | 独立harnessへ必要部品を全供給し、gate/補完を通さず実runGoal/legal/proofで実行 | 図8/8完全一致かつ実描画8/8 |
| F 補完 | stock在庫＋原文だけをB/Cへ直接渡す | 不足8件のlabel/kind/countがexactかつminimal各8/8。最低2件は別の自然な言い方 |
| E 製品総合 | 既定Bを接続した通常UIと完成Worker | gate10/10、十分4/4、不足4/4、control2/2、不要生成0、実描画・Goal一回のApply/reload。Undoは別keyless試験 |

Rへ供給する正解部品をG/F/Eへ渡さない。各軸は別入力で、採点oracleはそのphaseの停止・独立精算後に解放する。低確信・候補ゼロ・grammar不認識を分母から落とさない。意味上明確で小PoCの範囲にある要求は、未対応構文でも不成功として残す。条件付き成績は補足にとどめる。

Bは名前・種類・個数の有限転記のみ。recognizedとcompleteを分け、全文を消費できない追加・接続要求を「部品は十分」にしない。既存graphのnodeを追加用の在庫に数えず、一回使える部品容量との多重集合差分を取る。親子・辺・operator・IDの生成権限を増やさない。通常UIはB既定、TypeLLMはFの直接比較だけで、その成績を製品Bの成績へ代入しない。

recognized/required/spansは決定的な転記記録。complete/incompleteは、同じ一回のJev POST内で原文全体とその転記を照合する独立のモデル判断とする。構文的完全性の証明とは呼ばない。intentとcompletenessの双方が閾値以上の時だけ有限在庫差分を使い、最終confidenceは両者の最小値とする。不明はnullで実行を止め、確率1を捏造しない。F単体ではJev completenessを呼ばず、抽出の取りこぼしをそのまま採点する。

Eの通常UIはRedoを持たず、同じGoalの全decisionは一つのUndo単位である。EはGoalを一回だけ実行して全targetを採点・描画観測し、通常Apply/reloadで全targetのraw一致を検査する。Undoは同一完成物・同一UI/session sourceを使う別のkeyless機構試験三fixtureで検証する。追加のGoal再送や非公開state注入は行わない。

## 予算と工程

既計上564 Jev／29 TypeLLM、各累計1,000上限。新cycleは公開56 Jev、原因修正最大二回各27、最終164、setup16で合計290 Jevまで（累計最大854）。TypeはF直接比較の公開3＋未見8の11まで（累計最大40）。残り146 Jevはこの計画の自動追加枠ではない。失敗・不明・timeoutも一つの既存journalへ計上し、自動retryしない。

```mermaid
flowchart TD
  P[4軸・予算・封印poolを固定] --> I[Bを通常UIへ接続する最小候補]
  I --> C[契約・完成物browser・exact CI・独立R]
  C --> D[公開4軸で原因を測る]
  D --> X{根拠ある修正・最大二回}
  X -->|残枠あり| I
  X -->|候補固定| F[一つのsourceを固定し各未見poolを一度実行]
  F --> S[各phase停止・精算後に独立採点]
  S --> V[CIで全原記録と完成物を検算]
  V --> O[各軸の効果・未達・未証明を別記]
  P --> A[既存正規routeでCI起点liveを並行調査]
  A --> O
```

未消費の旧reserve10は原入力・原oracleのままEだけに一度使う。G10/R8/F8はRが新しく別々に封印する。公開済みN/Hを未見として再利用しない。CI-liveは起動設定・own実行・証拠検算から推定せず、正規認証・送信・精算の実証までUNPROVENとする。UI#362の人手merge承認も未取得であり、候補pinの測定と正式採用を分ける。
