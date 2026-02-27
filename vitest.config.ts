import { defineConfig } from "vitest/config";
import { config } from "dotenv";

// Load .env file for tests
config();

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
        exclude: ["node_modules", "dist"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            include: ["src/manowar/**/*.ts"],
            exclude: ["src/manowar/tests/**", "src/manowar/index.ts"],
        },
        testTimeout: 30000,
        hookTimeout: 10000,
        // Load .env automatically
        setupFiles: ["dotenv/config"],
    },
});
