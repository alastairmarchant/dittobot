import { defineConfig } from "vitest/config"
import { loadEnv } from "vite"

export default defineConfig(({ mode }) => {
    console.log(`Running tests in ${mode} mode`)
    const env = loadEnv(mode, process.cwd(), "")
    return {
        test: {
            include: ["test/**/*.test.ts"],
            coverage: {
                provider: "v8",
                enabled: true,
                include: ["src/**/*.ts"],
                thresholds: {
                    statements: 100,
                    lines: 100,
                    functions: 100,
                    branches: 100,
                },
            },
            env: {
                ...env,
            },
        },
    }
})
