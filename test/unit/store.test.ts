import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { tmpdir } from "node:os"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

vi.mock("../../src/env.js", () => ({
    env: {
        STORE: {
            TYPE: "memory",
        },
        STRICT_VERSIONS: true,
    },
}))

import ApprovalStore, {
    LocalFileStoreProvider,
    GithubVersionStoreProvider,
    MemoryVersionStoreProvider,
    ensurePackageInVersions,
    createDefaultStoreConfig,
} from "../../src/store.js"
import { ConfigError } from "../../src/errors.js"
import type {
    StoreConfig,
    ApprovedVersions,
    AuditEvent,
    VersionStoreProvider,
} from "../../src/store.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAuditEvent = (action = "test-action"): AuditEvent => ({
    action,
    timestamp: new Date().toISOString(),
})

const makeStoreConfig = (): StoreConfig => ({
    org: "test-org",
    enrolledRepos: [],
    mergeStrategy: "squash",
    requireCi: true,
})

// GitHub mock helpers
const makeContentResponse = (data: object, sha = "sha123") => ({
    data: {
        content: Buffer.from(JSON.stringify(data)).toString("base64"),
        sha,
    },
})

const makeCreateOrUpdateResponse = (sha = "newsha456") => ({
    data: { content: { sha } },
})

const makeMockOctokit = () => ({
    rest: {
        repos: {
            getContent: vi.fn(),
            createOrUpdateFileContents: vi.fn(),
        },
    },
})

// ---------------------------------------------------------------------------
// 1. ensurePackageInVersions
// ---------------------------------------------------------------------------

describe("ensurePackageInVersions", () => {
    test("creates ecosystem + package entries when absent", () => {
        const versions: ApprovedVersions = {}
        const result = ensurePackageInVersions(versions, "npm", "lodash")
        expect(versions.npm).toBeDefined()
        expect(versions.npm!.lodash).toBeDefined()
        expect(result).toBe(versions.npm!.lodash)
    })

    test("returns existing entry without overwriting (same object reference)", () => {
        const versions: ApprovedVersions = {}
        const first = ensurePackageInVersions(versions, "npm", "lodash")
        first["1.0.0"] = {
            approvedAt: "2024-01-01T00:00:00.000Z",
            approvedBy: "user",
            sourceRepo: "org/repo",
            sourcePr: 1,
        }
        const second = ensurePackageInVersions(versions, "npm", "lodash")
        expect(second).toBe(first)
        expect(second["1.0.0"]).toBeDefined()
    })
})

// ---------------------------------------------------------------------------
// 2. createDefaultStoreConfig
// ---------------------------------------------------------------------------

describe("createDefaultStoreConfig", () => {
    test("returns StoreConfig with correct defaults for given org", () => {
        const config = createDefaultStoreConfig("acme-org")
        expect(config).toEqual({
            org: "acme-org",
            enrolledRepos: [],
            mergeStrategy: "squash",
            requireCi: true,
        })
    })

    test("org field matches the provided org name", () => {
        const config = createDefaultStoreConfig("my-corp")
        expect(config.org).toBe("my-corp")
    })
})

// ---------------------------------------------------------------------------
// 3. MemoryVersionStoreProvider
// ---------------------------------------------------------------------------

