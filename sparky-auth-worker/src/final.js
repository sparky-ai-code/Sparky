import app from "./entry.js";

const SPARKY_FRAME_ANCESTORS = "frame-ancestors sparky://app sparky-dev://app";

function restrictClerkFrameAncestors(response) {
  const headers = new Headers(response.headers);
  const current = headers.get("content-security-policy") || "";
  const next = /(?:^|;)\s*frame-ancestors\s+[^;]*/iu.test(current)
    ? current.replace(/(?:^|;)\s*frame-ancestors\s+[^;]*/iu, `; ${SPARKY_FRAME_ANCESTORS}`)
    : `${current}${current.trim() ? "; " : ""}${SPARKY_FRAME_ANCESTORS}`;
  headers.set("Content-Security-Policy", next.replace(/^;\s*/u, ""));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const response = await app.fetch(request, env);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/clerk/desktop") {
      return restrictClerkFrameAncestors(response);
    }
    return response;
  },
};

export { restrictClerkFrameAncestors };
