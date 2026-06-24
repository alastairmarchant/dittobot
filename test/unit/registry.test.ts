import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { tmpdir } from "node:os"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import path from "node:path"

vi.mock("../../src/env.js", () => ({
    env: {
        STORE: { TYPE: "memory" },
        STRICT_VERSIONS: true,
    },
}))

import { StoreRegistry } from "../../src/registry.js"
import ApprovalStore from "../../src/store.js"
import { ConfigError } from "../../src/errors.js"
import type { DittoBotConfig } from "../../src/env.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMemoryConfig = (): DittoBotConfig => ({
    STORE: { TYPE: "memory" },
    STRICT_VERSIONS: true,
})

const makeLocalConfig = (basePath: string): DittoBotConfig => ({
    STORE: { TYPE: "local", PATH: basePath },
    STRICT_VERSIONS: true,
})

const makeGithubConfig = (defaultRepo = ".dittobot-store"): DittoBotConfig => ({
    STORE: { TYPE: "github", DEFAULT_REPO: defaultRepo },
    STRICT_VERSIONS: true,
})

const makeMockOctokit = () => ({
    rest: {
        repos: {
            getContent: vi.fn(),
            createOrUpdateFileContents: vi.fn().mockResolvedValue({
                data: { content: { sha: "sha123" } },
            }),
            createInOrg: vi.fn().mockResolvedValue({ data: {} }),
            createForAuthenticatedUser: vi.fn().mockResolvedValue({ data: {} }),
        },
    },
})

// ---------------------------------------------------------------------------
// Memory store
// ---------------------------------------------------------------------------

describe("StoreRegistry — memory store", () => {
    test("returns an ApprovalStore instance", async () => {
        const registry = new StoreRegistry(makeMemoryConfig())
        const store = await registry.getStore("acme", {} as never)
        expect(store).toBeInstanceOf(ApprovalStore)
    })

    test("per-org isolation: different orgs get different store instances", async () => {
        const registry = new StoreRegistry(makeMemoryConfig())
        const octokit = {} as never
        const storeA = await registry.getStore("acme", octokit)
        const storeB = await registry.getStore("other-org", octokit)
        expect(storeA).not.toBe(storeB)
    })

    test("cache hit: same org returns the same store instance", async () => {
        const registry = new StoreRegistry(makeMemoryConfig())
        const octokit = {} as never
        const first = await registry.getStore("acme", octokit)
        const second = await registry.getStore("acme", octokit)
        expect(first).toBe(second)
    })

    test("default config has empty enrolledRepos, squash merge, requireCi=true", async () => {
        const registry = new StoreRegistry(makeMemoryConfig())
        const store = await registry.getStore("acme", {} as never)
        const config = await store.getConfig()
        expect(config.enrolledRepos).toEqual([])
        expect(config.mergeStrategy).toBe("squash")
        expect(config.requireCi).toBe(true)
        expect(config.org).toBe("acme")
    })
})

// ---------------------------------------------------------------------------
// Local store
// ---------------------------------------------------------------------------