describe("MemoryVersionStoreProvider", () => {
    let provider: MemoryVersionStoreProvider

    beforeEach(() => {
        provider = new MemoryVersionStoreProvider(makeStoreConfig())
    })

    test("getConfig returns StoreConfig built from constructor args", async () => {
        const config = await provider.getConfig()
        expect(config).toEqual({
            org: "test-org",
            enrolledRepos: [],
            mergeStrategy: "squash",
            requireCi: true,
        })
    })

    test("addApprovedVersion adds entry and returns true", async () => {
        const result = await provider.addApprovedVersion(
            "lodash",
            "4.17.21",
            "npm",
            "alice",
            "org/repo",
            42,
        )
        expect(result).toBe(true)
    })

    test("addApprovedVersion duplicate (same packageName+version) returns false", async () => {
        await provider.addApprovedVersion(
            "lodash",
            "4.17.21",
            "npm",
            "alice",
            "org/repo",
            42,
        )
        const result = await provider.addApprovedVersion(
            "lodash",
            "4.17.21",
            "npm",
            "bob",
            "org/repo2",
            99,
        )
        expect(result).toBe(false)
    })

    test("getApprovedVersions reflects additions", async () => {
        await provider.addApprovedVersion(
            "lodash",
            "4.17.21",
            "npm",
            "alice",
            "org/repo",
            42,
        )
        const versions = await provider.getApprovedVersions()
        expect(versions.npm?.lodash?.["4.17.21"]).toBeDefined()
        expect(versions.npm?.lodash?.["4.17.21"]?.approvedBy).toBe("alice")
    })

    test("updateConfig persists change and returns updated config", async () => {
        const updated = await provider.updateConfig("org", "new-org")
        expect(updated.org).toBe("new-org")
        const config = await provider.getConfig()
        expect(config.org).toBe("new-org")
    })

    test("constructor deep-copies enrolledRepos so external mutation does not affect the provider", async () => {
        const repos = ["repo-a"]
        const storeProvider = new MemoryVersionStoreProvider({
            org: "test-org",
            enrolledRepos: repos,
            mergeStrategy: "squash",
            requireCi: true,
        })
        repos.push("repo-b")
        const config = await storeProvider.getConfig()
        expect(config.enrolledRepos).toEqual(["repo-a"])
        expect(config.enrolledRepos).not.toContain("repo-b")
    })

    test("logEvent resolves without throwing", async () => {
        const event = makeAuditEvent("version.approved")
        await expect(provider.logEvent(event)).resolves.toBeUndefined()
    })
})

// ---------------------------------------------------------------------------
// 4. LocalFileStoreProvider
// ---------------------------------------------------------------------------

describe("LocalFileStoreProvider", () => {
    let tmpDir: string
    let provider: LocalFileStoreProvider

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(tmpdir(), "dittobot-test-"))
        provider = new LocalFileStoreProvider(tmpDir)
    })

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true })
    })

    test("getConfig throws ConfigError when no config file exists", async () => {
        await expect(provider.getConfig()).rejects.toThrow(ConfigError)
    })

    test("getApprovedVersions returns empty {} when no approved-versions.json file", async () => {
        const versions = await provider.getApprovedVersions()
        expect(versions).toEqual({})
    })

    test("addApprovedVersion writes entry; reads it back via getApprovedVersions", async () => {
        const added = await provider.addApprovedVersion(
            "express",
            "4.18.2",
            "npm",
            "alice",
            "org/repo",
            7,
        )
        expect(added).toBe(true)

        const versions = await provider.getApprovedVersions()
        expect(versions.npm?.express?.["4.18.2"]).toBeDefined()
        expect(versions.npm?.express?.["4.18.2"]?.approvedBy).toBe("alice")
    })

    test("addApprovedVersion duplicate returns false without re-writing", async () => {
        await provider.addApprovedVersion(
            "express",
            "4.18.2",
            "npm",
            "alice",
            "org/repo",
            7,
        )
        const result = await provider.addApprovedVersion(
            "express",
            "4.18.2",
            "npm",
            "bob",
            "org/repo2",
            8,
        )
        expect(result).toBe(false)

        // Original approval should still be intact
        const versions = await provider.getApprovedVersions()
        expect(versions.npm?.express?.["4.18.2"]?.approvedBy).toBe("alice")
    })

    test("logEvent appends event; second call results in two events", async () => {
        const event1 = makeAuditEvent("first-action")
        const event2 = makeAuditEvent("second-action")

        await provider.logEvent(event1)
        await provider.logEvent(event2)

        const auditFile = path.join(tmpDir, "audit-log.json")
        const raw = await readFile(auditFile, "utf8")
        const data = JSON.parse(raw) as { events: AuditEvent[] }

        expect(data.events).toHaveLength(2)
        expect(data.events[0]?.action).toBe("first-action")
        expect(data.events[1]?.action).toBe("second-action")
    })

    test("updateConfig persists config change; readable via getConfig", async () => {
        await writeFile(
            path.join(tmpDir, "config.json"),
            JSON.stringify({
                org: "acme",
                enrolledRepos: [],
                mergeStrategy: "squash",
                requireCi: true,
            }),
        )

        const updated = await provider.updateConfig("org", "new-acme")
        expect(updated.org).toBe("new-acme")

        const config = await provider.getConfig()
        expect(config.org).toBe("new-acme")
    })

    test("approvalStoreLink returns file:// URL pointing to approved-versions.json", () => {
        expect(provider.approvalStoreLink).toMatch(
            /^file:\/\/.*approved-versions\.json$/,
        )
    })
})

