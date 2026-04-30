import { describe, expect, it } from "vitest";

import {
  buildDurableLayerFilter,
  buildSceneLayerFilter,
  buildWorkingLayerFilter,
} from "../src/manowar/memory/layers.js";

const BASE_SCOPE = {
  agentWallet: "0x1111111111111111111111111111111111111111",
  userAddress: "0x2222222222222222222222222222222222222222",
  threadId: "agent:mesh-test:local-agent:atlas:chat:main",
  mode: "local" as const,
  haiId: "abc123",
  filters: undefined,
};

describe("local mesh memory filters", () => {
  it("keeps thread scoping for working memory and scene transcripts", () => {
    expect(buildWorkingLayerFilter(BASE_SCOPE)).toMatchObject({
      agentWallet: BASE_SCOPE.agentWallet,
      userAddress: BASE_SCOPE.userAddress,
      threadId: BASE_SCOPE.threadId,
      mode: "local",
      haiId: "abc123",
    });

    expect(buildSceneLayerFilter(BASE_SCOPE)).toMatchObject({
      agentWallet: BASE_SCOPE.agentWallet,
      userAddress: BASE_SCOPE.userAddress,
      threadId: BASE_SCOPE.threadId,
      mode: "local",
      haiId: "abc123",
    });
  });

  it("drops thread scoping for durable pattern and archive recall", () => {
    expect(buildDurableLayerFilter(BASE_SCOPE)).toEqual({
      agentWallet: BASE_SCOPE.agentWallet,
      userAddress: BASE_SCOPE.userAddress,
      mode: "local",
      haiId: "abc123",
      "metadata.status": { $nin: ["deleted", "superseded"] },
    });
  });
});