describe("StoreRegistry — local store", () => {
    let tmpDir: string

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(tmpdir(), "dittobot-registry-test-"))
    })

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true })
    })

    test("creates per-org subdirectory with config.json", async () => {
        const registry = new StoreRegistry(makeLocalConfig(tmpDir))
        await registry.getStore("acme-corp", {} as never)

        const configPath = path.join(tmpDir, "acme-corp", "config.json")
        const raw = await readFile(configPath, "utf8")
        const config = JSON.parse(raw) as {
            org: string
            enrolledRepos: string[]
        }
        expect(config.org).toBe("acme-corp")
        expect(config.enrolledRepos).toEqual([])
    })

    test("per-org isolation: different orgs get separate subdirectories", async () => {
        const registry = new StoreRegistry(makeLocalConfig(tmpDir))
        const octokit = {} as never
        const storeA = await registry.getStore("acme", octokit)
        const storeB = await registry.getStore("other-org", octokit)
        expect(storeA).not.toBe(storeB)

        // Both directories should exist
        const configA = path.join(tmpDir, "acme", "config.json")
        const configB = path.join(tmpDir, "other-org", "config.json")
        await expect(readFile(configA, "utf8")).resolves.toBeDefined()
        await expect(readFile(configB, "utf8")).resolves.toBeDefined()
    })

    test("cache hit: same org returns same instance without re-creating directory", async () => {
        const registry = new StoreRegistry(makeLocalConfig(tmpDir))
        const octokit = {} as never
        const first = await registry.getStore("acme", octokit)
        const second = await registry.getStore("acme", octokit)
        expect(first).toBe(second)
    })

    test("does not overwrite existing config.json on re-bootstrap attempt", async () => {
        const registry = new StoreRegistry(makeLocalConfig(tmpDir))
        const octokit = {} as never

        // First call creates the directory and config
        await registry.getStore("acme", octokit)

        // Manually modify the config
        const configPath = path.join(tmpDir, "acme", "config.json")
        const modified = {
            org: "acme",
            enrolledRepos: ["repo-a"],
            mergeStrategy: "squash",
            requireCi: true,
        }
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(configPath, JSON.stringify(modified)),
        )

        // A new registry (cold cache) should NOT overwrite the existing config
        const registry2 = new StoreRegistry(makeLocalConfig(tmpDir))
        const store2 = await registry2.getStore("acme", octokit)
        const config = await store2.getConfig()
        expect(config.enrolledRepos).toEqual(["repo-a"])
    })
})

// ---------------------------------------------------------------------------
// GitHub store
// ---------------------------------------------------------------------------

