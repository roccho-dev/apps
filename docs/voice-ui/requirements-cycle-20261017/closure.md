# Bounded requirements cycle: result

今回の反復は、実装前に合意した最大2回の原因仮説修正で停止した。判定文の修正に公開例での改善が見られた一方、TypeLLMによる必要部品の全量提案は公開gateを通らず、製品としての補完効果は未証明である。TypeLLM全体に効果がない、という結論ではない。

## 分離した結果

| 性能 | 観測 | 判断と範囲 |
| --- | --- | --- |
| 揃った部品を描く R | 前回286eの在庫・期待graph・実paintが各8/8 | 有限試験の条件付きPASS。今回の全実測headでGoal等の6ファイルと実配布semantic-map231ファイルが同一。新しい補完経路の製品完成を証明しない |
| 部品案が説明を満たすか検証する V | 修正1で正解3/6、修正2で6/6。正しい案の受理0/3→3/3、誤案の拒否3/3を維持 | 公開回帰6件で局所改善あり。未見V10は未実行で、一般化は未証明。初回G0の充足判定性能とも別 |
| 部品が足りない時に揃える F | 初回・修正1・修正2とも正確2/6。形式不正は3件・3件・4件 | 公開F gate未達。最後は2件のみ有効で、無効出力の内部scalar値・具体的原因は未取得。全体の品質優位は主張しない |
| 補完を使う製品 E | 今回の公開E2も未見E10も未実行 | F gate未達により未解放。補完による完成図・描画・保存の改善、因果効果とも未証明 |

Vは構造上合法な必要部品案を与えて、その全NEW一覧の正否を判断する試験。Fは説明から全NEW一覧を出す試験。在庫との差分はアプリが計算し、親子・接続・ID・操作は既存Goalが所有する。V6成功をF成功やG0の充足判定成功へ読み替えない。

## 残した全実行

| exact測定head | phase | 正確・正解 | 有効 / 全件 | 実送Jev / Type |
| --- | --- | ---: | ---: | ---: |
| 3be7dba2b30b75a286c7139e2aaf5038faf695aa | 初回F6 | 2/6 | 3/6 | 0 / 6 |
| 0861f5c42cbd5f5412c465fff33ff036361591e8 | 修正1 F6 | 2/6 | 3/6 | 0 / 6 |
| 0861f5c42cbd5f5412c465fff33ff036361591e8 | 修正1 V6 | 3/6 | 6/6 | 6 / 0 |
| 31e8fabaeb679c8bb02db8029f36de410d012adb | 修正2 F6 | 2/6 | 2/6 | 0 / 6 |
| 31e8fabaeb679c8bb02db8029f36de410d012adb | 修正2 V6 | 6/6 | 6/6 | 6 / 0 |

全30件を[固定producer付きの順序付きindex](evidence/index.json)に残す。最後のF6はPF02/PF03だけが正確で、PF01/PF04/PF05/PF06は502 parts_contract。過去の誤種類・無効出力も削除しない。各修正は新しいsource admission後の全F6/V6を一度ずつ実行し、応答の再試行はしていない。

今回12Jev/18TypeLLMを実送し、課金上の累計701Jev/58TypeLLM、確認済み実送701/57。過去の保守的な未送信Type1回分を維持した。各1000回上限内、登録した追加300J/40T内、各修正25J/7T内。最終cutoffは64e3f3f25294e1e9464c381f59868a7aee17899cf47381065138fbbd3c1b63c4。所有PID/PGID全memberの停止、送信数照合、予約解消を独立確認する。別用途の既存プロセスは対象外。

## CIで閉じるもの

必須release CIは、各測定headの実配布物を再buildしZIPへ梱包・再展開する。独立Rが停止後に固定したproducer、raw、実Worker/provider/protocol、17測定source、stdoutの段階、stderrの実送信、順序付きjournalと公開入力を照合し、無効実行もそのまま再採点する。Eが存在する場合は保存した出力を実画面へ再描画・再採点するが、今回のcycleにはEがない。

完成ZIPの別のprovider-free mechanicsは、実DOMでの描画・Apply・再読込と無効応答拒否を検証する。合成応答のmechanics成功も、停止済み実API出力のCI integrity PASSも、未実行の製品EやCI起点実APIを証明しない。

機械分類は全5phaseをPUBLIC_REGRESSION_ONLYとして保存し、rawのV6 PASSとF UNMETを併記する。quality/effectの分類器・採点器・公開/未見seal・閾値は変更しない。順序付きprocess検証はbaseline689/40以降の予約を一件も落とさず、同一headの公開F/V/E2がすべて通るまでfresh解放0を要求する。F未達で公開E/freshを使わない停止は登録した工程どおりである。

## 採用と残る未証明

製品採用・任意の説明への性能・未見V/F/E・四方式全比較・CI起点実API実行・金額費用は未証明。V文言の局所改善を保ち、Fの未達を修正済みとして扱わない。残予算があっても第三修正や別条件への読み替えをこのcycleへ追加しない。新仮説を試す場合は別の事前合意・独立評価に分ける。

opsの既公開provider coreをappsが依存する構成とenvs正規secret経路を維持する。[ローカル起動文書](../typellm-poc-20261017/README.md#ローカル実行と-envs)を使い、APIキーのコピーや再入力は不要。Apps PRはdraft/open/unmerged、UI PRは既存の明示的人間承認条件を満たすまでunmerged。CI_LIVE_EXECUTION=UNPROVEN、currency=COST_NOT_MEASURED。
