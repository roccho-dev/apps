部品が揃っているときの表現、部品集合の正誤判定、不足の補完を分けて検証します。**直前の公開例はTypeLLMが正しいAPI/step/2を生成しましたが、判定が低確信で保留となり、期待図は未完成です。**

## 今回の問いと変更

**正しい新規部品集合を受理し、誤った集合を拒否できるか。その同じ候補で不足図を完成できるか。**

製品の今回の差分は `requiredQuestion` のcompletenessの文言・重複文脈だけです。原文と候補は既存stateに置き、表示名・種類・総個数の集合が過不足なく一致するかを小さく問います。因子・受理閾値0.5・F/G0/B/Goal・在庫差分・quota・描画・期限を変えません。CのFには前回正式供給したthinking-labelsをそのまま使います。今回もB/C全経路の比較であり、質問だけ・thinkingだけの因果効果を主張しません。

候補head **180fc53e24f0fc2a5fdb098a3748afaff047bab6** / tree **e2fc8ad6a1ccc3e83fa0cdc91e22434c5e02887c**、今回の起点は閉包済み9c838で、測定前の配布検査追随をe3a80fa→180fc53に保存しています。Rootがwriter、独立subagentは継続1名。適用adrsはa6284e58ed99243447e135828d983fc07d2d363e。[工程・事前登録](https://github.com/roccho-dev/apps/blob/180fc53e24f0fc2a5fdb098a3748afaff047bab6/docs/voice-ui/quota-cycle-20261018/preregistered/verifier-cycle-protocol.md)は最初のV送信前に固定しています。

| 順序 | 評価と進行条件 | 最大Jev / TypeLLM | 現在 |
| --- | --- | --- | --- |
| V | 公開6例。正解1を受理、合法な誤集合5を拒否、全6形式成立・誤受理0 | 6 / 0 | 未測定 |
| E公開 | 同じ候補のB/C1対。C完成1/1・実適格な不足改善1・全guard | 19 / 1 | V合格まで実行不可 |
| E封印 | 前回未露出・未実行の同一6例。C6/6・不足改善2、S/対照の不要生成0・全guard | 114 / 6 | 新しい公開gate合格まで入力非解放 |

Vの「拒否」は運用上の不受理です。低確信の保留と、確信を伴うincomplete判定を分け、生のchoice/confidenceも残します。V6に旧Vとの比較はないので、V単独の改善因果は未証明です。V/Eの未達・INVALIDを保存し、次段へ進みません。sealed E6は新規作成・選び直しではなく、元input4875B/f646112d…・oracle10052B/94ba803d…の同一原本を明示的に再登録しました。Rootは本文未読です。

開始累計 **850J/137T**（不確定Type1を保守計上）、今回上限139J/7T、最悪989J/144T。各1000以内、11Jは未割当です。setup送信・retry・correction・途中の候補変更・旧枠の転用はありません。実起動は実artifact/source/wireと全4CI・独立入場の確認後、GETのみ→同じPIDでzero確認→別の一度だけの測定GOです。開始前の凍結時点（2026-10-18 06:10 UTC）で新予約・新起動・実API送信0です。

## 検証状況

[今回の結果欄・主観順位つき打開策表](https://github.com/roccho-dev/apps/blob/180fc53e24f0fc2a5fdb098a3748afaff047bab6/docs/voice-ui/quota-cycle-20261018/verifier-repeat/README.md)。[測定前e3のrelease失敗](https://github.com/roccho-dev/apps/actions/runs/39100870657)は、旧mock検査がV質問文まで同一を要求したためです。失敗を保持し、既存3smokeをVのinstructions/criteria.complete/incompleteの3値だけ固定新literalへ置換する検査に合わせました。型・他質問・state/model/metadataは全一致、F/G0は原bytes一致を要求し、旧/new原captureと両hashを保存します。7 guard検査と実compiled V captureの照合はPASS。製品・両実caller・採点・登録8原本はe3と不変です。

公開登録の既存schema・合法6例・固定採点・14負例は独立検査PASS。Rootの関連40検査＋V raw/binding2検査、NOT_MEASURED閉包CLIはPASSで、モデル性能の証拠とは扱いません。

Vは既存requirements caller/audit/grade（このprofileだけregistryを加え18source、legacy17不変）、Eは既存quota caller/audit/grade28sourceを使います。既存第7 quota verifier/artifact内にverifier-repeatを追加し、第8の評価基盤は増やしません。前回までの停止済み記録・基準・旧7閉包も保持します。

exact候補の[Nix](https://github.com/roccho-dev/apps/actions/runs/39101548806)・[release/7閉包](https://github.com/roccho-dev/apps/actions/runs/39101548811)・[artifact](https://github.com/roccho-dev/apps/actions/runs/39101548793)・[auth](https://github.com/roccho-dev/apps/actions/runs/39101548788)は全SUCCESSです。実CI ZIP12126651836（91491442B / SHA d36ec8b5a05ca45d3a24a9297bb7990f09b4714157f4c7d2ac8039962de8297b）は公式293項目検証PASS、manifest38eaa1551f3c828a1c1f262cf94f388f757f27f39690bf6eedc04e839d3ad79aとWorker339e1d841039df6492f5635a74695c7099c6a21348c1cb545503499552057aa8が実runtimeへ一致します。正式両providerも一致。e3→180は290payload同一、metadata2とGit原本へ束縛したe2e/runtime-acceptance.mjs一件だけが異なり、catalog5blob/manifest8pointerも個別照合済みです。37対の実compiled mock（F/G0は同一、Vは固定3scalarのみ）を独立検査しました。

実第7quota artifact12127506995（SHA4f22ab74657c68a7bc58bd72cce887e4bed3c60f87d326ed6cb37ec21cca7649）を含む旧7をRootとRで独立照合中です。Rootは旧54原JSON/audit/replayのbyte一致、前回typed-repeatの公開UNMET保持、新verifier-repeat receipt7de72a3f31af5cf32cc01d8ebbe41548b9c3f080d4ccfeee9d2b57fd1182c901のNOT_MEASURED・品質/効果UNPROVEN・累計850/137・実行0を確認済みです。exact候補の独立R27はこの開始前記録の凍結後に確定し、GET入場と同PID zero後の実測GOを分けます。

## 保持する結果

| 評価範囲 | 観測と意味 |
| --- | --- |
| 独立供給R | O/Q未見2/2、改善0。有限の条件付き表現品質PASS。通常充足判定とは別 |
| 旧通常E | C4/6・B3/6、不足C0/2、gain0。品質UNMET・有限不足2対NO_EFFECT |
| 抽出D | 公開3/4→4/4 gain1、未見4/4対4/4 gain0。候補品質PASS・改善gate UNMET・登録4対NO_EFFECT |
| 直前の公開E | B0/1・C0/1。C候補API/step/2と差分1は正解、V complete/0.46のunknown保留で図は未完成。公開gate UNMET、封印E6未実行・効果UNPROVEN |

直前の測定e7ac78 / 保存9c838は[結果と原証拠](https://github.com/roccho-dev/apps/blob/9c83838bcbfa5c8a6e56eed6558d4fc287a5e300/docs/voice-ui/quota-cycle-20261018/typed-repeat/README.md)、全4CI・実完成ZIP・第7artifact・旧54原JSONのbyte一致と[最終R26](https://github.com/roccho-dev/apps/pull/103#pullrequestreview-5561538864)で閉包済みです。recorded/CI再paintの16 title-box scalar差と、追加SHA一致仮定の失敗も保持し、元のper-frame描画基準で双方PASSとしています。GREENは証拠閉包で、品質の未達を合格には変えません。

[adrs#449](https://github.com/roccho-dev/adrs/issues/449)に従う次の主観順位は、①判定の正誤、②不足補完から描画、③有限Bの採用境界、④CI起点の実API実行証明、⑤thinking増量・表現拡張です。

## 依存・未証明・採用

Jevは正式[Ops567](https://github.com/roccho-org/ops/pull/567)c7ed、TypeLLMは正式[Ops569](https://github.com/roccho-org/ops/pull/569)a724。別々のlocator/ZIP/manifest/proof/provenance/実entryを束縛し、既存envs/公式FD3・FD4経路を保持します。[secret authoringとローカル実行](https://github.com/roccho-dev/apps/blob/180fc53e24f0fc2a5fdb098a3748afaff047bab6/docs/voice-ui/typellm-poc-20261017/README.md#ローカル実行と-envs)。

通常UIの期待図、一般的な充足判定、4方式比較完了、CI起点の実API、通貨費用、任意文一般化、TypeLLM一般の有効/無効、sys2相当性、正式採用は未達または未証明です。[apps#94](https://github.com/roccho-dev/apps/issues/94)へ集約します。Appsはdraft/open/unmerged。[UI362](https://github.com/roccho-dev/ui/pull/362)の人間による明示的merge承認はPENDINGのままです。
