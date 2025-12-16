/**
 * ElizaOS Framework Runtime
 * 
 * Connects to the ElizaOS server.
 * Provides plugin management, agent creation, and action execution.
 * All plugin info is fetched dynamically from the GitHub registry.
 */

// ElizaOS server configuration - MUST be set in environment
const ELIZA_SERVER_URL = process.env.ELIZA_SERVER_URL;
if (!ELIZA_SERVER_URL) {
  console.error("[eliza] ELIZA_SERVER_URL environment variable is required");
}

const ELIZA_REGISTRY_URL = "https://raw.githubusercontent.com/elizaos-plugins/registry/main/index.json";
const ELIZA_GENERATED_REGISTRY_URL = "https://raw.githubusercontent.com/elizaos-plugins/registry/main/generated-registry.json";

// =============================================================================
// Types - Matching ElizaOS REST API
// =============================================================================

export interface ElizaAgent {
  id: string;
  name: string;
  characterName?: string;
  bio: string | string[];
  status: "active" | "inactive";
  plugins: string[];
  settings?: Record<string, unknown>;
}

export interface ElizaMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface ElizaActionResult {
  success: boolean;
  text?: string;
  data?: unknown;
  error?: string;
}

export interface ElizaPluginEntry {
  id: string;
  package: string;
  source: string;
  description?: string;
  version?: string;
  supports?: { v0: boolean; v1: boolean };
}

export interface ElizaPluginDetail extends ElizaPluginEntry {
  readme?: string;
  actions?: string[];
  providers?: string[];
}

export interface ElizaStatus {
  ready: boolean;
  serverUrl: string;
  agentCount: number;
  pluginCount: number;
  agents: Array<{ id: string; name: string; status: string }>;
}

// =============================================================================
// Registry Cache
// =============================================================================

let pluginRegistryCache: Map<string, ElizaPluginEntry> | null = null;
let generatedRegistryCache: Record<string, {
  description?: string | null;
  npm?: { v0?: string; v1?: string };
  supports?: { v0: boolean; v1: boolean };
}> | null = null;
let registryCacheTime = 0;
const REGISTRY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// =============================================================================
// ElizaOS Server Communication
// =============================================================================

/**
 * Make a request to the ElizaOS server
 */
async function elizaRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  if (!ELIZA_SERVER_URL) {
    throw new Error("ELIZA_SERVER_URL environment variable is not configured");
  }
  
  const url = `${ELIZA_SERVER_URL}${path}`;
  
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElizaOS request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.data ?? data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`ElizaOS request timeout: ${path}`);
    }
    throw error;
  }
}

// =============================================================================
// Health & Status
// =============================================================================

/**
 * Check if ElizaOS server is healthy
 */
export async function checkHealth(): Promise<boolean> {
  try {
    await elizaRequest("/api/agents");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get ElizaOS runtime status
 */
export async function getStatus(): Promise<ElizaStatus> {
  const registry = await fetchPluginRegistry();
  
  if (!ELIZA_SERVER_URL) {
    return {
      ready: false,
      serverUrl: "NOT_CONFIGURED",
      agentCount: 0,
      pluginCount: registry.size,
      agents: [],
    };
  }
  
  try {
    const { agents } = await elizaRequest<{ agents: ElizaAgent[] }>("/api/agents");
    
    return {
      ready: true,
      serverUrl: ELIZA_SERVER_URL,
      agentCount: agents.length,
      pluginCount: registry.size,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
      })),
    };
  } catch (error) {
    return {
      ready: false,
      serverUrl: ELIZA_SERVER_URL,
      agentCount: 0,
      pluginCount: registry.size,
      agents: [],
    };
  }
}

// =============================================================================
// Plugin Registry (Dynamic from GitHub)
// =============================================================================

/**
 * Fetch the generated registry with descriptions and versions
 */
async function fetchGeneratedRegistry(): Promise<typeof generatedRegistryCache> {
  if (generatedRegistryCache && Date.now() - registryCacheTime < REGISTRY_CACHE_TTL) {
    return generatedRegistryCache;
  }

  try {
    const response = await fetch(ELIZA_GENERATED_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.warn("[eliza] Failed to fetch generated registry:", response.status);
      return generatedRegistryCache;
    }

    const data = await response.json();
    generatedRegistryCache = data.registry || data;
    return generatedRegistryCache;
  } catch (error) {
    console.warn("[eliza] Error fetching generated registry:", error);
    return generatedRegistryCache;
  }
}

/**
 * Fetch ElizaOS plugin registry from GitHub
 */
