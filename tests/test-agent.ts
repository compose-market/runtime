/**
 * Test Agent Script
 * 
 * Tests the full agent lifecycle:
 * 1. Registers an agent with 3 plugins (CoinGecko + ERC20 + Uniswap)
 * 2. Executes autonomous chat with x402 payments
 * 3. Verifies tool calling works end-to-end
 * 
 * Usage:
 *   npx tsx test-agent.ts
 * 
 * Prerequisites:
 *   - MCP server running at localhost:4003 (or MCP_URL env var)
 *   - SERVER_PRIVATE_KEY set with USDC balance on Avalanche Fuji
 *   - THIRDWEB_SECRET_KEY set for x402 authentication
 */
import "dotenv/config";
import { createThirdwebClient } from "thirdweb";
import { privateKeyToAccount } from "thirdweb/wallets";
import { wrapFetchWithPayment } from "thirdweb/x402";
import { avalancheFuji } from "thirdweb/chains";
import { keccak256, encodePacked } from "viem";

// =============================================================================
// Configuration
// =============================================================================

const MCP_URL = process.env.MCP_URL || "http://localhost:4003";
const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY;
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as `0x${string}` | undefined;

// Agent configuration
const TEST_AGENT_NAME = "Test Agent Alpha";
const TEST_AGENT_DESCRIPTION = "A test agent with CoinGecko, ERC20, and Uniswap plugins for autonomous testing.";
const TEST_PLUGINS = ["coingecko", "erc20", "uniswap"];
const TEST_MODEL = "asi1-mini";

// Test queries to verify tool calling
const TEST_QUERIES = [
  "What is the current price of Bitcoin and Ethereum?",
  "What is my AVAX balance?",
  "Tell me about the Uniswap protocol.",
];

// Max payment per call (0.005 USDC = 5000 wei)
const MAX_PAYMENT_WEI = BigInt(5000);

// =============================================================================
// Utilities
// =============================================================================

function computeDnaHash(skills: string[], chainId: number, model: string): `0x${string}` {
  const sortedSkills = [...skills].sort();
  const skillsStr = sortedSkills.join(",");
  return keccak256(
    encodePacked(
      ["string", "uint256", "string"],
      [skillsStr, BigInt(chainId), model]
    )
  );
}

