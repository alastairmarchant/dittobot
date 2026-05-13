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
            },
            env: {
                ...env,
            },
        },
    }
})
