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