function generateTestAgentId(): bigint {
  // Generate a pseudo-random agent ID for testing (not actually on-chain)
  return BigInt(Date.now());
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Payment Setup
// =============================================================================

function createPaymentFetch() {
  if (!THIRDWEB_SECRET_KEY || !SERVER_PRIVATE_KEY) {
    console.warn("⚠️  Payment not configured - tests will fail for x402 endpoints");
    return fetch;
  }

  const client = createThirdwebClient({
    secretKey: THIRDWEB_SECRET_KEY,
  });

  const account = privateKeyToAccount({
    client,
    privateKey: SERVER_PRIVATE_KEY,
  });

  const wallet = {
    getAccount: () => account,
    getChain: () => avalancheFuji,
  };

  console.log(`💳 Payment wallet: ${account.address}`);
  console.log(`💰 Max payment per call: ${MAX_PAYMENT_WEI} wei (${Number(MAX_PAYMENT_WEI) / 1_000_000} USDC)`);

  return wrapFetchWithPayment(
    fetch,
    client,
    wallet,
    { maxValue: MAX_PAYMENT_WEI }
  );
}

// =============================================================================
// Test Functions
// =============================================================================

async function testHealthCheck(): Promise<boolean> {
  console.log("\n📋 Testing MCP Server Health...");

  try {
    const response = await fetch(`${MCP_URL}/health`);
    const data = await response.json();

    console.log(`   Status: ${data.status}`);
    console.log(`   Spawnable servers: ${data.spawnableServers}`);
    console.log(`   Remote servers: ${data.remoteServers}`);

    return data.status === "ok";
  } catch (error) {
    console.error(`   ❌ Health check failed:`, error);
    return false;
  }
}

async function testGoatPlugins(): Promise<boolean> {
  console.log("\n🐐 Testing GOAT Plugin Status...");

  try {
    const response = await fetch(`${MCP_URL}/goat/status`);
    const data = await response.json();

    console.log(`   Initialized: ${data.initialized}`);
    console.log(`   Total tools: ${data.totalTools}`);
    console.log(`   Plugins: ${data.plugins?.length || 0}`);

    if (data.plugins) {
      for (const plugin of data.plugins.slice(0, 5)) {
        console.log(`     - ${plugin.id}: ${plugin.toolCount} tools`);
      }
    }

    return data.initialized;
  } catch (error) {
    console.error(`   ❌ GOAT status check failed:`, error);
    return false;
  }
}

async function testRegisterAgent(): Promise<{ agentId: string; walletAddress: string } | null> {
  console.log("\n🤖 Registering Test Agent...");

  const agentId = generateTestAgentId();
  const dnaHash = computeDnaHash(TEST_PLUGINS, 43113, TEST_MODEL);

  console.log(`   Agent ID: ${agentId}`);
  console.log(`   DNA Hash: ${dnaHash}`);
  console.log(`   Plugins: ${TEST_PLUGINS.join(", ")}`);

  try {
    const response = await fetch(`${MCP_URL}/agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: agentId.toString(),
        dnaHash,
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESCRIPTION,
        agentCardUri: "ipfs://test-agent-card",
        creator: "0x0000000000000000000000000000000000000000",
        model: TEST_MODEL,
        plugins: TEST_PLUGINS,
        systemPrompt: `You are ${TEST_AGENT_NAME}. ${TEST_AGENT_DESCRIPTION}`,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`   ❌ Registration failed: ${error}`);
      return null;
    }

    const data = await response.json();
    console.log(`   ✅ Registered successfully`);
    console.log(`   Wallet: ${data.agent?.walletAddress}`);
    console.log(`   API: ${data.agent?.apiUrl}`);

    return {
      agentId: agentId.toString(),
      walletAddress: data.agent?.walletAddress,
    };
  } catch (error) {
    console.error(`   ❌ Registration error:`, error);
    return null;
  }
}

async function testAgentChat(
  agentId: string,
  paymentFetch: typeof fetch
): Promise<boolean> {
  console.log("\n💬 Testing Agent Chat with x402 Payment...");

  let allPassed = true;

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const query = TEST_QUERIES[i];
    console.log(`\n   Query ${i + 1}/${TEST_QUERIES.length}: "${query.slice(0, 50)}..."`);

    try {
      const response = await paymentFetch(`${MCP_URL}/agent/${agentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: query,
          threadId: `test-${Date.now()}`,
        }),
      });

      if (response.status === 402) {
        console.log(`   ⚠️  Payment required (402) - checking PAYMENT-SIGNATURE header was sent`);
        const headers = Object.fromEntries(response.headers.entries());
        console.log(`   Response headers:`, JSON.stringify(headers, null, 2));
        allPassed = false;
        continue;
      }

      if (!response.ok) {
        const error = await response.text();
        console.log(`   ❌ Request failed (${response.status}): ${error}`);
        allPassed = false;
        continue;
      }

      const data = await response.json();

      if (data.success) {
        console.log(`   ✅ Response received`);
        console.log(`   Output: ${data.output?.slice(0, 100)}...`);

        if (data.toolCalls && data.toolCalls.length > 0) {
          console.log(`   🔧 Tool calls made: ${data.toolCalls.length}`);
          for (const tc of data.toolCalls) {
            console.log(`      - ${tc.tool}: ${JSON.stringify(tc.args).slice(0, 50)}...`);
          }
        }
      } else {
        console.log(`   ⚠️  Response not successful: ${data.error}`);
        allPassed = false;
      }
    } catch (error) {
      console.error(`   ❌ Chat error:`, error);
      allPassed = false;
    }

    // Small delay between queries
    if (i < TEST_QUERIES.length - 1) {
      await sleep(2000);
    }
  }

  return allPassed;
}

