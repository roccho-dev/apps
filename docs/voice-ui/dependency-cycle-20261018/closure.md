# 項目間依存の反復結果

この登録は、公開E2の両問成功という基準に届かず停止した。依存付きの部品全量提案は公開6問で形式有効6/6・過不足なし5/6へ改善し、新しい名前の部品を補って描画できた1例も得た。一方、入口の意図判定で止まる例が残り、製品完成・未見性能・一般的なType効果は未証明である。Typeに効果がないという結論ではない。

## 性能ごとの結果

| 性能 | 観測 | 判断と範囲 |
| --- | --- | --- |
| 揃った部品を描く R | 以前の286eにおける在庫・graph・実paint各8/8。今回もGoal等6sourceと実配布renderer231filesが同一 | 有限条件付きの表現証拠を維持。今回Eの4実行は実paint・Apply・再読込と停止後の完成配布物再描画がすべて整合したが、タスク達成は別に採点 |
| 初回G0 | PE01は両armともintent=ambiguousで停止。PE02は両armとも補完の比較に適格 | 数量を明示した同名部品追加でも入口が保留する未達が残る。PE01のcapacity=exceededは在庫数不足として正しく、表現上限超過とは異なる |
| 部品案の検証 V | 公開6/6正解。正案3件を受理、誤案3件を拒否、誤受理0 | 公開回帰の局所PASS。未見V10・G0の充足判定性能へ読み替えない |
| 部品を揃える F | 同じ6問で依存なしIは有効2/6・正確2/6、依存付きDは有効6/6・正確5/6 | Dの公開進行gateはPASS。形式改善4件、双方有効な意味比較は2組で改善0・退行0。無効Iを意味上の勝利へ数えない。PF04ではDも「データ」の種類を誤り、不必要な不足を報告 |
| 製品 E | Bは達成0/2、Cは達成1/2。PE02で新名「可否照合」の判断部品1個を補充しOCI内へ描画・保存。PE01は両方変更なし | 比較適格1/2、補完による改善1、退行0。全2問を分母に保ち、公開E進行gateはUNMET。全体効果もNO_EFFECTも未証明 |

「説明から必要な全量を読めたか」と「その在庫が揃っているか」を分ける。literal-onlyのBも、必要全量が読めれば不足を決定的に補充できる。Typeはその解釈不足を補う候補のみを提案し、全量の独立V検証後にアプリが在庫差分を計算する。親子・接続・ID・操作と描画は既存Goalが所有する。

## 全実行と停止

測定headはすべて `ae816ec23a5e4c397c8a4893e127fb24134afda8`。実装前の[封印](preregistered/dependency-cycle-freeze.json)・[基準と工程](preregistered/dependency-cycle-protocol.md)・[登録](preregistered/dependency-cycle-commitment.json)を維持した。

| phase | 実行数 | 有効数 | 主結果 | 実送Jev / Type |
| --- | ---: | ---: | --- | ---: |
| public-F | 12 | 8 | I 2/6、D 5/6正確。Iの無効4件も保存 | 0 / 12 |
| public-V | 6 | 6 | 6/6正解 | 6 / 0 |
| public-E | 4 | 4 | C 1/2達成、両arm実paint・保存・再描画4/4整合 | 8 / 1 |

[順序付きindex](evidence/index.json)に全22実行と独立Rが停止後に固定したproducerを保存する。Fの全体executionはINVALIDのまま保持し、候補Dの公開gateと区別する。公開F→V→Eを一度ずつ実行し、修正0・応答再試行0・未見解放0。PE01の失敗を除外せず、旧未使用6ファイルと今回の新未見V10/F8/E10はR側で封印したままである。

今回の実送は14Jev/13TypeLLM。課金上の累計715/71、確認済み実送715/70で、過去の保守的な未送信Type1回分を維持した。各1000回上限と今回250J/40T上限の内側で停止した。最終journal SHA256は `9b5582798122208f1d36968e4646de46573f414739a239f0ea1195a692a5b6ba`。所有した全PID/PGIDの消滅をzombieも含めて確認し、送信数を照合、残予約を解消した。

## CIで閉じる範囲

必須release CIは各測定headの配布物を再build・ZIP化・展開し、19測定source、実Worker/provider/protocol、固定producer、失敗を含むraw、公開parent入力と正解、段階ログ・実送信・全予約を含むjournalを再照合する。Eは記録した出力を実画面へ再描画し、固定した意味採点と分けて検算する。CIがproducerや正解を作り直すことはない。

機械分類は3phaseともPUBLIC_REGRESSION_ONLYとし、公開D/Vの局所PASS、公開EのUNMETと効果UNPROVENを併記する。整合性PASSを品質達成へ昇格させない。現headの独立source/完成配布物/実CI mechanics受入は[R15](https://github.com/roccho-dev/apps/pull/103#pullrequestreview-5559238178)。停止後の必須wrapper事前実行でも3phaseのintegrity/processがPASSした。最終report headの実CI結果はPRの独立読戻しで固定する。

新しい仮説は別の事前合意と独立評価へ分ける。この登録へ修正・再測定を追加したり、未見問題を開いて調整したりしない。製品採用、任意の説明への性能、四方式全比較、CI起点実API実行、金額費用は未証明。Appsはdraft/open/unmerged、UI#362の明示的人間merge承認条件も維持する。Ops#565の正式coreと[envs正規経路・ローカル起動文書](../typellm-poc-20261017/README.md#ローカル実行と-envs)を使い、キーのコピー・再入力は不要である。
