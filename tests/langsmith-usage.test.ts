import { describe, expect, it } from "vitest";

import {
  extractTokens as extractFrameworkTokens,
  resolveAuthoritativeTokens,
} from "../src/manowar/langsmith.js";
import { extractTokens as extractWorkflowTokens } from "../src/manowar/workflow/langsmith.js";

describe("LangSmith token extraction", () => {
  it("extracts reasoning tokens from LangChain usage_metadata", () => {
    const payload = {
      usage_metadata: {
        input_tokens: 120,
        output_tokens: 45,
        total_tokens: 165,
        output_token_details: {
          reasoning: 9,
        },
      },
    };

    expect(extractFrameworkTokens(payload)).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 9,
      totalTokens: 165,
      source: "usage_metadata",
    });
    expect(extractWorkflowTokens(payload)).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 9,
      totalTokens: 165,
      source: "usage_metadata",
    });
  });

  it("counts Gemini thoughtsTokenCount as reasoning and output tokens", () => {
    const payload = {
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 45,
        thoughtsTokenCount: 9,
        totalTokenCount: 174,
      },
    };

    expect(extractFrameworkTokens(payload)).toEqual({
      inputTokens: 120,
      outputTokens: 54,
      reasoningTokens: 9,
      totalTokens: 174,
      source: "usage_metadata",
    });
    expect(extractWorkflowTokens(payload)).toEqual({
      inputTokens: 120,
      outputTokens: 54,
      reasoningTokens: 9,
      totalTokens: 174,
      source: "usage_metadata",
    });
  });

  it("extracts usage from response_metadata.tokenUsage", () => {
    const payload = {
      response_metadata: {
        tokenUsage: {
          promptTokens: 463,
          completionTokens: 55,
          totalTokens: 518,
        },
      },
    };

    expect(extractFrameworkTokens(payload)).toEqual({
      inputTokens: 463,
      outputTokens: 55,
      reasoningTokens: 0,
      totalTokens: 518,
      source: "response_metadata",
    });
    expect(extractWorkflowTokens(payload)).toEqual({
      inputTokens: 463,
      outputTokens: 55,
      reasoningTokens: 0,
      totalTokens: 518,
      source: "response_metadata",
    });
  });

  it("prefers callback-tracked usage when the graph result omits direct usage metadata", () => {
    expect(
      resolveAuthoritativeTokens(
        { messages: [{ content: "hello" }] },
        {
          inputTokens: 120,
          outputTokens: 54,
          reasoningTokens: 9,
          totalTokens: 174,
        },
      ),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 54,
      reasoningTokens: 9,
      totalTokens: 174,
      source: "langsmith_callback",
    });
  });

  it("falls back to the final message usage when the graph result omits top-level usage", () => {
    expect(
      resolveAuthoritativeTokens({
        messages: [
          { content: "hello" },
          {
            usage_metadata: {
              input_tokens: 397,
              output_tokens: 42,
              total_tokens: 439,
            },
          },
        ],
      }),
    ).toEqual({
      inputTokens: 397,
      outputTokens: 42,
      reasoningTokens: 0,
      totalTokens: 439,
      source: "usage_metadata",
    });
  });

  it("returns zero usage instead of throwing when no usage metadata exists anywhere", () => {
    expect(
      resolveAuthoritativeTokens({
        messages: [{ content: "hello" }],
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      source: "direct_fields",
    });
  });
});
