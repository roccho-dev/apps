現状を3つに分けます。**部品を独立に揃えた場合の表現は有限範囲で確認済みです。不足候補の抽出にも公開例で成功があります。正しい候補の受理と、通常画面での期待図の完成は未達です。**

| 能力 | 実測 | 判定・限界 |
| --- | --- | --- |
| 揃った部品を描く | 独立供給RはO/Q未見各2/2、改善0 | 有限の条件付き表現品質PASS。通常の充足判定とは別 |
| 不足を候補として揃える | D抽出は公開gain1、未見4/4対4/4でgain0 | 候補品質PASS・改善gate UNMET・登録4対NO_EFFECT |
| 通常の不足補完から完成 | 旧Eの不足C0/2、直前公開EはB/C0/1 | 製品として未達。Type一般の有効/無効へ拡張しない |
| 正しい集合の受理 | 直前TypeはAPI/step/2と差分1が正解、V complete/0.46でunknown保留 | 0.5閾値未満。incomplete断定でも、充足判定の成功でもない |
| 直前の封印E6 | 入力・oracle非解放、未実行 | 品質・効果UNPROVEN。NO_EFFECTに数えない |

直前の[保存9c838・原証拠](https://github.com/roccho-dev/apps/tree/9c83838bcbfa5c8a6e56eed6558d4fc287a5e300/docs/voice-ui/quota-cycle-20261018/typed-repeat)は全4CI・実完成ZIP・第7artifact・旧54原JSON一致と[独立最終R26](https://github.com/roccho-dev/apps/pull/103#pullrequestreview-5561538864)で閉包済みです。GREENは証拠の閉包で、期待図の未達を変えません。再paintの16 title-box scalar差は両原receiptに保存し、元の描画基準では双方PASSです。Rootの追加SHA一致仮定の失敗も保持し、製品・基準を変えたり再送したりしていません。

## 現状の打開策一覧と優先順位（主観）

| 優先 | 打開策 | 背景 | 今回の扱い |
| --- | --- | --- | --- |
| 1 | 正しい集合の受理・誤集合の拒否を同時に測る | 正しい生成候補がVで止まった | 問いだけを小さくし、公開6例で先行評価 |
| 2 | 同じ候補で不足を補い、期待図まで完成するか測る | 候補の成功と製品効果は別 | V通過後の公開E、さらに通過後の封印E |
| 3 | 最小B方式の採用範囲を定める | 既知の有限成功と任意文の対応範囲は別 | 過去の成功/失敗を保持し、適用境界を明記 |
| 4 | CI起点で実APIが動くことを証明する | 現CIは停止済み実測の再検算 | 引き続き未証明として独立管理 |
| 5 | thinking増量・表現範囲拡張 | 現在の判定不全を打開する証拠がない | 今回の変更対象外 |

[adrs#449](https://github.com/roccho-dev/adrs/issues/449)に従う今回の小さな問いは、**「原文から一意に決まる新規部品の表示名・種類・総個数と、この候補は過不足なく一致するか」**です。製品差分は `requiredQuestion` のcompleteness文言・重複文脈のみ。原文・候補はstateで渡し、F/G0/Goal/stock/quota/renderer・因子・0.5閾値・期限を変えません。

## 独立subagent1名と合意済みの工程

候補 [180fc53e24f0fc2a5fdb098a3748afaff047bab6](https://github.com/roccho-dev/apps/commit/180fc53e24f0fc2a5fdb098a3748afaff047bab6)、[事前登録と3段階gate](https://github.com/roccho-dev/apps/blob/180fc53e24f0fc2a5fdb098a3748afaff047bab6/docs/voice-ui/quota-cycle-20261018/preregistered/verifier-cycle-protocol.md)を最初のV送信前に固定しました。

1. 公開V6（6J/0T）：正解API/step/2を受理、表示名・種類・数量・余分・空集合の誤り5例を拒否。全6形式成立・誤受理0。raw choice/confidenceと低確信の保留は別表示。
2. 合格時だけ公開E1ペア（19J/1T）：通常B/C、C完成1/1・実適格不足gain1・全guard。未達/無効なら封印を開かず閉包。
3. 合格時だけ前回未露出・未実行の同じ封印E6（114J/6T）：元原本・順序・oracle・S2/M2/対照2を選び直さず再登録。入力だけ解放し、実停止/精算後にoracleを解放。候補6/6・不足gain2・回帰0/誤採用0・S/対照不要生成0・実描画/Apply/保存/期限を既存基準で評価。

V単独は旧方式との比較がないため、改善因果は主張しません。EもB/C全経路の比較です。実適格性・完成条件を満たす有限範囲だけ「効果あり」「NO_EFFECT」を判定し、未達・未測定・INVALIDを未証明から切り離しません。

開始累計850J/137T（旧不確定Type1を保持）。今回139J/7T、最悪989J/144T、各1000以内、11J未割当。setup送信/retry/correction/途中の候補変更/旧枠転用0です。開始前の凍結時点（2026-10-18 06:10 UTC）では新予約・新app・実API送信0。独立登録の合法性・固定採点・14負例、Root関連40＋V2検査、NOT_MEASURED閉包CLIはPASSで、モデル性能の証拠ではありません。

[測定前e3のrelease失敗](https://github.com/roccho-dev/apps/actions/runs/39100870657)は旧mockがV質問文も同一と要求したためでした。失敗は保持し、Vのinstructions/criteria.complete/incompleteの3値だけを固定新literalへ変える検査へ合わせました。他の型・state・質問・model/metadataとF/G0は完全一致を継続し、原capture・両hashを保存します。7 guard検査と実compiled V capture照合PASS。製品・実caller・採点・登録8原本は変えていません。

修正後候補の4CIは全SUCCESS。実CI ZIP12126651836（91491442B/d36ec8…）は公式293検証PASS、実runtime manifest38eaa1…/Worker339e…/正式両providerへ一致。e3→180は290payload原byte一致、metadata2＋公開Git sourceへ束縛したe2e helper1のみの差で、5catalog blob/8manifest pointerを個別照合しました。独立browser記録37対もPASS。実7閉包をRootが再検算し、旧54原JSON一致、前回公開UNMET保持、新verifier-repeat receipt7de72a3f…のNOT_MEASURED/品質・効果UNPROVEN/累計850137/実行0を確認しました。独立R27はこの開始前記録を凍結後に確定します。入場後もGETのみ→同一PIDのzero確認→別の一度の実測GO→停止/精算→独立採点を守ります。Vは既存requirements18source（legacy17維持）、Eはquota28source。既存第7CI/artifactへ結果を追加します。

[Apps#103](https://github.com/roccho-dev/apps/pull/103)はdraft/open、[UI#362](https://github.com/roccho-dev/ui/pull/362)は同head756d47・人間の明示的merge承認PENDINGです。正式Ops567 Jev c7ed / Ops569 Type a724、既存envsのsecret authoringと公式FD3/FD4経路を維持します。通常期待図・一般化・4方式比較完了・CI起点実API・費用・正式採用は未達または未証明です。
