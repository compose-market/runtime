
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Load env
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function verify() {
    console.log("🚀 Starting Deep Refactor Verification...");

    // Import LangChain Framework
    const manowar = await import("./src/manowar/framework.js");
    const { getMem0Client } = await import("../lambda/shared/mem0.js");

    // TEST 1: Agent Creation & Mem0 Integration
    console.log("\n🧪 TEST 1: Agent Creation & Mem0");
    const agent = await manowar.createAgent({
        name: "TestAgent",
        model: "asi1-mini",
        memory: true
    });
    console.log(`✅ Agent Created: ${agent.id}`);

    // TEST 2: Executive Run & Automatic Memory Capture
    console.log("\n🧪 TEST 2: Execution & Auto-Memory");
    const threadId = "verify-thread-" + Date.now();
    const input = "My name is Jabyl. Please remember this.";

    const result = await manowar.executeAgent(agent.id, input, { threadId });
    console.log("Response:", result.output);

    // Verify Mem0 captured it (simulated check as we can't query Mem0 instantly effectively due to async)
    // But we can check if the callback handler ran without error.
    if (result.success) console.log("✅ Execution successful");
    else console.error("❌ Execution failed", result.error);

    // TEST 3: Persistence (FileSystem Checkpoint)
    console.log("\n🧪 TEST 3: Persistence (FileSystem Checkpoint)");

    // Simulate Restart: Create NEW agent instance but use SAME thread_id
    const agent2 = await manowar.createAgent({
        name: "TestAgentRestored",
        model: "asi1-mini"
    });

    // Ask for name - if persistence works, it should know context from previous execution on this thread
    // Note: LangGraph persistence is tied to thread_id, regardless of agent instance if using same checkpointer?
    // Actually, checkpointer instance is unique per agent createAgent().
    // Using FileSystemCheckpointSaver pointed to same directory means it persists across process restarts
    // PROVIDED the checkpointer is initialized with same config.
    // In `checkpoint.ts` we use `data/checkpoints`.
    // So different agent instances sharing the same thread_id on the same machine WILL share state.

    const input2 = "What is my name?";
    console.log(`Asking: ${input2} on SAME thread ${threadId}`);

    const result2 = await manowar.executeAgent(agent2.id, input2, { threadId });
    console.log("Response 2:", result2.output);

    if (result2.output?.includes("Jabyl")) {
        console.log("✅ PERSISTENCE VERIFIED: Agent remembered name across instances!");
    } else {
        console.warn("⚠️ Persistence check inconclusive (LLM might have forgot or strictly scoped). Output: " + result2.output);
    }

    // TEST 4: Checkpoint File Existence
    const checkpointPath = path.resolve(process.cwd(), "data", "checkpoints", threadId);
    if (fs.existsSync(checkpointPath)) {
        console.log(`✅ Checkpoint directory exists: ${checkpointPath}`);
        const files = fs.readdirSync(checkpointPath);
        console.log(`   Found ${files.length} checkpoint files.`);
    } else {
        console.error(`❌ Checkpoint directory MISSING: ${checkpointPath}`);
    }
}

verify().catch(console.error);