export async function fetchPluginRegistry(): Promise<Map<string, ElizaPluginEntry>> {
  const now = Date.now();

  if (pluginRegistryCache && now - registryCacheTime < REGISTRY_CACHE_TTL) {
    return pluginRegistryCache;
  }

  try {
    console.log("[eliza] Fetching plugin registry from GitHub...");

    const [indexResponse, generatedData] = await Promise.all([
      fetch(ELIZA_REGISTRY_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      }),
      fetchGeneratedRegistry(),
    ]);

    if (!indexResponse.ok) {
      throw new Error(`Failed to fetch registry: ${indexResponse.status}`);
    }

    const registryData: Record<string, string> = await indexResponse.json();
    const plugins = new Map<string, ElizaPluginEntry>();

    for (const [packageName, source] of Object.entries(registryData)) {
      const id = packageName.replace(/^@[^/]+\//, "");
      const genInfo = generatedData?.[packageName];

      plugins.set(id, {
        id,
        package: packageName,
        source,
        description: genInfo?.description || undefined,
        version: genInfo?.npm?.v1 || genInfo?.npm?.v0 || undefined,
        supports: genInfo?.supports,
      });
    }

    pluginRegistryCache = plugins;
    registryCacheTime = now;
    console.log(`[eliza] Loaded ${plugins.size} plugins from registry`);

    return plugins;
  } catch (error) {
    console.error("[eliza] Failed to fetch plugin registry:", error);
    return pluginRegistryCache || new Map();
  }
}

/**
 * List all available plugins
 */
export async function listPlugins(): Promise<ElizaPluginEntry[]> {
  const registry = await fetchPluginRegistry();
  return Array.from(registry.values());
}

/**
 * Get a specific plugin by ID
 */
export async function getPlugin(pluginId: string): Promise<ElizaPluginEntry | null> {
  const registry = await fetchPluginRegistry();
  return registry.get(pluginId) || null;
}

/**
 * Search plugins by query
 */
export async function searchPlugins(query: string): Promise<ElizaPluginEntry[]> {
  const registry = await fetchPluginRegistry();
  const queryLower = query.toLowerCase();

  return Array.from(registry.values()).filter(
    (p) =>
      p.id.toLowerCase().includes(queryLower) ||
      p.package.toLowerCase().includes(queryLower) ||
      p.description?.toLowerCase().includes(queryLower)
  );
}

/**
 * Get plugins by category
 */
export async function getPluginsByCategory(category: string): Promise<ElizaPluginEntry[]> {
  const registry = await fetchPluginRegistry();
  const categoryLower = category.toLowerCase();

  const categoryKeywords: Record<string, string[]> = {
    blockchain: ["evm", "solana", "sui", "ton", "near", "cosmos", "aptos", "starknet", "flow", "icp", "bitcoin", "wallet"],
    defi: ["0x", "goat", "uniswap", "aave", "compound", "lido", "curve", "dex", "swap"],
    social: ["twitter", "discord", "telegram", "farcaster", "lens", "slack"],
    ai: ["openai", "anthropic", "image-generation", "video-generation", "tts", "stt", "local-ai", "llm"],
    utility: ["browser", "pdf", "web-search", "knowledge", "email", "github", "storage"],
  };

  const keywords = categoryKeywords[categoryLower] || [categoryLower];

  return Array.from(registry.values()).filter((plugin) =>
    keywords.some((kw) => plugin.id.toLowerCase().includes(kw))
  );
}

// =============================================================================
// Agent Management
// =============================================================================

/**
 * List all agents
 */
export async function listAgents(): Promise<ElizaAgent[]> {
  const { agents } = await elizaRequest<{ agents: ElizaAgent[] }>("/api/agents");
  return agents;
}

/**
 * Get a specific agent
 */
export async function getAgent(agentId: string): Promise<ElizaAgent> {
  return elizaRequest<ElizaAgent>(`/api/agents/${agentId}`);
}

/**
 * Create a new agent with specified plugins
 */
export async function createAgent(config: {
  name: string;
  bio: string | string[];
  plugins: string[];
  settings?: Record<string, unknown>;
}): Promise<ElizaAgent> {
  return elizaRequest<ElizaAgent>("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      characterPath: "character://custom",
      character: {
        name: config.name,
        bio: config.bio,
        plugins: config.plugins,
        settings: config.settings,
        modelProvider: "openai",
        templates: {},
        messageExamples: [],
        postExamples: [],
        topics: [],
        adjectives: [],
        style: { all: [], chat: [], post: [] },
      },
    }),
  });
}

