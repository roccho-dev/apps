# 表示名3項目だけのthinkingで改善するか

[Bの出所契約](../display-source/README.md)は両2/4、[Cの平坦化](../scalar-questions/README.md)は両3/4で、どちらも有効な対の意味gain0だった。API/step/2が工程/step/2へ置き換わる失敗が残る。モデル一般の無効性は未証明である。

次の問いは「同じ9scalarの表示名3項目だけに、予算を限定したthinkingを付けると改善するか」。[公式Thinking](https://typellm.ai/docs/thinking)のfield単位の指定を、[Ops#569](https://github.com/roccho-org/ops/pull/569)で独立coreの任意機能として供給する。既定offの送信内容は保ち、Appsは正式に公開・検証されたproviderを依存として採用する。鍵の経路を変えず、providerから直接呼び出す別経路は作らない。

依存更新はTypeLLMだけをOps569のa724bdfa1864762cd9050a00e2642450af29c196へ進め、Jevの正式c7ed pinは保持する。phaseの既存heads.opsはDのType producerを識別する粗い欄で、全依存が同じOps commitとは解釈しない。各providerの正確なlocator/proof/source/entry bytesはruntime.manifest_sourcesの個別欄で検証する。新しいidentity schemaは追加しない。

F専用generation=thinking-labelsを用いる。現行armはflat-scalarsでCと同じ9scalar、候補はrequired1_label/required2_label/required3_labelだけthinking:trueとthinking_budget:512を付ける。型・質問文・全定義・列挙順・依存DAG・model・temperature・30秒service timeout・35秒provider deadline・40秒API deadline・無補正の9値→旧slots写像は保持する。通常UI/G0/V/Goalへの採用は含めない。

同じ完成Worker・正式providerで比較する。キー不要wireでは現行4件を測定済みC a58e5226のflat4bodyへUTF8完全一致で束縛し、候補との差が表示名3問の宣言したthinking設定だけであることを検証する。解決先model版やAPI内部のprompt/機構は未観測のまま。D generationだけTYPE_REQUIRED stageへ任意のprovider_usage（input_tokens/thinking_tokensの正規化済み非負safe integer2値）を許す。既存flat/default stageのkeysは変えず、思考本文は記録・公開しない。数値usageの有無や消費量は別記し、追加gateや意味正解・内部機構の証明へ置き換えない。

[公開4例](public.input.json)はB/Cと同じ原requestで、既知の出荷可否・API2・標準名・NEW0。各current/candidate一度、交互順の固定8枠、0J/8T、追加疎通・再試行・修正0。[oracle](public.oracle.json)はcallerへ読ませない。候補4/4の閉契約・完全NEW exact/minimal、明示名2例のvalid paired gain≥1、全4回帰0がgate。HTTP契約拒否・他HTTPエラー・構造INVALID・応答なし・意味誤りを区別して全8枠を分母に残す。INVALIDをgain/tie/NO_EFFECTに数えず、契約成立率も別記する。

実送前に同じ独立担当がsource/正式完成物/両provider/旧body bridge/wireと同PID strict cap/送信0を確認する。一度の測定後にstrict stop・即時台帳・独立採点へ戻る。未達なら全失敗を保持し、同phaseを再送しない。公開gateが未達なら未見を開けない。

B/Cで未開封・未実行の[同じ4例をDへ公開前に再登録](heldout.addendum.json)する工程を独立担当と合意済み。原bytes・順序・正解は無変更で、caseを作り直したり選別しない。公開通過時だけ入力を解放し、同じ凍結candidate/callerで別0J/8Tを行い、その物理停止後にoracleを解放する。data-only envelopeは原10917B/hash dd669…と全cases/requests/scheduleを保持、roleは全null、fresh scopeを区別し、callerが実bytes/hash/順序を検査する。

登録前累計charged847J/120T（旧不確定Type1を含む）、各1000以内。今回公開の最悪847/128、freshへ自動進行しない。thinkingによる精度向上、いわゆるsys2相当性、根本原因は事前に主張しない。F成功だけで通常UI効果や製品完成に昇格せず、Apps draftとUI#362の人間merge条件を保つ。

供給は[正式公開run](https://github.com/roccho-org/ops/actions/runs/39091437239)のSUCCESS後、[root](supply/root-provider-done.json)と[同じ独立担当](supply/ops569-a724-provider-done.json)が7資産・proof・ソース入力・実entryを別々に検証し、ProviderDoneとなった。Type entryはテスト済みCI完成物3c10462e…と一致し、Jevのentryと採用pinは不変である。この供給成功を精度向上やConsumerDoneと数えない。

## 停止後の結果

同じ測定head `b6696c1f579851429cf0cc58a49b20c9ff663475` とcallerで、公開gate通過後に原入力だけを解放し、未見を一度実行した。oracleは全49所有groupの物理停止・精算を双方で確認してから解放した。

| 評価 | 現行 | 候補 | 有効な対の改善 / 回帰 | 判定 |
| --- | --- | --- | --- | --- |
| [公開4例](result.json) | 3/4 | 4/4 | 1 / 0 | 候補品質・公開gate PASS。API/step/2の誤名が改善 |
| [未見4例](fresh.result.json) | 4/4 | 4/4 | 0 / 0 | 候補品質PASS、事前の改善gateはUNMET。登録した未見4組でNO_EFFECT |

全16応答は形式有効で、除外・再試行・追加疎通・修正は0。未見の霧窓/decision/1、DB/step/2、標準名、NEW0は両方式とも正答した。公開の改善1組を未見の改善へ代入しない。TypeLLM一般の有効・無効、内部機構、通常UIでの補完・描画効果と正式採用はUNPROVENで、通常UIへは採用していない。

候補のHTTP所要時間は全8回で約6.5〜11.6秒、現行は約1.9〜2.8秒だった。候補だけの正規化済みusage2値は原stageと結果に保存し、思考本文は保存していない。待ち時間の増加を、未見での追加効果なしと併記する。通貨建て費用は未測定である。

追加16T/0J、累計charged847J/136T（確認847/135、旧不確定Type1を保持）。予約0、全49所有PGIDはZを含め不在、即時cutoffは `2b938983023a8e2627041d52cb943a3d0f6bd530aeed637c606b816a57328d35`。[公開原記録](evidence/public-D)と[未見原記録・入力/正解解放](evidence/fresh-D)を保存する。

起動直後はGETの待受待ちがあったが、各phaseとも同じPIDでGET200・実完成index一致・送信0を双方が確認してからGOした。freshのroot-terminalだけ、継承したscope定型文字列にPUBLICという表記が残った。原helper/証明bytesを変更せず保存し、正しいfresh phase・FRESH identity・原入力/wire・独立停止/解放証拠で識別する。公開評価へ再分類していない。

[測定headの全4CI](measured-head-ci.json)はSUCCESS。完成artifact12122164790の実Workerもruntimeと一致した。既存の `display-source-cycle.test.mjs` を一般化した8テストで、B/Cの失敗とD公開/未見の全32応答、各原file hash、oracle解放順、正答・対比較、停止台帳を再計算する。保存版の最終CIとexact-head独立判定は[Apps#103](https://github.com/roccho-dev/apps/pull/103)へ束縛する。
