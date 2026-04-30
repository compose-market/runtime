import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPinataGatewayIpfsUrl,
  buildApiInternalHeaders,
  buildEmbeddedRuntimeHeaders,
  buildRuntimeInternalHeaders,
  requireApiInternalUrl,
  requirePinataApiUrl,
  requireEmbeddedRuntimeBaseUrl,
  requireRuntimeServiceUrl,
} from "../src/auth.js";

describe("runtime auth helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requireApiInternalUrl reads the deployed API_URL contract", () => {
    vi.stubEnv("API_URL", "https://api.compose.market/");

    expect(requireApiInternalUrl()).toBe("https://api.compose.market");
  });

  it("buildApiInternalHeaders uses the shared internal secret for api calls", () => {
    vi.stubEnv("RUNTIME_INTERNAL_SECRET", "shared-secret");

    expect(buildApiInternalHeaders({ "content-type": "application/json" })).toEqual({
      Authorization: "Bearer shared-secret",
      "content-type": "application/json",
    });
  });

  it("buildRuntimeInternalHeaders uses the shared internal secret for runtime tool routes", () => {
    vi.stubEnv("RUNTIME_INTERNAL_SECRET", "shared-secret");

    expect(buildRuntimeInternalHeaders()).toEqual({
      Authorization: "Bearer shared-secret",
    });
  });

  it("runtime service helpers read the deployed RUNTIME_URL contract", () => {
    vi.stubEnv("RUNTIME_URL", "https://runtime.compose.market/");

    expect(requireRuntimeServiceUrl()).toBe("https://runtime.compose.market");
  });

  it("embedded runtime helpers use RUNTIME_URL and the shared secret", () => {
    vi.stubEnv("RUNTIME_URL", "https://runtime.compose.market/");
    vi.stubEnv("RUNTIME_INTERNAL_SECRET", "shared-secret");

    expect(requireEmbeddedRuntimeBaseUrl()).toBe(
      "https://runtime.compose.market/internal/workflow",
    );

    expect(buildEmbeddedRuntimeHeaders({ "content-type": "application/json" })).toEqual({
      "x-runtime-internal-token": "shared-secret",
      "X-Internal-Secret": "shared-secret",
      "content-type": "application/json",
    });
  });

  it("pinata helpers keep the REST API and gateway host contracts separate", () => {
    vi.stubEnv("PINATA_GATEWAY_URL", "https://compose.mypinata.cloud/");

    expect(requirePinataApiUrl()).toBe("https://api.pinata.cloud");
    expect(buildPinataGatewayIpfsUrl("ipfs://bafy-agent-card")).toBe(
      "https://compose.mypinata.cloud/ipfs/bafy-agent-card",
    );
  });
});
