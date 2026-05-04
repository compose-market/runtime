const PATCH_MARKER = Symbol.for("compose.connectors.outboundFetchDefaults");

export const DEFAULT_OUTBOUND_USER_AGENT = "Compose-Market-Connectors/0.1 (+https://compose.market)";
export const DEFAULT_OUTBOUND_ACCEPT = "application/json, text/plain, */*";

function inputHeaders(input: RequestInfo | URL): HeadersInit | undefined {
    if (typeof Request !== "undefined" && input instanceof Request) {
        return input.headers;
    }
    return undefined;
}

export function withOutboundFetchDefaults(input: RequestInfo | URL, init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers ?? inputHeaders(input));
    if (!headers.has("User-Agent")) {
        headers.set("User-Agent", DEFAULT_OUTBOUND_USER_AGENT);
    }
    if (!headers.has("Accept")) {
        headers.set("Accept", DEFAULT_OUTBOUND_ACCEPT);
    }
    return { ...init, headers };
}

export function applyOutboundFetchDefaults(scope: typeof globalThis = globalThis): void {
    const target = scope as typeof globalThis & { [PATCH_MARKER]?: boolean };
    if (target[PATCH_MARKER]) return;
    const originalFetch = target.fetch;
    if (typeof originalFetch !== "function") return;

    Object.defineProperty(target, PATCH_MARKER, {
        value: true,
        enumerable: false,
        configurable: false,
    });

    target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        return originalFetch.call(target, input, withOutboundFetchDefaults(input, init));
    }) as typeof fetch;
}
