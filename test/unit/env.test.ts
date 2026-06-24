import { describe, test, expect, afterEach, vi } from "vitest"
import { ZodError } from "zod"
import { nestObject, parseEnv } from "../../src/env.js"

describe("nestObject", () => {
    test("flat object with no separators → keys preserved as-is", () => {
        const result = nestObject({ FOO: "bar", BAZ: "qux" })
        expect(result).toEqual({ FOO: "bar", BAZ: "qux" })
    })

    test("flat object with __ separators → correct nested structure", () => {
        const result = nestObject({ STORE__TYPE: "memory", STORE__FOO: "bar" })
        expect(result).toEqual({
            STORE: {
                TYPE: "memory",
                FOO: "bar",
            },
        })
    })

    test("multi-level nesting (A__B__C=val → { A: { B: { C: 'val' } } })", () => {
        const result = nestObject({ A__B__C: "val" })
        expect(result).toEqual({ A: { B: { C: "val" } } })
    })

    test("empty input → empty output", () => {
        const result = nestObject({})
        expect(result).toEqual({})
    })

    test("keys with leading/trailing separators are skipped", () => {
        // Leading separator: "__FOO" splits to ["", "FOO"] — empty part skipped, result: { FOO: "v" }
        const leading = nestObject({ __FOO: "v" })
        expect(leading).toEqual({ FOO: "v" })

        // Trailing separator: "FOO__" splits to ["FOO", ""] — the last empty part means
        // the non-empty part "FOO" is treated as an intermediate level, not set as a value
        const trailing = nestObject({ FOO__: "v" })
        expect(trailing).toEqual({ FOO: {} })
    })
})

describe("parseEnv", () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    test("valid memory store config — only TYPE required", () => {
        vi.stubEnv("DITTOBOT_STRICT_VERSIONS", "true")
        vi.stubEnv("DITTOBOT_STORE__TYPE", "memory")

        const result = parseEnv()

        expect(result).toEqual({
            STRICT_VERSIONS: true,
            STORE: {
                TYPE: "memory",
            },
        })
    })

    test("valid local store config", () => {
        vi.stubEnv("DITTOBOT_STORE__TYPE", "local")
        vi.stubEnv("DITTOBOT_STORE__PATH", "/tmp/store")

        const result = parseEnv()

        expect(result.STORE).toEqual({
            TYPE: "local",
            PATH: "/tmp/store",
        })
    })

    test("valid github store config", () => {
        vi.stubEnv("DITTOBOT_STORE__TYPE", "github")
        vi.stubEnv("DITTOBOT_STORE__DEFAULT_REPO", ".dittobot-store")

        const result = parseEnv()

        expect(result.STORE).toEqual({
            TYPE: "github",
            DEFAULT_REPO: ".dittobot-store",
        })
    })

    test("STRICT_VERSIONS=false → STRICT_VERSIONS is false", () => {
        vi.stubEnv("DITTOBOT_STRICT_VERSIONS", "false")
        vi.stubEnv("DITTOBOT_STORE__TYPE", "memory")

        const result = parseEnv()

        expect(result.STRICT_VERSIONS).toBe(false)
    })

    test("STRICT_VERSIONS=true → STRICT_VERSIONS is true", () => {
        vi.stubEnv("DITTOBOT_STRICT_VERSIONS", "true")
        vi.stubEnv("DITTOBOT_STORE__TYPE", "memory")

        const result = parseEnv()

        expect(result.STRICT_VERSIONS).toBe(true)
    })

    test("github store missing DEFAULT_REPO → ZodError", () => {
        vi.stubEnv("DITTOBOT_STORE__TYPE", "github")

        expect(() => parseEnv()).toThrow(ZodError)
    })

    test("invalid STORE__TYPE=unknown → throws ZodError", () => {
        vi.stubEnv("DITTOBOT_STORE__TYPE", "unknown")

        expect(() => parseEnv()).toThrow(ZodError)
    })
})
