import { onRequestPost } from "./api/judge.mjs";
import { bindJev, judgeNamedChoices } from "voice-ui-judge-provider";

// App-owned Pages Advanced Mode entry. It is bundled during artifact creation,
// not by the consumer at deployment. Static bytes stay in the ASSETS binding.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/judge") {
      if (request.method !== "POST") {
        return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
      }
      // Credentials bind only at this request composition, never in app operations.
      const provider = bindJev({ apiKey: env?.JEV_API_KEY });
      const judge = (request, { signal }) => judgeNamedChoices({ request, provider, signal });
      return onRequestPost({ request, available: provider.available }, judge);
    }
    return env.ASSETS.fetch(request);
  },
};
