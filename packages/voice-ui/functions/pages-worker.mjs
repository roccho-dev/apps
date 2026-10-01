import { onRequestPost } from "./api/judge.mjs";
import { judgeNamedChoices } from "voice-ui-judge-provider";

// The sole artifact call-shape binding; app meaning stays in judgment/API.
const judge = (request, { key, signal }) => judgeNamedChoices({ request, apiKey: key, signal });

// App-owned Pages Advanced Mode entry. It is bundled during artifact creation,
// not by the consumer at deployment. Static bytes stay in the ASSETS binding.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/judge") {
      if (request.method !== "POST") {
        return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
      }
      return onRequestPost({ request, key: env?.JEV_API_KEY }, judge);
    }
    return env.ASSETS.fetch(request);
  },
};
