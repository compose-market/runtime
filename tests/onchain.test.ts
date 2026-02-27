import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAgentOnchain, fetchManowarOnchain, buildManowarWorkflow } from "../src/onchain.js";
import { getPublicClient, CHAIN_IDS } from "../src/chains.js";
import { hasAgent, registerAgent } from "../src/frameworks/runtime.js";

// Mock chains.ts
vi.mock("../src/chains.js", () => ({
    getPublicClient: vi.fn(),
    CHAIN_IDS: {
        avalancheFuji: 43113,
        cronosTestnet: 338,
    },
}));

// Mock runtime.js
vi.mock("../src/frameworks/runtime.js", () => ({
    hasAgent: vi.fn().mockReturnValue(false),
    registerAgent: vi.fn().mockResolvedValue({}),
}));

describe("On-chain Logic (Multichain Verification)", () => {
    const mockClient = {
        readContract: vi.fn(),
    };
    const mockFetch = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        (getPublicClient as any).mockReturnValue(mockClient);
        (hasAgent as any).mockReturnValue(false);
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("should fetch agent data with mandatory chainId", async () => {
        const chainId = CHAIN_IDS.avalancheFuji;
        const agentId = 1;

        mockClient.readContract.mockResolvedValueOnce([
            "0xdna",
            BigInt(0),
            BigInt(0),
            BigInt(0),
            "0x0000000000000000000000000000000000000000",
            false,
            false,
            BigInt(0),
            "ipfs://agent",
        ]);

        const result = await fetchAgentOnchain(chainId, agentId);

        expect(getPublicClient).toHaveBeenCalledWith(chainId);
        expect(mockClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
            abi: expect.any(Array),
            functionName: "getAgentData",
            args: [BigInt(agentId)],
        }));
        expect(result).toEqual({
            id: agentId,
            dnaHash: "0xdna",
            agentCardUri: "ipfs://agent",
        });
    });

    it("should fetch manowar data with mandatory chainId", async () => {
        const chainId = CHAIN_IDS.cronosTestnet;
        const manowarId = 10;

        mockClient.readContract.mockImplementation(async (args: { functionName: string; args?: bigint[] }) => {
            if (args.functionName === "getManowarData") {
                return [
                    "Test Manowar",
                    "Desc",
                    "banner.png",
                    "ipfs://QmManowarCardCid11111111111111111111111111111",
                    BigInt(0),
                    BigInt(0),
                    BigInt(0),
                    "0x0000000000000000000000000000000000000000",
                    false,
                    BigInt(0),
                    0,
                    true,
                    "gpt-4",
                    false,
                    BigInt(0),
                ];
            }
            if (args.functionName === "tokenURI") {
                return "ipfs://QmManowarMetaCid11111111111111111111111111111";
            }
            if (args.functionName === "getAgents") {
                return [BigInt(1), BigInt(2)];
            }
            if (args.functionName === "getAgentData" && args.args?.[0] === BigInt(1)) {
                return [
                    "0xdna1",
                    BigInt(0),
                    BigInt(0),
                    BigInt(0),
                    "0x0000000000000000000000000000000000000000",
                    false,
                    false,
                    BigInt(0),
                    "ipfs://QmAgentOneMetaCid111111111111111111111111111111",
                ];
            }
            if (args.functionName === "getAgentData" && args.args?.[0] === BigInt(2)) {
                return [
                    "0xdna2",
                    BigInt(0),
                    BigInt(0),
                    BigInt(0),
                    "0x0000000000000000000000000000000000000000",
                    false,
                    false,
                    BigInt(0),
                    "ipfs://QmAgentTwoMetaCid111111111111111111111111111111",
                ];
            }
            throw new Error(`Unexpected readContract call: ${args.functionName}`);
        });

        mockFetch.mockImplementation(async (url: string) => {
            if (url.includes("/ipfs/QmManowarMetaCid11111111111111111111111111111")) {
                return {
                    ok: true,
                    json: async () => ({
                        walletAddress: "0x9999999999999999999999999999999999999999",
                        dnaHash: "0xdna-manowar",
                    }),
                };
            }
            if (url.includes("/ipfs/QmAgentOneMetaCid111111111111111111111111111111")) {
                return {
                    ok: true,
                    json: async () => ({
                        walletAddress: "0x1000000000000000000000000000000000000001",
                    }),
                };
            }
            if (url.includes("/ipfs/QmAgentTwoMetaCid111111111111111111111111111111")) {
                return {
                    ok: true,
                    json: async () => ({
                        walletAddress: "0x1000000000000000000000000000000000000002",
                    }),
                };
            }
            return { ok: false, json: async () => ({}) };
        });

        const result = await fetchManowarOnchain(chainId, manowarId);

        expect(getPublicClient).toHaveBeenCalledWith(chainId);
        expect(mockClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
            abi: expect.any(Array),
            functionName: "getManowarData",
            args: [BigInt(manowarId)],
        }));
        expect(result?.title).toBe("Test Manowar");
        expect(result?.walletAddress).toBe("0x9999999999999999999999999999999999999999");
        expect(result?.agentWalletAddresses).toEqual([
            "0x1000000000000000000000000000000000000001",
            "0x1000000000000000000000000000000000000002",
        ]);
    });

    it("should build workflow across different chains", async () => {
        const chainId = CHAIN_IDS.avalancheFuji;
        const manowarId = 1;

        mockClient.readContract.mockImplementation(async (args: { functionName: string; args?: bigint[] }) => {
            if (args.functionName === "getManowarData") {
                return [
                    "Multi-Agent Manowar",
                    "A complex workflow",
                    "banner.png",
                    "ipfs://QmManowarCardCid22222222222222222222222222222",
                    BigInt(0),
                    BigInt(0),
                    BigInt(0),
                    "0x0000000000000000000000000000000000000000",
                    false,
                    BigInt(0),
                    0,
                    true,
                    "gpt-4",
                    false,
                    BigInt(0),
                ];
            }
            if (args.functionName === "tokenURI") {
                return "ipfs://QmManowarMetaCid22222222222222222222222222222";
            }
            if (args.functionName === "getAgents") {
                return [BigInt(1), BigInt(2)];
            }
            if (args.functionName === "getAgentData" && args.args?.[0] === BigInt(1)) {
                return [
                    "0xdna1",
                    BigInt(0),
                    BigInt(0),
                    BigInt(0),
                    "0x0000000000000000000000000000000000000000",
                    false,
                    false,
                    BigInt(0),
                    "ipfs://QmAgentOneMetaCid222222222222222222222222222222",
                ];
            }
            if (args.functionName === "getAgentData" && args.args?.[0] === BigInt(2)) {
                return [
                    "0xdna2",
                    BigInt(0),
                    BigInt(0),
                    BigInt(0),
                    "0x0000000000000000000000000000000000000000",
                    false,
                    false,
                    BigInt(0),
                    "ipfs://QmAgentTwoMetaCid222222222222222222222222222222",
                ];
            }
            throw new Error(`Unexpected readContract call: ${args.functionName}`);
        });

        mockFetch.mockImplementation(async (url: string) => {
            if (url.includes("/ipfs/QmManowarMetaCid22222222222222222222222222222")) {
                return {
                    ok: true,
                    json: async () => ({
                        walletAddress: "0x9999999999999999999999999999999999999999",
                        dnaHash: "0xdna-manowar",
                    }),
                };
            }
            if (url.includes("/ipfs/QmAgentOneMetaCid222222222222222222222222222222")) {
                return {
                    ok: true,
                    json: async () => ({
                        walletAddress: "0x1000000000000000000000000000000000000001",
                        name: "Agent One",
                        description: "First agent",
                        model: "gpt-4o",
                        skills: ["analysis"],
                        plugins: [],
                    }),
                };
            }
            if (url.includes("/ipfs/QmAgentTwoMetaCid222222222222222222222222222222")) {
                return {
                    ok: true,
                    json: async () => ({
                        walletAddress: "0x1000000000000000000000000000000000000002",
                        name: "Agent Two",
                        description: "Second agent",
                        model: "gpt-4o-mini",
                        skills: ["synthesis"],
                        plugins: [],
                    }),
                };
            }
            return { ok: false, json: async () => ({}) };
        });

        const workflow = await buildManowarWorkflow(chainId, manowarId);

        expect(getPublicClient).toHaveBeenCalledWith(chainId);
        expect(workflow?.steps.length).toBe(2);
        expect(workflow?.steps[0].id).toBe("agent-1");
        expect(workflow?.steps[1].id).toBe("agent-2");
        expect(registerAgent).toHaveBeenCalledTimes(2);
    });
});
