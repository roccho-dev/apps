import { onRequestPost } from "./api/judge.mjs";
import { onParts } from "./api/parts.mjs";
import { bindJev, bindTypeLLM, generateTyped, judgeNamedChoices } from "voice-ui-judge-provider";

// App-owned Pages Advanced Mode entry. It is bundled during artifact creation,
// not by the consumer at deployment. Static bytes stay in the ASSETS binding.
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (["/api/parts/check", "/api/parts/complete"].includes(pathname)) {
      if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
      const mode = pathname.endsWith("/check") ? "check" : "complete";
      const choice = bindJev({ apiKey: env?.JEV_API_KEY });
      const typed = bindTypeLLM({ apiKey: env?.TYPELLM_API_KEY });
      return onParts({ request, mode, available: mode === "check" ? choice.available : typed.available }, {
        judge: (request, { signal }) => judgeNamedChoices({ request, provider: choice, signal }),
        generate: (request, { signal }) => generateTyped({ request, provider: typed, signal }),
      });
    }
    if (new URL(request.url).pathname === "/api/judge") {
      if (request.method !== "POST") {
        return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
      }
      // Credentials bind only at this request composition, never in app operations.
      const provider = bindJev({ apiKey: env?.JEV_API_KEY });
      const judge = (request, { signal }) => judgeNamedChoices({ request, provider, signal });
      return onRequestPost({ request, available: provider.available, architecture: env?.ARCHITECTURE }, judge);
    }
    return env.ASSETS.fetch(request);
  },
};
