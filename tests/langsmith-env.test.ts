import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = {
  LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY,
  LANGSMITH_PROJECT: process.env.LANGSMITH_PROJECT,
  LANGSMITH_ENDPOINT: process.env.LANGSMITH_ENDPOINT,
  LANGSMITH_TRACING: process.env.LANGSMITH_TRACING,
  LANGCHAIN_TRACING_V2: process.env.LANGCHAIN_TRACING_V2,
  LANGCHAIN_API_KEY: process.env.LANGCHAIN_API_KEY,
  LANGCHAIN_ENDPOINT: process.env.LANGCHAIN_ENDPOINT,
  LANGCHAIN_PROJECT: process.env.LANGCHAIN_PROJECT,
};

describe("LangSmith environment bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.LANGSMITH_PROJECT;
    delete process.env.LANGSMITH_ENDPOINT;
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGCHAIN_TRACING_V2;
    delete process.env.LANGCHAIN_API_KEY;
    delete process.env.LANGCHAIN_ENDPOINT;
    delete process.env.LANGCHAIN_PROJECT;
  });

  afterEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("enables LangChain tracing automatically when LangSmith credentials are present", async () => {
    process.env.LANGSMITH_API_KEY = "test-langsmith-key";
    process.env.LANGSMITH_PROJECT = "compose-market";
    process.env.LANGSMITH_ENDPOINT = "https://smith.example.com";

    await import("../src/manowar/langsmith.js");

    expect(process.env.LANGSMITH_TRACING).toBe("true");
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("true");
    expect(process.env.LANGCHAIN_API_KEY).toBe("test-langsmith-key");
    expect(process.env.LANGCHAIN_ENDPOINT).toBe("https://smith.example.com");
    expect(process.env.LANGCHAIN_PROJECT).toBe("compose-market");
  });
});
