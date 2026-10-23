# EV1 c1 round 3 (live, ungraded)

- Arms:
  - new = apps `99ed91a9b8a42ae75552ad794b80ac0f810b79dd` + ui `893ebce63856d378e0d314ede504cf0899406ab6`. This is the merged integration head, with round-3 changes #181 (quoted relation labels as request-local flow offers) and #182 (catalogue names with という, and continued sentences).
  - old = apps `9b45544bc4a380391dcb8949a4aa3bc144e7e6fb` + ui `756d47e891191c3344eb2d29b000203be8331abc`, unchanged.
- As in round 1: scripts, per-run limits (Jev 208 / 176 / 104, TypeLLM 10), counting and stop rules.
- B uses the sealed stock/2 at `0cbe9b42` (#172).
- Runner: `packages/voice-ui/acceptance/ev-run.mjs` as merged at the same integration head, including #178 (draft-full apply).
- Contents:
  - per run: `final-records.json`, `saved.jsonl` (stored log after reload) and `receipt.sha256`;
  - for all 18 runs: `ledger.jsonl` and `summary.md`.
- Not included: API bodies, launcher logs and keys.
