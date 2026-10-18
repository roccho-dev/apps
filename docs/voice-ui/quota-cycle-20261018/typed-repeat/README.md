# 通常画面の不足補完を一度の固定比較で問う

**有限転記Bと比べ、Type経路Cは不足部品を揃えて期待図を完成できるか。**

Bは既存のliteral-v2、Cはadaptive-v3の通常画面経路で、適格な場合のFだけを既存の9scalar＋表示名3項目thinking512へ接続する。両方とも同じquotaでGoalを動かす。B対新Cの経路全体を測定し、thinking単独や旧C対新Cの因果効果とは主張しない。

| 層 | 品質として問うこと | 改善差の扱い |
| --- | --- | --- |
| 部品が揃っている2例 | 正しい充足判定、Type送信0、期待図の実描画・Apply・保存復元 | 不足補完gainに数えない |
| 部品が不足している2例 | 完全NEWの名称・種類・個数、在庫差分、受理された候補、期待図の完成 | 両armが実適格で初期literalも同じ場合だけ、B未完成→C完成をgainとする |
| 変更しない対照2例 | 誤追加0、元図不変、既存の停止・guard条件を保持 | 品質分母から外さない |

一つの公開既知回帰例でgateを確認してから、独立担当が新しく封印した6例を一度だけ測定する。Dの8例と古い未使用封印は再利用しない。全6例を品質分母に残し、INVALIDや不適格をNO_EFFECTへ変えない。候補品質6/6と不足gain2・回帰0・誤採用0をともに満たして、登録した有限範囲の完成とする。

## 小さい機構と工程

部品の充足は受理された完全NEWと候補在庫の差分で決まり、Workingの既存ノードを追加用在庫へ数えない。有限転記の未認識は「不足確定」と同一視せず、既存G0の意図・完全性・confidenceと区別する。

通常stageのgeneration=dependentはDAG方針である。実際のFはthinking-labelsとして別に固定し、完成Workerの通常C Type bodyと直接Dのbodyの一致を鍵なしで検証する。G0/V/Bのwire、Goal/core、renderer、quotaと採点は保持する。通常stageへF専用のscalar_answersやusageを加えない。

~~~mermaid
flowchart LR
  A[問い・入力の封印・基準・予算] --> B[小さい実装とPR]
  B --> C[独立review・完成物CI・送信内容]
  C --> D[双方が同PIDで送信0確認]
  D --> E[公開1対を一度測定・物理停止・採点]
  E -->|gate通過| F[入力だけ解放して未見6対]
  F --> G[物理停止精算後にoracle解放]
  G --> H[既存CIで描画再検算・独立判定]
  E -->|未達| H
~~~

既存quotaのeval/score/audit/verifyを、閉じたprofile typed-ordinary-E-20261018で延長する。旧登録・旧raw・失敗・旧7閉包を保持し、第8の評価基盤は追加しない。新しい結果は第7のquota artifact内typed-repeatへ格納する。

Jevは正式c7ed、TypeLLMは正式a724の別々のlocator・ZIP・manifest・provenance・proof・実entryで束縛する。認証は既存envs/FD3・FD4/公式launcherを使う。[ローカル実行とsecret authoring](../../typellm-poc-20261017/README.md#ローカル実行と-envs)を参照する。

## 予算と現在地

| 工程 | 最大Jev | 最大TypeLLM |
| --- | ---: | ---: |
| 公開1対 | 19 | 1 |
| 未見6対 | 114 | 6 |
| 合計 | 133 | 7 |
| 現累計847/136からの最悪累計 | 980 | 143 |

各1000以内。追加疎通・retry・correction0。20Jevは未配賦で、未使用phase枠も自動転用しない。予約と実送は、完成物・基準・入力hash・callerと独立事前確認を固定した後だけ行う。

現在NOT_MEASURED。候補と[公開登録](../preregistered/quota-cycle-typed-commitment.json)・[工程](../preregistered/quota-cycle-typed-protocol.md)を固定し、API予約・送信0のまま完成物CIと独立入場確認へ進む。未見本文・oracleは未解放。前回Dは[exact-6f08のR24](https://github.com/roccho-dev/apps/pull/103#pullrequestreview-5561339329)まで閉包し、公開gain1・未見gain0、未見品質PASS/改善gate UNMETを保持する。

通常UIの有限品質/補完効果、CI起点の実API実行、4方式比較完了、通貨費用、任意文一般化、TypeLLM一般の有効/無効、sys2相当性と正式採用は別々に扱う。Appsはdraft/open/unmerged、UI#362の明示的人間merge条件を保持する。
