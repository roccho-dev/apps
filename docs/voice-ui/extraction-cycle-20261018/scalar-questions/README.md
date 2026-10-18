# 同じ質問を入れ子から独立項目へ出すだけで改善するか

[前候補B](../display-source/README.md)は公開4組で両方式2/4・改善0だった。次の問いは「同じ指示・型・依存DAGのscalarをトップレベルへ出すと、明示表示名の保持が改善するか」だけとする。Opsやモデル、thinking設定を同時に変更しない。

F専用opt-in generation=flat-scalarsを追加する。現行DFの3object×3項目を、required1_label等の9scalarへ平坦化する。親objectの指示を各leafへ一度継承し、親依存を前順位の全leafへ展開する。元のleaf指示・列挙順・enum・全定義入りcontextは保持する。正式Ops providerの規則に従い、top-level scalarにはthinking:falseが付く。旧object内leafはサービスの既定offであり、thinkingを有効化する実験ではない。

応答のちょうど9fieldを、値の補正なしに元の3slotsへ写像し、既存readRequiredSlotsを通す。検証済みscalar_answersだけをstageログへ残す。原文名や種類の意味正解は構造検証と別に採点する。通常UI・G0・V・Goalへの採用は含めない。

[公開4例](public.input.json)はBと同じ原request bytesで、既知の出荷可否・API2・標準名・NEW0を使用する。各current/candidate一度ずつ、交互順の8枠、0J/8T、再送・修正・追加疎通0。oracleはcallerへ渡さない。同じ完成Workerのcurrent DFについて旧fe6329eのbody4件のbyte一致を確認し、候補はcontext/model/options/timeout不変、全leaf指示の継承・DAG・列挙順の一致をキー不要wireで検査する。このwireは実送body直接捕捉や品質測定ではない。

gateは候補4/4の閉契約・完全NEW exact/minimal、明示名2例でvalid paired gain≥1、全4例の回帰0。HTTP契約拒否・他HTTPエラー・構造INVALID・応答なし・意味誤りを区別して全8枠を分母へ残す。INVALIDはgain/tie/NO_EFFECTに数えず、契約成立率の差も別記する。失敗なら停止・精算・全失敗保存し、未見は開けない。仮説の機構や一般性能は未証明のままである。

同じ独立担当は[Bで未開封・未実行の4例を、bytes・順序・正解無変更のままCへ事前再登録](heldout.addendum.json)することに合意した。新しい私的caseの生成・選別は行わない。公開gate通過時だけ入力を解放し、同じ凍結candidate/callerによる別0J/8Tと、停止後oracle解放を行う。data-only envelopeは原10917B/hash dd669…と全cases/request/scheduleを保持し、roleは全null、fresh scopeを区別する。callerが原bytes/hash/順序を検証する。

登録前累計charged847J/112T（旧不確定Type1込み）、各1000以内。公開の最悪847/120。起動前のsource/完成物/両provider/wireと同PID送信0を独立確認する。今回の関連CI確認と、最終全4CI・履歴を含む閉包を区別し、製品採用やApps/UI mergeへ自動進行しない。