// ---------------------------------------------------------------------------
// 5. GithubVersionStoreProvider
// ---------------------------------------------------------------------------

const validStoreConfig: StoreConfig = {
    org: "acme",
    enrolledRepos: ["acme/repo-a"],
    mergeStrategy: "squash",
    requireCi: true,
}

const validApprovalFileData = {
    metadata: {
        description: "Approved dependency versions for Dependabot auto-merge",
        last_updated: "2024-01-01T00:00:00.000Z",
        schema_version: "1.0",
    },
    approved: {},
}

describe("GithubVersionStoreProvider", () => {
    let mockOctokit: ReturnType<typeof makeMockOctokit>
    let provider: GithubVersionStoreProvider

    beforeEach(() => {
        mockOctokit = makeMockOctokit()
        provider = new GithubVersionStoreProvider(
            mockOctokit as never,
            "owner",
            "repo",
        )
    })

    test("getConfig returns valid StoreConfig from mocked getContent", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validStoreConfig),
        )

        const config = await provider.getConfig()
        expect(config).toEqual(validStoreConfig)
    })

    test("getConfig stores blob SHA in _configSha for subsequent updateConfig calls", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validStoreConfig, "sha-from-get"),
        )

        await provider.getConfig()

        expect(provider.configSha).toBe("sha-from-get")
    })

    test("updateConfig patches field and updates configSha", async () => {
        // getConfig call inside updateConfig
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validStoreConfig, "oldsha"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            {
                data: { content: { sha: "newsha" } },
            },
        )

        const updated = await provider.updateConfig("mergeStrategy", "rebase")

        expect(updated.mergeStrategy).toBe("rebase")
        expect(provider.configSha).toBe("newsha")

        const callArgs =
            mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0]![0]
        expect(callArgs.message).toContain("mergeStrategy")
        expect(callArgs.sha).toBe("oldsha")
    })

    test("updateConfig throws when createOrUpdateFileContents returns no sha in content", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validStoreConfig),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            {
                data: { content: null },
            },
        )

        await expect(
            provider.updateConfig("org", "broken-org"),
        ).rejects.toThrow("Failed to update config")
    })

    test("getApprovedVersions stores _versionsSha", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validApprovalFileData, "vsha1"),
        )

        const versions = await provider.getApprovedVersions()
        expect(versions).toEqual({})
        // Access private field via casting to verify side effect
        expect(
            (provider as unknown as { _versionsSha: string })._versionsSha,
        ).toBe("vsha1")
    })

    test("addApprovedVersion adds new entry and returns true", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validApprovalFileData, "vsha1"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            makeCreateOrUpdateResponse("vsha2"),
        )

        const result = await provider.addApprovedVersion(
            "lodash",
            "4.17.21",
            "npm",
            "alice",
            "owner/repo",
            5,
        )

        expect(result).toBe(true)
        expect(
            mockOctokit.rest.repos.createOrUpdateFileContents,
        ).toHaveBeenCalledOnce()
    })

    test("addApprovedVersion duplicate returns false and createOrUpdateFileContents is NOT called", async () => {
        const approvalWithExisting = {
            ...validApprovalFileData,
            approved: {
                npm: {
                    lodash: {
                        "4.17.21": {
                            approvedAt: "2024-01-01T00:00:00.000Z",
                            approvedBy: "alice",
                            sourceRepo: "owner/repo",
                            sourcePr: 5,
                        },
                    },
                },
            },
        }

        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(approvalWithExisting, "vsha1"),
        )

        const result = await provider.addApprovedVersion(
            "lodash",
            "4.17.21",
            "npm",
            "bob",
            "owner/repo2",
            99,
        )

        expect(result).toBe(false)
        expect(
            mockOctokit.rest.repos.createOrUpdateFileContents,
        ).not.toHaveBeenCalled()
    })

    test("logEvent appends event to audit log", async () => {
        const existingAudit = {
            events: [makeAuditEvent("existing-event")],
        }

        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(existingAudit, "auditsha1"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            makeCreateOrUpdateResponse("auditsha2"),
        )

        await provider.logEvent(makeAuditEvent("new-event"))

        const callArgs =
            mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0]![0]
        const written = JSON.parse(
            Buffer.from(callArgs.content as string, "base64").toString("utf-8"),
        ) as { events: AuditEvent[] }

        expect(written.events).toHaveLength(2)
        expect(written.events[0]?.action).toBe("existing-event")
        expect(written.events[1]?.action).toBe("new-event")
    })

    test("configSha reflects last updateConfig call after logEvent", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validStoreConfig, "configsha1"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            {
                data: { content: { sha: "configsha2" } },
            },
        )
        await provider.updateConfig("org", "new-org")

        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse({ events: [] }, "auditsha1"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            makeCreateOrUpdateResponse("auditsha2"),
        )
        await provider.logEvent(makeAuditEvent("test"))

        expect(provider.configSha).toBe("configsha2")
    })

    test("audit log capped at 500 events", async () => {
        const existingEvents = Array.from({ length: 501 }, (_, i) =>
            makeAuditEvent(`event-${i}`),
        )
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse({ events: existingEvents }, "auditsha1"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            makeCreateOrUpdateResponse("auditsha2"),
        )

        await provider.logEvent(makeAuditEvent("new-event"))

        const callArgs =
            mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0]![0]
        const written = JSON.parse(
            Buffer.from(callArgs.content as string, "base64").toString("utf-8"),
        ) as { events: AuditEvent[] }

        expect(written.events).toHaveLength(500)
        // The oldest event (event-0) should have been dropped, and new-event at end
        expect(written.events[written.events.length - 1]?.action).toBe(
            "new-event",
        )
    })

    test("approvalStoreLink returns https://github.com/owner/repo", () => {
        expect(provider.approvalStoreLink).toBe("https://github.com/owner/repo")
    })

    test("addApprovedVersion throws when createOrUpdateFileContents returns no sha", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce(
            makeContentResponse(validApprovalFileData, "vsha1"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            {
                data: { content: null },
            },
        )

        await expect(
            provider.addApprovedVersion(
                "lodash",
                "4.17.21",
                "npm",
                "alice",
                "owner/repo",
                5,
            ),
        ).rejects.toThrow("Failed to update approved versions")
    })

    test("logEvent starts with empty audit log when getContent throws (e.g. 404)", async () => {
        mockOctokit.rest.repos.getContent.mockRejectedValueOnce(
            new Error("Not Found"),
        )
        mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce(
            makeCreateOrUpdateResponse("auditsha1"),
        )

        await provider.logEvent(makeAuditEvent("first-event"))

        const callArgs =
            mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0]![0]
        const written = JSON.parse(
            Buffer.from(callArgs.content as string, "base64").toString("utf-8"),
        ) as { events: AuditEvent[] }

        expect(written.events).toHaveLength(1)
        expect(written.events[0]?.action).toBe("first-event")
    })

    test("getConfig throws when getContent response has no content field", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
            data: { sha: "somesha", type: "dir" },
        })

        await expect(provider.getConfig()).rejects.toThrow("File not found")
    })
})

