import { describe, expect, it } from "vitest";

import { buildSceneLayerFilter, buildWorkingLayerFilter } from "../../src/manowar/memory/layers.js";
import { shouldIndexSessionTranscript } from "../../src/manowar/memory/transcript.js";

describe("memory layer scoping", () => {
    it("scopes working memory to agent, user, and thread when present", () => {
        expect(
            buildWorkingLayerFilter({
                agentWallet: "0xagent",
                userAddress: "user-1",
                threadId: "thread-1",
                filters: { app_id: "app-prod" },
            }),
        ).toEqual({
            agentWallet: "0xagent",
            userAddress: "user-1",
            threadId: "thread-1",
            "metadata.app_id": "app-prod",
            "metadata.status": { $nin: ["deleted", "superseded"] },
        });
    });

    it("scopes scene memory to agent and user even without a thread", () => {
        expect(
            buildSceneLayerFilter({
                agentWallet: "0xagent",
                userAddress: "user-2",
                threadId: undefined,
            }),
        ).toEqual({
            agentWallet: "0xagent",
            userAddress: "user-2",
            "metadata.status": { $nin: ["deleted", "superseded"] },
        });
    });
});

describe("transcript indexing guard", () => {
    it("indexes as soon as a user or assistant message exists", () => {
        expect(
            shouldIndexSessionTranscript([
                { role: "system", content: "sys", timestamp: 1 },
                { role: "user", content: "hello", timestamp: 2 },
            ]),
        ).toBe(true);
    });

    it("skips pure system and tool traffic", () => {
        expect(
            shouldIndexSessionTranscript([
                { role: "system", content: "sys", timestamp: 1 },
                { role: "tool", content: "{}", timestamp: 2 },
            ]),
        ).toBe(false);
    });
});
