// Browser HTTP binding only. Domain validation is shared by the page and its handlers.
export const createCompletion = ({ fetchImpl = globalThis.fetch } = {}) => {
  const post = async (mode, request) => {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("parts-timeout")); }, 40000);
    });
    const call = (async () => {
      const response = await fetchImpl("/api/parts/" + mode, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(request), signal: controller.signal });
      if (!response.ok) throw new Error("parts-http");
      return response.json();
    })();
    try { return await Promise.race([call, deadline]); }
    finally { clearTimeout(timer); }
  };
  return Object.freeze({ check: request => post("check", request), complete: request => post("complete", request) });
};