// ---------------------------------------------------------------------------
// 6. ApprovalStore (wrapping MemoryVersionStoreProvider)
// ---------------------------------------------------------------------------

const makeProvider = (): VersionStoreProvider => {
    return new MemoryVersionStoreProvider(makeStoreConfig())
}

describe("ApprovalStore", () => {
    test("getConfig caches: provider.getConfig called only once for two calls", async () => {
        const provider = makeProvider()
        const spy = vi.spyOn(provider, "getConfig")
        const store = new ApprovalStore(provider)

        await store.getConfig()
        await store.getConfig()

        expect(spy).toHaveBeenCalledOnce()
    })

    test("updateConfig updates the cache", async () => {
        const provider = makeProvider()
        const store = new ApprovalStore(provider)

        await store.getConfig()
        const updated = await store.updateConfig("org", "updated-org")

        expect(updated.org).toBe("updated-org")
        // Cache should now reflect the updated config — no additional provider call needed
        const spy = vi.spyOn(provider, "getConfig")
        const cached = await store.getConfig()
        expect(cached.org).toBe("updated-org")
        expect(spy).not.toHaveBeenCalled()
    })

    test("invalidateCache clears caches: getConfig called twice after invalidate", async () => {
        const provider = makeProvider()
        const spy = vi.spyOn(provider, "getConfig")
        const store = new ApprovalStore(provider)

        await store.getConfig()
        store.invalidateCache()
        await store.getConfig()

        expect(spy).toHaveBeenCalledTimes(2)
    })

    test("approveVersion for new dep returns true and version cache is updated", async () => {
        const provider = makeProvider()
        const store = new ApprovalStore(provider)

        // Prime the versions cache
        await store.getApprovedVersions()

        const result = await store.approveVersion(
            {
                name: "lodash",
                version: "4.17.21",
                ecosystem: "npm",
                type: "direct",
            },
            "alice",
            "org/repo",
            1,
        )

        expect(result).toBe(true)

        // Cache should be updated in-place
        const versions = await store.getApprovedVersions()
        expect(versions.npm?.lodash?.["4.17.21"]).toBeDefined()
    })

    test("approveVersion for existing dep returns false and cache remains valid", async () => {
        const provider = makeProvider()
        const store = new ApprovalStore(provider)

        // First approval
        await store.approveVersion(
            {
                name: "lodash",
                version: "4.17.21",
                ecosystem: "npm",
                type: "direct",
            },
            "alice",
            "org/repo",
            1,
        )

        // Prime both caches before spying
        await store.getConfig()
        await store.getApprovedVersions()

        const configSpy = vi.spyOn(provider, "getConfig")
        const versionsSpy = vi.spyOn(provider, "getApprovedVersions")

        // Duplicate approval — nothing changed in the store, cache should stay valid
        const result = await store.approveVersion(
            {
                name: "lodash",
                version: "4.17.21",
                ecosystem: "npm",
                type: "direct",
            },
            "bob",
            "org/repo2",
            2,
        )

        expect(result).toBe(false)

        // Cache still valid — next reads should not hit the provider
        await store.getConfig()
        await store.getApprovedVersions()

        expect(configSpy).not.toHaveBeenCalled()
        expect(versionsSpy).not.toHaveBeenCalled()
    })

    test("logEvent delegates to provider", async () => {
        const provider = makeProvider()
        const spy = vi.spyOn(provider, "logEvent")
        const store = new ApprovalStore(provider)
        const event = makeAuditEvent("test-delegation")

        await store.logEvent(event)

        expect(spy).toHaveBeenCalledOnce()
        expect(spy).toHaveBeenCalledWith(event)
    })

    test("approvalStoreLink delegates to provider", () => {
        const provider = makeProvider()
        const store = new ApprovalStore(provider)
        expect(store.approvalStoreLink).toBe(provider.approvalStoreLink)
    })
})
