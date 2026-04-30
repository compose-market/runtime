import { describe, expect, it } from "vitest";
import { loadMeshSynapseConfig } from "../src/mesh/config.js";

describe("mesh synapse config", () => {
  it("pins compose mesh storage to the compose namespace", () => {
    const config = loadMeshSynapseConfig({
      COMPOSE_LOCAL_RUNTIME_AUTH_TOKEN: "token",
      SYNAPSE_NETWORK: 'calibration   # "calibration" | "mainnet"',
      SYNAPSE_PROJECT_NAMESPACE: "wrong-namespace   # ignored for compose mesh storage",
      FILECOIN_CALIBRATION_RPC: "https://rpc.example   # calibration rpc",
    });

    expect(config.network).toBe("calibration");
    expect(config.source).toBe("compose");
    expect(config.rpcUrl).toBe("https://rpc.example");
  });
});
