export type CanonicalConnectorOrigin = "tools" | "onchain";
type ConnectorOriginInput = CanonicalConnectorOrigin | "mcp" | "goat";

export interface ConnectorBindingInput {
    registryId?: string;
    origin?: string;
    slug?: string;
    id?: string;
}

export interface NormalizedConnectorBinding {
    origin: CanonicalConnectorOrigin;
    slug: string;
    registryId: `${CanonicalConnectorOrigin}:${string}`;
    original: string;
}

const ORIGIN_ALIASES: Record<ConnectorOriginInput, CanonicalConnectorOrigin> = {
    tools: "tools",
    mcp: "tools",
    onchain: "onchain",
    goat: "onchain",
};

function canonicalOrigin(value: string | undefined, defaultOrigin: CanonicalConnectorOrigin): CanonicalConnectorOrigin {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "tools" || normalized === "onchain" || normalized === "mcp" || normalized === "goat") {
        return ORIGIN_ALIASES[normalized];
    }
    return defaultOrigin;
}

function splitPrefixed(value: string): { prefix?: ConnectorOriginInput; slug: string } {
    let slug = value.trim();
    let prefix: ConnectorOriginInput | undefined;

    while (true) {
        const match = slug.match(/^(tools|onchain|mcp|goat)([:\-])(.+)$/i);
        if (!match) break;
        prefix = match[1].toLowerCase() as ConnectorOriginInput;
        slug = match[3].trim();
    }

    return { prefix, slug };
}

export function normalizeConnectorBinding(
    input: string | ConnectorBindingInput,
    options: { defaultOrigin?: CanonicalConnectorOrigin } = {},
): NormalizedConnectorBinding {
    const defaultOrigin = options.defaultOrigin ?? "tools";
    const original = typeof input === "string"
        ? input
        : input.registryId || input.slug || input.id || "";
    const explicitOrigin = typeof input === "string" ? undefined : input.origin;
    const { prefix, slug } = splitPrefixed(original);
    const origin = canonicalOrigin(explicitOrigin || prefix, defaultOrigin);

    if (!slug) {
        throw new Error("Connector registryId is required");
    }

    return {
        origin,
        slug,
        registryId: `${origin}:${slug}`,
        original,
    };
}

export function normalizeConnectorRegistryId(
    input: string | ConnectorBindingInput,
    options: { defaultOrigin?: CanonicalConnectorOrigin } = {},
): `${CanonicalConnectorOrigin}:${string}` {
    return normalizeConnectorBinding(input, options).registryId;
}
