import { onRequestPost } from "./api/jev.mjs";

// App-owned Pages Advanced Mode entry. It is bundled during artifact creation,
// not by the consumer at deployment. Static bytes stay in the ASSETS binding.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/jev") {
      if (request.method !== "POST") {
        return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
      }
      return onRequestPost({ request, env });
    }
    return env.ASSETS.fetch(request);
  },
};
