# 必要部品の判定・補完と描画を分ける反復

状態: 初回F6と修正1のF6/V6は未達。最後の修正2を独立確認中で、Eと未見例は未消費。前回の実測結果は [component axes](../component-axes-20261017/README.md) に固定している。

実API実行前の独立テストで公開E2の期待追加図の記載漏れを検出し、[訂正addendum](preregistered/requirements-cycle-public-E2-correction.json)で訂正した。原commitmentと原E2の2ファイルを残し、測定は明示的にE2.v2を使う。未見6ファイルのhashと意味・在庫差分・参照の[独立再確認](preregistered/requirements-cycle-meaning-validation.json)は不変PASS。

| 評価 | 与えるもの | 測るもの |
| --- | --- | --- |
| 表現 R | 正しい部品在庫と元の説明 | Goalが親子・接続を選び、実画面へ描き保存できるか |
| 検証 V | 元の説明と構造上合法な必要部品案 | 正しい案を受理し、意味上の欠落・余分・種類・数量誤りを拒否できるか |
| 補完 F | 元の説明、元の在庫 | 必要な新規部品の全量を提案できるか。在庫差分はアプリが計算する |
| 製品 E | 同一の説明・開始図・在庫 | 補完無効/有効を同じheadで比較し、完成図・描画・保存と補完による改善を分ける |

初回JevのG0は全段階で保持する。changeとincompleteの両方が既存の0.5基準を満たす時だけ、TypeLLMへ一度問い合わせる。TypeLLMは最大3個の新規部品全量を提案し、独立Jevが全量を再判定する。親・矢印・操作・IDは提案できない。受理後、アプリが一度だけ使える在庫を差し引き、不足候補だけを準備する。既存Workingのノードは追加用在庫に数えない。

必要部品が全部揃う自然文をTypeLLMが解釈した場合は、候補追加0と解釈費用を別に記録する。Bが正しく転記したのにG0が不完全と誤判定した費用も別に残す。TypeLLMを呼べたことや描画が表示されたことだけでは効果ありとしない。

初回の公開F6は exact3be7dba2b30b75a286c7139e2aaf5038faf695aa の実配布物で一回ずつ実行した。正確2/6、構造上有効3/6、形式不正3/6。PF05は既知の種類誤り、PF01/PF04/PF06は502 parts_contractで止まり、取得しなかった内部値や具体的原因は不明のまま残す。独立したraw/provider/固定producerの検証はPASSで、製品品質の基準は未達。停止・精算後の累計は689Jev/46TypeLLM（実送689/45、予約なし）。[停止証拠](evidence/index.json)には成功・失敗の全6件を含める。

[修正1](correction-1.md)のexact0861f5c42cbd5f5412c465fff33ff036361591e8で公開F6/V6を全件測り直した。Fは再び正確2/6・形式不正3/6、Vは正しい案の受理0/3・誤りの拒否3/3で判定3/6。両機構の未達を独立して確認し、全停止・送信照合後の累計は695Jev/52TypeLLM（実送695/51、予約なし）。

[修正2](correction-2.md)では全NEW要求の抽出へ在庫容量を渡さず、Vのgeneric標準名の扱いと在庫不足との区別を明確にする。元のG0・4因子・閉じた型・0.5閾値・在庫差分・評価基準は固定する。Eと未見入力は、同じheadの公開F6/V6/E2をすべて通るまで解放しない。

プロセスと予算は [protocol](protocol.md)、独立封印は [commitment](preregistered/requirements-cycle-commitment.json)、封印時の元文書は [agreed plan](preregistered/agreed-plan.md)。次サイクル上限300Jev/40TypeLLM、開始時の課金上の累計689/40。過去の保守的な未送信Type1回分も差し引かない。

```mermaid
flowchart LR
  A[同じRと評価・予算を合意] --> B[公開例と未見例を独立封印]
  B --> C[実装・完成artifact・keyless CI]
  C --> D[公開F6とV6]
  D -->|未達: 最大2修正| C
  D -->|通過| E[同一headの公開E2比較]
  E -->|2改善| F[未見V10・F8・E10]
  E -->|未達| G[未達・効果未証明を保存]
  F --> H[停止・送信数照合・独立採点]
  G --> H
  H --> I[正確なartifactをCIで再検証・実描画]
  I --> J[効果・未達・未証明と採用判断]
```

公開Eの後に意味を変える修正をした場合、旧headの成功pairを持ち越さない。修正枠では新headの両pairを再測定できない場合、未見Eを消費せず未達で閉じる。余った予算を自動的に追加しない。

通常の /api/parts/check は adaptive-v2。比較用 literal-v2 も同じWorkerの実HTTPを使い、初回G0をキャッシュしない。従来の literal/typed 経路と /complete の既定literalは履歴・互換用。新しいGoalは受理済みreceiptから候補を準備するので、二度目のTypeLLM呼出しや /complete はない。

opsの公開provider artifactをappsが利用する。今回の要件の意味・在庫差分・Goalへの受け渡しはappsが所有する。envsのsecret authoringと正規ローカル起動は [既存の起動文書](../typellm-poc-20261017/README.md#ローカル実行と-envs) を参照。APIキーをチャット・コード・ブラウザへ渡さず、既存のenvs復号経路でJEV_API_KEYとTYPELLM_API_KEYをプロセスへ注入する。新しい実行にも必ず残予算予約を先行させる。

今回の機構を起動する場合は、旧起動例のAPPS_REFと--apps-shaを今回の評価headへ合わせる。PRのhead、実行runtime、配布manifestが同じrevisionを指すことを確認する。envsとlauncherの固定revision・復号経路は同じで、キーの再入力や別のsecretコピーは不要。

CI起点での実API実行は別の性質で、現時点では未証明。CIは停止済みの実出力・送信記録・正確な配布物と、再描画を検証する。UI PRのmergeは既存の明示的人間承認条件に従う。

