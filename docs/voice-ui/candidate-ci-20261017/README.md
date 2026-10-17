# 候補準備方式の比較と CI の証明範囲

対象は [apps#94](https://github.com/roccho-dev/apps/issues/94) と [三点補正](https://github.com/roccho-dev/apps/issues/94#issuecomment-6231599715)。旧 PoC の成功・失敗・予算を引き継ぐ。User が指定した root と継続独立 subagent 一名の組成で行い、新しい評価サービスや辞書は置かない。

独立 R と実装開始前に、次の工程と `packages/voice-ui/acceptance/candidate-plan.json` の有限条件を合意した。root が実装・provider 呼出しを担当し、R は評価対象を変更せず、別 worktree で oracle・採点・原証拠確認を担当する。GitHub 投稿 principal は同じであり、別アカウントによる承認とは扱わない。

```mermaid
flowchart TD
  P[条件・累計予算・未見poolを固定] --> O[最小実装・offline契約試験・exact CI]
  O --> R[独立R: source・完成物・harness・予約を確認]
  R --> A[公開8例でA/B/C比較]
  A --> F{原因を特定できたか}
  F -->|根拠あり・最大2batch・予約内| X[失敗cellと十分/control回帰だけ修正検証]
  X --> F
  F -->|候補固定・keyless gate成立| H[未見10例を一度だけ開く]
  H --> S[停止・精算後にR採点]
  S --> C[CIで原証拠と完成物browserを検算]
  F -->|根拠なし・上限| C
  C --> E[効果あり・未達・未証明を軸ごとに記録]
```

## 比較する差分

- A は八つの既存候補のみ。不足判定後も通常の合法選択を実行し、強制失敗させない。
- B は kind + 引用名、引用名の列 + 「という」+ kind、既存名 + 十進個数 + 追加という有限の文法を保守的に転記する。kind は既存の有限 kind と DataBundle の label から取得する。例ごとの名称辞書、自由文の解釈・命名・親子/辺の生成はない。未対応の言い方は意味上の STOP として採点し、モデルへ迂回しない。原文 span を保存する。
- C は一回の TypeLLM POST で最大三つの異なる不足 pair と個数を準備する。旧配列の最初の一種類で終わる失敗に対し、三つの ordinal を明示した固定 slot を検証する。active slot の重複、穴、総個数超過は厳格に検証し、kind none は bounded padding として候補を作らない。
- D の通常 Sys2 は費用未承認で実行しない。A/B/C の暫定比較から四方式比較完了や TypeLLM 固有の優位を推定しない。

全 arm が同じ初期 log bytes、八部品、gate、0.5 floor、合法選択、証明、180秒期限を使う。追加は既存名前付き group 内の三 region・一本の flow まで。名前、kind、個数、parent、辺方向、余分な要素の不在と既存の意味保持を採点する。ASR 後の文字列が対象で、マイク精度は対象外。

公開例を修正に使い、未見を一度開いたら以後の未見には使わない。R は新 pool を独立封印し、未消費 pool は公開しない。修正後に新候補を評価するには未消費入力と新しい予算予約を必要とする。

## 予算と判定

既計上 Jev292／TypeLLM18 を含む各1,000上限。公開216 Jev、原因修正最大二回各60、最終未見270、setup/lifecycle48を割り当て、worst total946／未割当54とする。Type は当 tranche worst84。最終未見の予約を途中修正に流用しない。失敗・timeout・不明を含む物理送信を計上し、自動 retry はしない。既存の一つの journal/lock へ予約し、所有 process group の停止確認後に精算する。

最終暫定方式は gate10/10、十分4/4かつA非劣化、不足完全一致4/4かつ最小4/4、control不変2/2、十分/controlのType呼出し0を必要とする。C採用の根拠には不足の完全一致でBより一件以上・Aより二件以上の改善も必要。B/Aが同等に満たすなら小さい方を選ぶ。POST数を通貨費用とは呼ばず、usage/価格の検証がなければ `COST_NOT_MEASURED` とする。

`EFFECT` は事前条件を満たして再現した有限範囲、`UNMET` は有効な測定での基準未達、`UNPROVEN` は未実行・評価不能・証拠/疎通不足を表す。CIの証拠検算成功を製品性能の合格と混同しない。

## CI と実 API の境界

三つを別の証拠軸にする。

1. CI 内の keyless 完成 ZIP / real Chromium / UI controls の機構試験。
2. 既存 envs → own launcher による自動実 provider 比較。
3. CI による、その停止・精算済み実測原証拠の検算。

既存の GitHub-hosted CI から own 専用 identity へ到達する正規 route は確認できていない。秘密鍵を移送せず、own 実行を CI-origin と呼ばない。このままでは `CI_LIVE_EXECUTION=UNPROVEN` であり、四方式の全条件を CI のみで閉包したとは主張しない。

描画は実配布 ZIP を検証して real Chromium 1280×720、DPR1、固定 runtime/font と overview→named-group camera の順で観測する。意味データ一致・SVG存在・スクリーンショット取得だけでは合格にしない。同名 instance の対応、label全体とclip/viewport、shape containment、見出し/兄弟の重なり、実際の描画辺の端点/方向、Undo/Apply/reload、および壊した反例を検査する。未知のSVG grammarや対応付けは未証明。失敗後の camera 調整、人手目視による合格補完、任意の図の美しさへの一般化はしない。

実呼出し前の機構試験で、大きな親境界の空白まで縮小すると固定 screen font の見出しと子 shape が重なること、内部 label clip が glyph 上端を切ることが判明した。UI は boundary title のみ tight clip を外し、普通の cell/lane は保持する。apps は populated group の原点・固定 title allowance・全 direct child の実 layout box を固定32 marginで収める。空 group は中央 label を持つ collapsed node なので full box を収める。常に scale≤1、意味・pin は変えない。未使用の親境界全体の viewport 内表示は保証しない。実 title/全 child shape/whole glyph の条件は引き続き厳格に検証し、長い名前は未達になり得る。

release CI は生成した完成 ZIP を展開して member 同一性を確認し、その展開先から Worker/site を実行して機構 receipt を保存する。通常の Nix check も同じ keyless browser gate を実行する。実 provider 比較後は、消費した全 arm の停止済み log を normal restore で完成物へ読み戻す。replay の証拠検算成功と、描画の PASS／UNMET／UNPROVEN は別である。overview は復元・意味不変の確認に限り、閉じた子の可視性を推定しない。

## 公開比較からの原因修正

最初の公開比較は f2e9a4c で 5/24 arm に達した時点の HTTP 不明応答で停止し、INVALID とした。17 Jev／1 Type。成功した部分だけで全体の性能を合格にしない。元の失敗応答には status/body が保存されておらず、後続診断で復元したとは扱わない。

同じ公開 payload を使った別診断は各一回で停止・精算した。f2 の一回は 502 parts_contract。診断専用 cfd86a2 の一回は型の形自体は正しい一方、active slot の個数0・重複 pair によるローカル検証拒否と判明した。間の bootstrap 失敗は送信0回。これまでの累計計上309 Jev／21 Type（Typeに既往の保守計上1回を含む）。この結果は有限個数・ordinal 表現の修正仮説を支え、元の失敗理由や修正効果を証明しない。

修正一回目では open integer を既存 provider が扱える文字列の有限選択肢 0/1/2/3 に替え、その四文字列だけを従来の数値検証へ渡す。各 slot は他の生成結果に依存せず、入力内の第一・第二・第三の不足 pair を探す。未使用 slot の empty/none/0、重複、穴、総数の拒否は維持する。修正を理由に全 ABC を再実行しない。H01-C／H09-C／H10-C の十分・control 回帰後、失敗した H05-C だけを測る。最大36 Jev／1 Type、既定の修正60枠内。

このような選択 cell の入力は公開親入力の SHA と fixture/utterance の完全一致を検証し、選択順を別 schema の receipt に残す。修正と未試行公開 cell の継続は部分記録であり、異なる source の結果を合算して同一 source の完全 panel と呼ばない。未見評価は最終固定 source で ABC 全体を一度だけ実行する。

修正一回目は三 guard を正しく処理したが、H05-C は active の個数が1へ直った一方、unused kind-none slot に nonempty label/count1 が残り、502で停止した。4 cell の元記録は INVALID のまま保持する。7 Jev／1 Type、累計316／22、全停止・精算済み。これは個数表現の改善仮説を支えるが、補完性能の合格ではない。

最後の原因修正では、R と実行前に tagged slot の契約を明示して合意した。kind none は候補を作らず、その label/count は padding とする。全 slot の exact fields、bounded string label、四つの quantity string enum は維持し、active の名前・kind・個数1〜3・総数・重複・穴は従来どおり拒否する。不要な filler 値を実候補へ変換せず、過去の失敗を再採点しない。採点 oracle、最小性、効果判定の閾値も変えない。同じ公開四 cell の C だけを二回目として一度検証し、以後の原因修正 batch は追加しない。

二回目の上限は36 Jev／4 Type（期待する補完は1回）。誤って十分/controlから生成した場合も、後続 cell の予算を先に使い切らず、違反をそのまま観測するための ceiling であり、再試行の許可ではない。その後の公開継続は、過去の全試行・回帰確認を含めて未試行の17 cell のみ、元の相対順序で153 Jev／4 Typeを予約する。既定の公開216／8、修正二枠、保護した未見270の範囲内で、guard・判定閾値を維持する。

二回目は四 cell を有効に記録し、H05-C の新名一部品と十分/control三件が一致した。10 Jev／1 Type、累計326／23。続く未試行17 cell も有効に記録し、gate は17/17、十分/controlの不変・生成禁止も成立した。87 Jev／3 Type、累計413／26で停止・精算した。C はH07のDB不足2個を補えたが、H06では異なる三群名を第一名の重複と既存名で置換し、H08では名前付きstepを候補から取りこぼした。Bはその二件を含む継続内の不足三件が完全一致した。いずれも元のrawと独立Rの固定producerを保存し、版をまたいだ完全panelには合算しない。

未見入力の解放前に primary selected method を **B（比較・推奨方式）** と固定する。公開診断では最小の十分な方式であり、最終固定sourceでABC全30 cellを一回測る。通常UIの補完経路はCのままで、Bは比較driverの有限抽出である。Bの有限合格をTypeLLM固有の効果や通常UIの品質達成へ置換しない。製品方式Bを採用したとは報告せず、そのための製品経路変更・検証はこの測定に含めない。原因修正二枠は消費済みで、未見の結果から第三修正や未見再利用を行わない。

`evidence/index.json` は停止済みphaseの原記録・journal prefix・source/zero-send/stopの独立確認・固定producerを参照する。release CIは記録された各SHAの完成物を作り、ZIP検証、全rawの再採点、物理送信と一つのjournalの精算、全armの実Chromium再描画、34改変反例を検算する。固定期待値を実行時に生成しない。原記録のINVALID、部分記録、意味/描画未達は検算成功後も保持する。

UIは人手merge条件を残す候補756d47eをpinする。この候補compositionの測定を、将来のcanonical pinへ無条件に移さない。移せるのはUI merge treeがレビュー済treeに一致し、通常実行入力と配布runtime bytesがraw同一であり、差分が事前列挙したrevision/provenance metadataのみの場合に限る。その場合も新compositionの完成物browserとfull CIを再確認する。不一致なら新compositionの性能は未証明とする。