/**
 * Delete an agent
 */
export async function deleteAgent(agentId: string): Promise<void> {
  await elizaRequest(`/api/agents/${agentId}`, { method: "DELETE" });
}

// =============================================================================
// Message & Action Execution
// =============================================================================

/**
 * Send a message to an agent and get response
 * This is the primary way to interact with ElizaOS agents
 */
export async function sendMessage(
  agentId: string,
  message: string,
  roomId?: string
): Promise<ElizaMessage[]> {
  const response = await elizaRequest<{ messages: ElizaMessage[] }>(
    `/api/agents/${agentId}/message`,
    {
      method: "POST",
      body: JSON.stringify({
        text: message,
        roomId: roomId || `room-${Date.now()}`,
        userId: `user-${Date.now()}`,
      }),
    }
  );
  return response.messages || [];
}

/**
 * Execute a plugin action via natural language message
 * ElizaOS actions are triggered through conversation, not direct API calls
 */
export async function executeAction(
  agentId: string,
  pluginId: string,
  actionName: string,
  params: Record<string, unknown>
): Promise<ElizaActionResult> {
  // Construct a natural language message that triggers the action
  const actionMessage = constructActionMessage(actionName, params);
  
  try {
    const messages = await sendMessage(agentId, actionMessage);
    const response = messages.find((m) => m.role === "assistant");

    return {
      success: true,
      text: response?.content || "Action executed",
      data: { messages, params },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Construct a natural language message to trigger an action
 */
function constructActionMessage(
  actionName: string,
  params: Record<string, unknown>
): string {
  // Common action patterns
  const actionPatterns: Record<string, (p: Record<string, unknown>) => string> = {
    TRANSFER: (p) => `Transfer ${p.amount} ${p.token || "tokens"} to ${p.to}${p.chain ? ` on ${p.chain}` : ""}`,
    SEND: (p) => `Send ${p.amount} to ${p.to}`,
    SWAP: (p) => `Swap ${p.amount} ${p.fromToken} for ${p.toToken}`,
    GET_BALANCE: (p) => `What is the balance of ${p.address || "my wallet"}${p.token ? ` for ${p.token}` : ""}?`,
    WEB_SEARCH: (p) => `Search the web for: ${p.query}`,
    GENERATE_IMAGE: (p) => `Generate an image: ${p.prompt}`,
    POST_TWEET: (p) => `Post a tweet: ${p.content}`,
    SEARCH_TWEETS: (p) => `Search Twitter for: ${p.query}`,
  };

  const pattern = actionPatterns[actionName.toUpperCase()];
  if (pattern) {
    return pattern(params);
  }

  // Generic pattern for unknown actions
  const paramString = Object.entries(params)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return `Execute ${actionName}${paramString ? ` with ${paramString}` : ""}`;
}

// =============================================================================
// Plugin Testing - Create temporary agents for testing
// =============================================================================

let testAgentCache: Map<string, string> = new Map();

/**
 * Get or create a test agent for a specific plugin
 */
export async function getTestAgent(pluginId: string): Promise<string> {
  // Check cache first
  const cached = testAgentCache.get(pluginId);
  if (cached) {
    // Verify agent still exists
    try {
      await getAgent(cached);
      return cached;
    } catch {
      testAgentCache.delete(pluginId);
    }
  }

  // Look for existing test agent
  const agents = await listAgents();
  const existing = agents.find(
    (a) => a.name === `test-${pluginId}` && a.plugins.includes(`@elizaos/${pluginId}`)
  );
  if (existing) {
    testAgentCache.set(pluginId, existing.id);
    return existing.id;
  }

  // Create new test agent
  const plugin = await getPlugin(pluginId);
  if (!plugin) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }

  const agent = await createAgent({
    name: `test-${pluginId}`,
    bio: `Test agent for ${plugin.package}. ${plugin.description || ""}`,
    plugins: [plugin.package, "@elizaos/plugin-bootstrap"],
  });

  testAgentCache.set(pluginId, agent.id);
  return agent.id;
}

/**
 * Test a plugin action
 */
export async function testPluginAction(
  pluginId: string,
  actionName: string,
  params: Record<string, unknown>
): Promise<ElizaActionResult> {
  const agentId = await getTestAgent(pluginId);
  return executeAction(agentId, pluginId, actionName, params);
}

// =============================================================================
// Initialize - Prefetch registry
// =============================================================================

fetchPluginRegistry()
  .then((registry) => {
    console.log(`[eliza] Initialized with ${registry.size} plugins`);
  })
  .catch(console.error);