async function testGoatToolExecution(paymentFetch: typeof fetch): Promise<boolean> {
  console.log("\n🔧 Testing Direct GOAT Tool Execution...");

  try {
    // Test CoinGecko price lookup
    console.log("\n   Testing coingecko/get_coin_prices...");
    const priceResponse = await paymentFetch(`${MCP_URL}/goat/coingecko/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "coingecko_get_coin_prices",
        args: {
          coinIds: ["bitcoin", "ethereum", "avalanche-2"],
          vsCurrency: "usd",
        },
      }),
    });

    if (priceResponse.status === 402) {
      console.log(`   ⚠️  Payment required - wallet may need USDC funding`);
      return false;
    }

    if (!priceResponse.ok) {
      const error = await priceResponse.text();
      console.log(`   ❌ Price lookup failed: ${error}`);
      return false;
    }

    const priceData = await priceResponse.json();
    if (priceData.success) {
      console.log(`   ✅ CoinGecko price lookup successful`);
      console.log(`   Result:`, JSON.stringify(priceData.result, null, 2).slice(0, 200));
    } else {
      console.log(`   ⚠️  Tool returned error: ${priceData.error}`);
    }

    return priceData.success;
  } catch (error) {
    console.error(`   ❌ GOAT execution error:`, error);
    return false;
  }
}

async function testLangChainStatus(): Promise<boolean> {
  console.log("\n🦜 Testing LangChain Framework Status...");

  try {
    const response = await fetch(`${MCP_URL}/langchain/status`);
    const data = await response.json();

    console.log(`   Ready: ${data.ready}`);
    console.log(`   Framework: ${data.framework}`);
    console.log(`   Memory enabled: ${data.memoryEnabled}`);
    console.log(`   RAG enabled: ${data.ragEnabled}`);
    console.log(`   Model provider: ${data.modelProvider}`);
    console.log(`   Active agents: ${data.agentCount}`);

    return data.ready;
  } catch (error) {
    console.error(`   ❌ LangChain status check failed:`, error);
    return false;
  }
}

// =============================================================================
// Main Test Runner
// =============================================================================

async function runTests() {
  console.log("═".repeat(60));
  console.log("  COMPOSE MARKET - AUTONOMOUS AGENT TEST SUITE");
  console.log("═".repeat(60));
  console.log(`\n📍 MCP Server: ${MCP_URL}`);
  console.log(`🔑 Thirdweb Secret: ${THIRDWEB_SECRET_KEY ? "✓ Set" : "✗ Missing"}`);
  console.log(`🔑 Server Private Key: ${SERVER_PRIVATE_KEY ? "✓ Set" : "✗ Missing"}`);

  const results: { name: string; passed: boolean }[] = [];

  // Create payment-wrapped fetch
  const paymentFetch = createPaymentFetch();

  // Test 1: Health Check
  const healthOk = await testHealthCheck();
  results.push({ name: "MCP Server Health", passed: healthOk });

  if (!healthOk) {
    console.log("\n❌ MCP Server not healthy - aborting tests");
    return;
  }

  // Test 2: LangChain Status
  const langchainOk = await testLangChainStatus();
  results.push({ name: "LangChain Framework", passed: langchainOk });

  // Test 3: GOAT Plugins
  const goatOk = await testGoatPlugins();
  results.push({ name: "GOAT Plugins", passed: goatOk });

  // Test 4: GOAT Tool Execution (with payment)
  if (SERVER_PRIVATE_KEY && THIRDWEB_SECRET_KEY) {
    const toolOk = await testGoatToolExecution(paymentFetch);
    results.push({ name: "GOAT Tool Execution (x402)", passed: toolOk });
  } else {
    console.log("\n⚠️  Skipping GOAT execution test - payment not configured");
    results.push({ name: "GOAT Tool Execution (x402)", passed: false });
  }

  // Test 5: Register Agent
  const agent = await testRegisterAgent();
  results.push({ name: "Agent Registration", passed: !!agent });

  // Test 6: Agent Chat (with payment)
  if (agent && SERVER_PRIVATE_KEY && THIRDWEB_SECRET_KEY) {
    const chatOk = await testAgentChat(agent.agentId, paymentFetch);
    results.push({ name: "Agent Chat (x402)", passed: chatOk });
  } else {
    console.log("\n⚠️  Skipping agent chat test - agent not registered or payment not configured");
    results.push({ name: "Agent Chat (x402)", passed: false });
  }

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("  TEST RESULTS SUMMARY");
  console.log("═".repeat(60));

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const status = result.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`  ${status}  ${result.name}`);
    if (result.passed) passed++;
    else failed++;
  }

  console.log("\n" + "─".repeat(60));
  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log("═".repeat(60) + "\n");

  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(console.error);