describe("StoreRegistry — github store", () => {
    test("already-initialised: getContent succeeds → no file writes", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()
        const configData = {
            org: "acme",
            enrolledRepos: [],
            mergeStrategy: "squash",
            requireCi: true,
        }
        octokit.rest.repos.getContent.mockResolvedValueOnce({
            data: {
                content: Buffer.from(JSON.stringify(configData)).toString(
                    "base64",
                ),
                sha: "sha1",
            },
        })

        await registry.getStore("acme", octokit as never)

        expect(
            octokit.rest.repos.createOrUpdateFileContents,
        ).not.toHaveBeenCalled()
        expect(octokit.rest.repos.createInOrg).not.toHaveBeenCalled()
    })

    test("fresh org: getContent 404 → createInOrg + push initial files", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()

        // config.json doesn't exist
        octokit.rest.repos.getContent.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )

        await registry.getStore("acme", octokit as never)

        expect(octokit.rest.repos.createInOrg).toHaveBeenCalledOnce()
        expect(
            octokit.rest.repos.createOrUpdateFileContents,
        ).toHaveBeenCalledTimes(3)

        // Verify config.json was pushed with correct org
        const calls = octokit.rest.repos.createOrUpdateFileContents.mock.calls
        const configCall = calls.find(
            (c) => (c[0] as { path: string }).path === "config.json",
        )
        expect(configCall).toBeDefined()
        const content = JSON.parse(
            Buffer.from(
                (configCall![0] as { content: string }).content,
                "base64",
            ).toString("utf-8"),
        ) as { org: string }
        expect(content.org).toBe("acme")
    })

    test("repo exists but config.json absent: createInOrg 422 → push initial files without creating repo", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()

        octokit.rest.repos.getContent.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )
        // Repo already exists
        octokit.rest.repos.createInOrg.mockRejectedValueOnce(
            Object.assign(new Error("Repo already exists"), { status: 422 }),
        )

        await registry.getStore("acme", octokit as never)

        // Files should still be pushed despite repo-already-exists error
        expect(
            octokit.rest.repos.createOrUpdateFileContents,
        ).toHaveBeenCalledTimes(3)
    })

    test("createInOrg non-422 error propagates", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()

        octokit.rest.repos.getContent.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )
        octokit.rest.repos.createInOrg.mockRejectedValueOnce(
            Object.assign(new Error("Forbidden"), { status: 403 }),
        )

        await expect(
            registry.getStore("acme", octokit as never),
        ).rejects.toThrow("Forbidden")
    })

    test("non-404 getContent error propagates", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()

        octokit.rest.repos.getContent.mockRejectedValueOnce(
            Object.assign(new Error("Internal Server Error"), { status: 500 }),
        )

        await expect(
            registry.getStore("acme", octokit as never),
        ).rejects.toThrow("Internal Server Error")
    })

    test("cache hit: same org returns same instance", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()
        const configData = {
            org: "acme",
            enrolledRepos: [],
            mergeStrategy: "squash",
            requireCi: true,
        }
        // Return success for both calls (will only be called once due to cache)
        octokit.rest.repos.getContent.mockResolvedValue({
            data: {
                content: Buffer.from(JSON.stringify(configData)).toString(
                    "base64",
                ),
                sha: "sha1",
            },
        })

        const first = await registry.getStore("acme", octokit as never)
        const second = await registry.getStore("acme", octokit as never)

        expect(first).toBe(second)
        // getContent only called once (bootstrap only runs once)
        expect(octokit.rest.repos.getContent).toHaveBeenCalledOnce()
    })

    test("user installation: createInOrg 404 → createForAuthenticatedUser creates repo and pushes files", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()

        octokit.rest.repos.getContent.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )
        octokit.rest.repos.createInOrg.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )

        await registry.getStore("user-acct", octokit as never)

        expect(
            octokit.rest.repos.createForAuthenticatedUser,
        ).toHaveBeenCalledOnce()
        expect(
            octokit.rest.repos.createOrUpdateFileContents,
        ).toHaveBeenCalledTimes(3)
    })

    test("user installation: createInOrg 404 → createForAuthenticatedUser 422 (user repo exists) continues to push files", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()

        octokit.rest.repos.getContent.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )
        octokit.rest.repos.createInOrg.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )
        octokit.rest.repos.createForAuthenticatedUser.mockRejectedValueOnce(
            Object.assign(new Error("Already exists"), { status: 422 }),
        )

        await registry.getStore("user-acct", octokit as never)

        expect(
            octokit.rest.repos.createOrUpdateFileContents,
        ).toHaveBeenCalledTimes(3)
    })

    test("user installation: createInOrg 404 → createForAuthenticatedUser non-422 error propagates", async () => {
        const registry = new StoreRegistry(makeGithubConfig())
        const octokit = makeMockOctokit()

        octokit.rest.repos.getContent.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )
        octokit.rest.repos.createInOrg.mockRejectedValueOnce(
            Object.assign(new Error("Not Found"), { status: 404 }),
        )
        octokit.rest.repos.createForAuthenticatedUser.mockRejectedValueOnce(
            Object.assign(new Error("Forbidden"), { status: 403 }),
        )

        await expect(
            registry.getStore("user-acct", octokit as never),
        ).rejects.toThrow("Forbidden")
    })
})

// ---------------------------------------------------------------------------
// Concurrent bootstrap
// ---------------------------------------------------------------------------

describe("StoreRegistry — concurrent bootstrap", () => {
    test("two simultaneous getStore calls for new org bootstrap only once", async () => {
        const registry = new StoreRegistry(makeMemoryConfig())
        const octokit = {} as never

        // Fire two calls simultaneously without awaiting the first
        const [first, second] = await Promise.all([
            registry.getStore("acme", octokit),
            registry.getStore("acme", octokit),
        ])

        expect(first).toBe(second)
    })
})

// ---------------------------------------------------------------------------
// Empty org guard
// ---------------------------------------------------------------------------

describe("StoreRegistry — validation", () => {
    test("empty org string throws ConfigError", async () => {
        const registry = new StoreRegistry(makeMemoryConfig())
        await expect(registry.getStore("", {} as never)).rejects.toThrow(
            ConfigError,
        )
    })

    test("unsupported store type throws ConfigError", async () => {
        const config = {
            STORE: { TYPE: "invalid" },
            STRICT_VERSIONS: true,
        } as never
        const registry = new StoreRegistry(config)
        await expect(registry.getStore("acme", {} as never)).rejects.toThrow(
            ConfigError,
        )
    })
})
