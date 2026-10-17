TypeLLM が不足部品の要求案を一度だけ作り、独立検証・在庫差分を通して既存 Goal へ渡す経路を実装しました。受理済みの要求表があるときは、実行候補をその名称・種類・個数まで絞ります。**部品が揃った条件での組み立て R と、不足時の補完 E を別々に評価します。**

現在の候補は 59ded276405a5dc9caa85ad570b1827ff4bd0c7a。新 quota 比較は実 API 未実行です。完成成果物・全4 CI は通過し、独立した同一 head の実測前受入を進めています。draft を維持し、性能達成をまだ主張しません。

## 変更と評価する条件

今回の製品変更は completion.mjs への21行追加です。quotaGoalBundle は既存の部品を元の順番のまま、完全一致する新規要求の個数まで残し、部品名・キー・親子関係・矢印を生成しません。既存の materialization 後に受理済み v2/v3 receipt の required だけを使います。literal-v2 B と adaptive-v3 C の両方へ同じ制約を適用し、旧 receipt がない経路は従来どおりです。Goal/core6・renderer・G0/F/V の質問・文脈・閾値を変更しません。

R は正しい部品8個と新規要求表を同じ入力として与え、全在庫 O と個数制約 Q を比べます。要求表に構造の正解を含めず、native Goal / Apply と実完成 UI の名前付き描画・保存復元を結合します。通常画面の解釈性能や TypeLLM の効果には数えません。E は通常画面の B/C を充足2・不足2・対照2の未見6組で比べ、品質6/6と不足2組の因果改善を別々に判定します。

候補枯渇時は元の no-executable-delta を保存し、NONE の合成や追加 API 呼出しを行いません。再生器は O/Q ファイル名へ最小拡張し、B/C へ別名化しません。旧4 synthetic audit suites は元の open-stock を証明する固定2cc sourceで別実行し、現製品・新評価は現 source で実行します。旧基準・原データ・8 semantic modules は保持します。

## 事前登録と入場

root が実装・caller・CI・実呼出、同じ独立 subagent 1名が封印・正解・採点・監査・producer を担当します。[初回登録0a53641](https://github.com/roccho-dev/apps/tree/0a53641bf75f28d5019785284a91b07374007614/docs/voice-ui/quota-cycle-20261018) の後、保存規約に合わない評価用 map_id が実 API 前に見つかりました。[改訂登録7761be0](https://github.com/roccho-dev/apps/tree/7761be0af16a0d60c3b7ac5fe56348b7a8a4df11/docs/voice-ui/quota-cycle-20261018) で元の公開 bytes を保持し、map_id と対応 oracle hash だけを別名修正しました。文章・構造・個数・順序・基準・予算は同じです。製品の identity gate は緩めていません。

公開 R1 → 公開 E1 → 未見 R2 → 未見 E6 を同一測定 head で一度ずつ実行します。全公開ゲート・source/runtime/完成物・CI・双方による実プロセスの送信ゼロ確認を先行させ、各停止・精算後に対応正解だけを開封します。失敗・INVALID は登録分母へ保持します。全体品質、有限条件の効果、未証明を分け、NO_EFFECT は全登録機会の適格性と必要な描画・保存・期限の証拠が揃った改善ゼロの場合に限ります。

独立28群、quota5群、既存 completion/frontier-policy/requirements/completion-goal の現 source 回帰は手元で PASS。新閉包の空 index は integrity PASS / NOT_MEASURED です。比較 caller が製品 helper を使う1箇所だけを静的検査の named evidence entrypoint とし、呼出元・import・返り値の実使用と否定例を検査します。既存の未使用 export 検査を維持し、静的14群がPASS。[Nix](https://github.com/roccho-dev/apps/actions/runs/39076041759)・[release](https://github.com/roccho-dev/apps/actions/runs/39076041775)・[artifact](https://github.com/roccho-dev/apps/actions/runs/39076041791)・[auth](https://github.com/roccho-dev/apps/actions/runs/39076041753) の全4 CI が同一 head で PASS。実測入場は独立担当の最終受入待ちです。過去6必須閉包に新 quota 閉包を追加し、CI が原 HTTP/ログ/実候補/選択キー/原グラフ/保存/再描画/台帳/固定 producer を再計算します。CI の緑を品質達成に置き換えません。

完成 ZIP からの [実ブラウザー成果物](https://github.com/roccho-dev/apps/actions/runs/39076041775/artifacts/12117775032) を双方で独立再検算しました。新 quota 機構は12セル・保持 INVALID4・名前付き描画26・protocol prefix30・source28・G0/F/V原 wire3組が PASS。旧 frontier 機構も40セル・保持 INVALID14・原 wire22組・期限境界60行を保持します。すべて synthetic で実モデル性能の証拠には数えません。過去6系列の実 CI 閉包は元の採点・失敗・台帳・原 JSON と一致し、今回の [新 quota 閉包](https://github.com/roccho-dev/apps/actions/runs/39076041775/artifacts/12117910657) は18公開ファイルと旧台帳を再照合して NOT_MEASURED / quality・effect UNPROVEN、receipt 5fba49e7d43c2d226a4b8a90c7f9450dcaa6ccf048f1d91556fe7c3ff14e2233 です。

## 前回までの実測（維持）

| 対象 | 結果 | 判定 |
| --- | --- | --- |
| 揃った部品の条件付き描画 | 従来 R8/8 | 元の有限範囲の証拠 |
| 前回 G0 | policy10/10、分類8/10 | 分類 UNMET |
| 前回 V | 9/10、誤受理0 | UNMET |
| 前回 F | 全8件中有効7件、HTTP502失敗1 | 全体 UNPROVEN |
| 前回未見 E | C5/10、B5/10、改善1、回帰1、誤採用1 | 品質・効果 UNMET |
| 新 frontier 固有効果／無効性 | 公開の成功を未見へ繰り上げない | UNPROVEN |

[前回0aa報告と原証拠](https://github.com/roccho-dev/apps/tree/0aa3c4b90519a1c18c217753698806507ccff3c0/docs/voice-ui/frontier-cycle-20261018) は全4 CI と [独立 R20](https://github.com/roccho-dev/apps/pull/103#pullrequestreview-5560292063) で閉包済みです。FE07 の正しい TypeLLM 候補の後に不要な「判断」を足した失敗を、新候補生成と別の組み立て課題として今回検証します。

累積808Jev/85TypeLLM（確認済み808/84、過去の不確定Type1を保持）、今回の追加実送0。登録上限181J/7T、最悪累積989J/92T、各1000上限。残る11Jは未割当で自動消費しません。再試行・修正・診断・setup呼出し0。CI 起点の実 API 実行と通貨費用は未証明です。

[Ops#565](https://github.com/roccho-org/ops/pull/565) の正式 provider と [envs・ローカル起動](https://github.com/roccho-dev/apps/blob/0aa3c4b90519a1c18c217753698806507ccff3c0/docs/voice-ui/typellm-poc-20261017/README.md#ローカル実行と-envs) を利用します。[UI#362](https://github.com/roccho-dev/ui/pull/362) の人による明示 merge 条件は保持します。[apps#94](https://github.com/roccho-dev/apps/issues/94#issuecomment-6241893675) に継続記録します。
