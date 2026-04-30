import "dotenv/config";
import { createPublicClient, http } from "viem";
import { avalancheFuji } from "viem/chains";

const FACTORY = (process.env.AGENT_FACTORY_CONTRACT || "").trim() as `0x${string}`;
const FUJI_RPC = (process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc").trim();
const ABI = [
  { name: "totalAgents", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "total", type: "uint256" }] },
  { name: "getAgentData", type: "function", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "data", type: "tuple", components: [
    { name: "dnaHash", type: "bytes32" },
    { name: "licenses", type: "uint256" },
    { name: "licensesMinted", type: "uint256" },
    { name: "licensePrice", type: "uint256" },
    { name: "creator", type: "address" },
    { name: "cloneable", type: "bool" },
    { name: "isClone", type: "bool" },
    { name: "parentAgentId", type: "uint256" },
    { name: "agentCardUri", type: "string" },
  ] }] },
] as const;

function pinata(cid: string): string {
  const raw = (process.env.PINATA_GATEWAY_URL || "https://gateway.pinata.cloud").trim();
  const stripped = raw.replace(/\/+$/, "").replace(/\/ipfs$/, "");
  const withScheme = /^https?:\/\//i.test(stripped) ? stripped : `https://${stripped}`;
  return `${withScheme}/ipfs/${cid}`;
}

async function main() {
  const client = createPublicClient({ chain: avalancheFuji, transport: http(FUJI_RPC) });
  const total = await client.readContract({ address: FACTORY, abi: ABI, functionName: "totalAgents" }) as bigint;
  for (let i = 1; i <= Number(total); i++) {
    const d = await client.readContract({ address: FACTORY, abi: ABI, functionName: "getAgentData", args: [BigInt(i)] }) as { agentCardUri: string; creator: string };
    const cid = d.agentCardUri.replace(/^ipfs:\/\//, "").replace(/^\/+/, "").split("/")[0];
    let card: any = null;
    try {
      const r = await fetch(pinata(cid));
      if (r.ok) card = await r.json();
    } catch {}
    console.log(JSON.stringify({
      agentId: i,
      walletAddress: card?.walletAddress,
      name: card?.name,
      framework: card?.framework,
      model: card?.model,
      plugins: Array.isArray(card?.plugins) ? card.plugins.map((p: any) => p.registryId || p) : [],
      skills: card?.skills,
      cardCid: cid,
    }));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
