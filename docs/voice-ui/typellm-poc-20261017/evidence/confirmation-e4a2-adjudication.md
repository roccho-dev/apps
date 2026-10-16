# Independent final fresh diagnostic adjudication

R /root/poc_reviewer independently evaluated the unchanged Apps e4a2af1efe9278996391f0374d4546a51aa98736 candidate against the original sealed four-case confirmation. Verdict: **VALID_DIAGNOSTIC; EFFECT_NOT_DEMONSTRATED**. This final confirmation does not meet its preregistered criteria and does not erase the earlier main/UI failures.

| Fresh criterion | A, without completion | B, with completion | Requirement |
| --- | ---: | ---: | --- |
| Accepted correct gates | 3/4 | 3/4 | each4/4 |
| Raw correct choices | 4/4 | 4/4 | weak answers do not pass |
| Accepted missing gates | 1/2 | 1/2 | each2/2 |
| Sufficient exact graph | 1/1 | 1/1 | B1/1, no regression |
| Missing exact graphs | 0/2 | 0/2 | B2/2, gain at least1 |
| Minimal missing candidates | — | 0/2 | B2/2 |
| Unchanged control | 1/1 | 1/1 | both |
| TypeLLM on sufficient/control | 0 | 0 | zero |

C01's available start/end parts and directed edge are exact in both arms. C04 remains unchanged. C02 requests two new named peer groups; both raw missing classifications are correct but the label-witness confidences0.40/0.38 are below the unchanged0.5 floor, so neither arm starts completion or drawing. C03 accepts missing in both arms; TypeLLM returns only the containing group 中継室 and omits the requested 受付 step and 受付控 data candidates. B consequently uses canonical 工程/データ labels and fails the exact graph criterion, just as A also fails. The one-row TypeLLM result satisfies the bounded wire schema; it is a quality failure of complete candidate coverage, not an infrastructure/contract error. The fresh comparison shows no exact-graph gain on these two missing cases. It does not negate the two valid positive main cases or establish a universal NO_EFFECT claim.

The raw comparison was fixed before exposure: case order C03,C01,C04,C02, arms BA/AB/BA/AB, identical A/B fixture and initial log bytes, exact same source/bundle/provider/Worker/protocol. Projection SHA2569563e9b3b5dd940528634888e5532862213881fa65113b1f64b703013bc48dc7 came only from the original seal and its explicitly referenced main fixture contract. Expected outputs were not supplied to W or providers before all measurement ended. The original fresh seal f92f733785ef8796eeed83c4880aa6481a32b4a8c2904a5292f5daaab6519fa2 and main fixture seal22e47667ba3d6eaf1061c058b7f3e8fe07824dd3885b24264603a2be0b1f2c32 remain byte-identical.

R copied all11 files (356,504 bytes) and matched every remote/local length and SHA256. All request/closed response pairs, arm ordering, fixture initial semantics/pins, source and budget receipts passed the independent scorer. The actual pinned protocol verified all8 final DecisionLogs and all8 exact initial prefixes with expected heads and records. All8 gate responses recompute exactly from the closed intent/labels/capacity factor log. No retry, incomplete record, cap stop or invalid execution was scored as a quality loss.

The36 Jev/1 TypeLLM recorded HTTP calls equal the sequential actual-send counters. Phase7 stopped/reconciled, and R independently observed PID103224 plus all PGID103224 members absent, including zombies, at17:08:34Z. Cumulative charged275 Jev/18 TypeLLM and confirmed actual275/17 retain the earlier conservative no-transport Type charge. No reservation remains. No further live measurement is authorized by this bounded final-confirmation agreement.

The source review remains distinct: the transport, envs launch, finite boundary and legal/proof/persistence path are supported, but the requested general availability-and-completion behavior is not accepted. Available-part tasks work on these limited tests; novel label judgment can remain weak, and multi-label completion can omit required candidates. The gate's success on exposed main cases did not generalize to all fresh requests. Supplying a TypeLLM key alone has not been shown sufficient for the expected drawing quality. Historical UI layout shrink/label overlap and current fallback UI failure remain limitations.

Machine score SHA25630634124de7ba946c6e6a7a95b140e239410d26ffc9c7537be5bc5d8a78a2596. Factor audit SHA256cd48b9427785f0ad9072648d3aa91984cdf1a1a1929ec9abfa57877ec8aab6c6. The fresh scoring script was fixed before provider outputs at SHA2569c8109fec4f37742483342de50c7c9c2c4f720f3d7cf23694b5a839e6f47c155. Independent protocol, acquisition/cleanup, preflight, original oracle and pre-output process agreement are kept alongside this report. The oracle may now be published unchanged because all provider measurement has stopped and independent scoring is complete.
