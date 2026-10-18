import { bindReference } from "./read.mjs";

// The existing host fixes this opaque operator-owned value for its whole
// lifetime. One session never follows a mutable source or hot-rebinds it.
const locator = process.env.VOICE_UI_PROPOSAL_B;
const git = process.env.VOICE_UI_REFERENCE_GIT;
let bound;
export function propose() {
  bound ??= bindReference(locator, { git });
  return bound.propose();
}
