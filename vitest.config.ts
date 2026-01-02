import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"],
        exclude: ["node_modules", "dist"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            include: ["src/manowar/**/*.ts"],
            exclude: ["src/manowar/tests/**", "src/manowar/index.ts"],
        },
        testTimeout: 30000,
        hookTimeout: 10000,
    },
});
