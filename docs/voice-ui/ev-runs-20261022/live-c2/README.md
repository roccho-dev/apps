# EV1 c1 round 2 (live, ungraded)

- Arms: new = apps `d8dae172e00b6d2dd21c4d2afbaafdc93a9fcb46` + ui `893ebce63856d378e0d314ede504cf0899406ab6` (W12: #176, #177); old = apps `9b45544bc4a380391dcb8949a4aa3bc144e7e6fb` + ui `756d47e891191c3344eb2d29b000203be8331abc` (unchanged from round 1).
- Scripts, per-run limits (Jev 208 / 176 / 104, TypeLLM 10), counting and stop rules: as round 1. B uses the sealed stock/2 at `0cbe9b42` (#172).
- Runner: `packages/voice-ui/acceptance/ev-run.mjs` at `f51dab1` (#178, which applies a full draft before the next line), otherwise the merged runner (#167, #168, #170, #171). Receipts record `draft_applies`.
- Two earlier round-2 attempts are void and not here: new presented-2 B stopped `UNKNOWN` at line 18 because the product's full draft disabled Goal (the gap #178 fixes), and new presented-2 T1 was rerun so all 18 share one runner.
- Per run: `final-records.json`, `saved.jsonl` (stored log after reload) and `receipt.sha256`; `ledger.jsonl` and `summary.md` for all 18. No API body, launcher log or key.
