import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchAgentOnchain, fetchManowarOnchain, buildManowarWorkflow } from "../src/onchain.js";
import { getPublicClient, CHAIN_IDS } from "../src/chains.js";

// Mock chains.ts
vi.mock("../../chains.js", () => ({
    getPublicClient: vi.fn(),
    CHAIN_IDS: {
        avalancheFuji: 43113,
        cronosTestnet: 338,
    },
}));

// Mock runtime.js
vi.mock("../../frameworks/runtime.js", () => ({
    hasAgent: vi.fn().mockReturnValue(false),
    registerAgent: vi.fn().mockResolvedValue({}),
}));

describe("On-chain Logic (Multichain Verification)", () => {
    const mockClient = {
        readContract: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        (getPublicClient as any).mockReturnValue(mockClient);
    });

    it("should fetch agent data with mandatory chainId", async () => {
        const chainId = CHAIN_IDS.avalancheFuji;
        const agentId = 1;

        mockClient.readContract.mockResolvedValueOnce({
            dnaHash: "0xdna",
            agentCardUri: "ipfs://agent",
        });

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

        mockClient.readContract.mockResolvedValueOnce({
            title: "Test Manowar",
            description: "Desc",
            banner: "banner.png",
            manowarCardUri: "ipfs://manowar",
            hasCoordinator: true,
            coordinatorModel: "gpt-4",
        });

        const result = await fetchManowarOnchain(chainId, manowarId);

        expect(getPublicClient).toHaveBeenCalledWith(chainId);
        expect(mockClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
            abi: expect.any(Array),
            functionName: "getManowarData",
            args: [BigInt(manowarId)],
        }));
        expect(result?.title).toBe("Test Manowar");
    });

    it("should build workflow across different chains", async () => {
        const chainId = CHAIN_IDS.avalancheFuji;
        const manowarId = 1;

        // Mock Manowar Data
        mockClient.readContract.mockResolvedValueOnce({
            title: "Multi-Agent Manowar",
            description: "A complex workflow",
            banner: "banner.png",
            manowarCardUri: "ipfs://manowar",
            hasCoordinator: true,
            coordinatorModel: "gpt-4",
        });

        // Mock Agent IDs
        mockClient.readContract.mockResolvedValueOnce([BigInt(1), BigInt(2)]);

        // Mock Agent 1 Data
        mockClient.readContract.mockResolvedValueOnce({
            dnaHash: "0xdna1",
            agentCardUri: "ipfs://agent1",
        });

        // Mock Agent 2 Data
        mockClient.readContract.mockResolvedValueOnce({
            dnaHash: "0xdna2",
            agentCardUri: "ipfs://agent2",
        });

        const workflow = await buildManowarWorkflow(chainId, manowarId);

        expect(getPublicClient).toHaveBeenCalledWith(chainId);
        expect(workflow?.steps.length).toBe(2);
        expect(workflow?.steps[0].id).toBe("agent-1");
        expect(workflow?.steps[1].id).toBe("agent-2");
    });
});
