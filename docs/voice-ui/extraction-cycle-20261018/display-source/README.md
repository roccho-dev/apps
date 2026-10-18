# 明示表示名と標準名を分ける一候補

問いは「明示された表示名と種類の標準名を区別する出力契約なら、完全NEWの名前・種類・総個数を保持できるか」。[前の16件](../README.md)は、定義を空にするだけでは両既知例を解決しなかった。原文名保持指示も既存なので、それを追加しただけとは扱わない。

この候補はF専用の opt-in generation=display-source としてのみ実装する。通常UI、G0、V、Goal、在庫差分、保存への採用は今回に含めない。Jevを呼ばず、一つの抽出HTTP要求がTypeを一度だけ呼ぶ。

候補は各順位に label_source（utterance / definition / none）を加える。utteranceは原文の連続部分文字列、definitionは定義中の同じlabel/kind、noneは空label/none kind/quantity0を要求する。余分なfieldや無効な型・数量・重複は拒否する。完全に検証できた値からlabel_sourceだけを除き、名前・種類・数量は補正せず従来の三つ組へ変換する。検証済みsource_slotsは段階ログに保持する。無効な生値はログや応答へ公開しない。

部分文字列一致や定義一致は、表示名の意図、種類、個数、出所分類の意味的正しさを保証しない。意味評価は公開正解と独立評価が担い、将来の通常経路ではVも引き続き必要である。

同じ完成Workerで現行DFと候補を比較する。両方とも全定義を保持し、provider・model・temperature・timeoutは同じ。upstream proposalsで正式に分離されたJev/TypeLLM完成artifactを両方に共用する。公開4入力それぞれについて、現行DFのType送信bodyが測定済みfe6329eのDFとbyte一致するキー不要検証を、実行前に行う。候補との差は質問の出力契約だけであることを束縛する。これは実live upstream bodyの直接捕捉でも品質測定でもない。typellm-latestの解決先版は未観測とする。

[公開計画](public.input.json)は既知QE03/04と、明示名なし標準名・新規追加なしNEW0の2control、計4例。各current/candidateを一度ずつ、交互順の固定8枠で測る。[公開正解](public.oracle.json)はcallerに読ませない。全8枠を分母に残し、HTTP契約拒否・他HTTPエラー・構造INVALID・応答なしunknown・意味誤り・正答を分ける。有効な両応答で「現行意味誤り→候補正答」だけを意味gainに数える。契約成立率の差は別記する。

公開gateは候補4/4の閉契約・完全NEW exact/minimal、明示名2例にvalid paired gainが1以上、全4例の回帰0、標準名/NEW0正答である。両方正答なら候補品質と改善未観測を分ける。INVALIDはgain・tie・NO_EFFECTへ数えない。未達なら全失敗を保持して閉じ、未見を使わず、次の条件は別に合意する。同phaseの再送は行わない。

同じ独立担当が[新規未見4例を封印済み](heldout.commitment.json)。旧unused sealsは開けていない。公開gateを満たした後に限り、同じ凍結候補について入力だけを解放する。未見も4例各2arm、0J/8Tを別phaseで固定し、候補4/4・明示名2例でvalid paired gain≥1・全4回帰0を有限改善条件とする。正解は物理停止・精算後に解放する。

未見のdata-only envelope規則も公開測定前に固定する。解放されるvoice-ui.extraction-comparison-input/1の原bytes10917B・SHA dd66904853ae031c68e632c67d3bfc3a974141ce77fa4f83ecb406ad0a149874を保持する。casesのid/requestとscheduleは無変更で包み、roleは全てnullとする。公開計画と同じendpoint/2arm/capを加え、scopeはFRESH_FOUR_CASE_EXTRACTION_ONLY_NOT_ORDINARY_UI_EFFECTへ区別する。sealed_inputには同じfolder内の原入力filenameとhashを記す。callerが実bytes/hashと全request・順序の同一性を検証し、oracleや役割の正解を補わない。このdata-only包装のために候補コードやcallerを変更しない。freshの開始前にも公開登録・wire・同PID送信0の確認を別途行う。

現累計charged847J/104T、各1000以内。公開phase cap0J/8T、setup実送/再試行/修正実送0、最悪847/112。未見phaseへ自動進行せず、先に停止・精算・独立評価へ戻る。通常UI効果はさらに別の比較を要する。Fの成功だけで製品EFFECTや完成へ昇格しない。Apps draftとUI#362の人間merge条件を保持する。
