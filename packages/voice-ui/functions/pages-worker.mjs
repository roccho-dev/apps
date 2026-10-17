import { onRequestPost } from "./api/judge.mjs";
import { onParts, onRequirements } from "./api/parts.mjs";
import { bindJev, bindTypeLLM, generateTyped, judgeNamedChoices } from "voice-ui-judge-provider";

// App-owned Pages Advanced Mode entry. It is bundled during artifact creation,
// not by the consumer at deployment. Static bytes stay in the ASSETS binding.
export default {
  async fetch(request, env) {
    const url = new URL(request.url), pathname = url.pathname;
    if (["/api/parts/check", "/api/parts/complete", "/api/parts/requirements", "/api/parts/verify"].includes(pathname)) {
      if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
      const mode = pathname.split("/").at(-1);
      const methods = url.searchParams.getAll("method");
      const generations = url.searchParams.getAll("generation");
      const generation = generations.length === 0 ? "dependent" : generations.length === 1 ? generations[0] : "invalid";
      const method = methods.length === 0 ? mode === "complete" ? "literal" : "adaptive-v2"
        : methods.length === 1 ? methods[0] : "invalid";
      if ([...url.searchParams.keys()].some(key => key !== (mode === "requirements" ? "generation" : "method"))
          || mode === "verify" && methods.length
          || mode === "requirements" && !["independent", "dependent"].includes(generation))
        return Response.json({ error: "parts_invalid_method" }, { status: 422 });
      const choice = bindJev({ apiKey: env?.JEV_API_KEY });
      const typed = bindTypeLLM({ apiKey: env?.TYPELLM_API_KEY });
      if (["literal-v2", "adaptive-v2"].includes(method))
        return onRequirements({ request, mode, method, generation, available: mode === "requirements" ? typed.available : choice.available }, {
          judge: (request, { signal }) => judgeNamedChoices({ request, provider: choice, signal }),
          generate: (request, { signal }) => generateTyped({ request, provider: typed, signal }),
        });
      return onParts({ request, mode, method, available: mode === "check" ? choice.available : method === "literal" || typed.available }, {
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
