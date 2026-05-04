const PATCH_MARKER = Symbol.for("compose.connectors.outboundFetchDefaults");
const DEFAULT_USER_AGENT = process.env.COMPOSE_OUTBOUND_USER_AGENT
  || "Compose-Market-Connectors/0.1 (+https://compose.market)";
const DEFAULT_ACCEPT = process.env.COMPOSE_OUTBOUND_ACCEPT
  || "application/json, text/plain, */*";

function inputHeaders(input) {
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers;
  }
  return undefined;
}

function withDefaults(input, init = {}) {
  const headers = new Headers(init.headers || inputHeaders(input));
  if (!headers.has("User-Agent")) headers.set("User-Agent", DEFAULT_USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", DEFAULT_ACCEPT);
  return { ...init, headers };
}

if (!globalThis[PATCH_MARKER] && typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch.bind(globalThis);
  Object.defineProperty(globalThis, PATCH_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  globalThis.fetch = (input, init) => originalFetch(input, withDefaults(input, init));
}
