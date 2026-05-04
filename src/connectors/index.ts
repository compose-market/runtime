/**
 * Connectors — runtime-side public surface.
 */

export {
    getServerTools,
    executeServerTool,
    inspectServer,
    getRuntimeStatus,
    peekRuntimeStatus,
    listPlugins,
    getPlugin,
    getPluginTools,
    listAllTools,
    getTool,
    hasTool,
    executeGoatTool,
    getWalletAddress,
    getPluginIds,
} from "./client.js";

export {
    ConnectorsError,
} from "./types.js";

export {
    normalizeConnectorBinding,
    normalizeConnectorRegistryId,
} from "./bindings.js";

export type {
    CanonicalConnectorOrigin,
    ConnectorBindingInput,
    NormalizedConnectorBinding,
} from "./bindings.js";

export type {
    ConnectorsErrorCode,
    ServerSpawnConfig,
    ConnectorsToolDescriptor,
    ConnectorsToolListing,
    ConnectorsIdentity,
    ConnectorsEnvProvided,
    InspectResult,
    InspectSuccess,
    InspectFailure,
    InspectCandidateError,
    PluginInfo,
    RuntimeStatus,
    ToolSchema,
    ToolExecutionResult,
    CallRequest,
    CallResponse,
    CallSuccess,
    CallCredentialsRequired,
    CallTypedFailure,
    CatalogServerRow,
    CatalogTransportRow,
    CatalogToolRow,
    CatalogCredentialRow,
    CatalogHealthRow,
    ConnectorOrigin,
} from "./types.js";
