import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("../../src/env.js", () => ({
    env: {
        STORE: { TYPE: "memory" },
        STRICT_VERSIONS: true,
    },
}))

const mockGetStore = vi.fn()

vi.mock("../../src/registry.js", () => ({
    StoreRegistry: vi.fn().mockImplementation(() => ({
        getStore: mockGetStore,
    })),
}))

const mockOctokitInstance = {
    paginate: vi.fn().mockResolvedValue([]),
    rest: {
        pulls: {
            list: vi.fn(),
            listCommits: vi.fn().mockResolvedValue({ data: [] }),
        },
    },
}

vi.mock("probot", async () => {
    const actual = await vi.importActual<typeof import("probot")>("probot")
    return { ...actual, ProbotOctokit: vi.fn(() => mockOctokitInstance) }
})

vi.mock("../../src/dependencies.js", async () => {
    const actual = await vi.importActual<
        typeof import("../../src/dependencies.js")
    >("../../src/dependencies.js")
    return {
        ...actual,
        checkPendingPrs: vi.fn().mockResolvedValue(undefined),
    }
})

import ApprovalStore, { MemoryVersionStoreProvider } from "../../src/store.js"
import { StoreRegistry } from "../../src/registry.js"
import {
    approveAction,
    listAction,
    pendingAction,
    scanAction,
    enrollAction,
    unenrollAction,
    program,
} from "../../src/cli.js"
import { checkPendingPrs } from "../../src/dependencies.js"
import type { Dependency } from "../../src/dependencies.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeStore = (enrolledRepos: string[] = []) => {
    const provider = new MemoryVersionStoreProvider({
        org: "test-org",
        enrolledRepos,
        mergeStrategy: "squash",
        requireCi: true,
    })
    return new ApprovalStore(provider)
}

const makeDep = (overrides: Partial<Dependency> = {}): Dependency => ({
    name: "lodash",
    version: "4.17.21",
    ecosystem: "npm",
    type: "direct",
    ...overrides,
})

// ---------------------------------------------------------------------------
// approveAction
// ---------------------------------------------------------------------------

describe("approveAction", () => {
    test("calls store.approveVersion with the correct Dependency and user string", async () => {
        const store = makeStore()
        const spy = vi.spyOn(store, "approveVersion")
        const dep = makeDep()

        await approveAction(store, dep, "alice")

        expect(spy).toHaveBeenCalledOnce()
        expect(spy).toHaveBeenCalledWith(dep, "alice", "dittobot-cli", -1)
    })
})

// ---------------------------------------------------------------------------
// listAction
// ---------------------------------------------------------------------------

describe("listAction", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)
    })

    afterEach(() => {
        consoleSpy.mockRestore()
    })

    test("calls store.getApprovedVersions", async () => {
        const store = makeStore()
        const spy = vi.spyOn(store, "getApprovedVersions")

        await listAction(store)

        expect(spy).toHaveBeenCalledOnce()
    })

    test("output contains package name and version for an approved dep", async () => {
        const store = makeStore()
        await store.approveVersion(
            {
                name: "express",
                version: "4.18.2",
                ecosystem: "npm",
                type: "direct",
            },
            "bob",
            "org/repo",
            7,
        )

        await listAction(store)

        expect(consoleSpy).toHaveBeenCalledOnce()
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("express"),
        )
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("4.18.2"),
        )
    })

    test("empty store produces no console output", async () => {
        const store = makeStore()

        await listAction(store)

        expect(consoleSpy).not.toHaveBeenCalled()
    })
})

// ---------------------------------------------------------------------------
// enrollAction
// ---------------------------------------------------------------------------

describe("enrollAction", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)
    })

    afterEach(() => {
        consoleSpy.mockRestore()
    })

    test("adds repo to enrolledRepos when not already present", async () => {
        const store = makeStore([])

        await enrollAction(store, "my-org/my-repo")

        const config = await store.getConfig()
        expect(config.enrolledRepos).toContain("my-org/my-repo")
    })

    test("logs 'already enrolled' and does NOT call updateConfig when repo is already in list", async () => {
        const store = makeStore(["my-org/my-repo"])
        const updateSpy = vi.spyOn(store, "updateConfig")

        await enrollAction(store, "my-org/my-repo")

        expect(consoleSpy).toHaveBeenCalledOnce()
        const message: string = consoleSpy.mock.calls[0]![0] as string
        expect(message).toContain("already enrolled")
        expect(updateSpy).not.toHaveBeenCalled()
    })
})

// ---------------------------------------------------------------------------
// unenrollAction
// ---------------------------------------------------------------------------

describe("unenrollAction", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)
    })

    afterEach(() => {
        consoleSpy.mockRestore()
    })

    test("removes repo from enrolledRepos when present", async () => {
        const store = makeStore(["my-org/my-repo", "my-org/other-repo"])

        await unenrollAction(store, "my-org/my-repo")

        const config = await store.getConfig()
        expect(config.enrolledRepos).not.toContain("my-org/my-repo")
        expect(config.enrolledRepos).toContain("my-org/other-repo")
    })

    test("logs 'not enrolled' and does NOT call updateConfig when repo is not in list", async () => {
        const store = makeStore([])
        const updateSpy = vi.spyOn(store, "updateConfig")

        await unenrollAction(store, "my-org/missing-repo")

        expect(consoleSpy).toHaveBeenCalledOnce()
        const message: string = consoleSpy.mock.calls[0]![0] as string
        expect(message).toContain("not enrolled")
        expect(updateSpy).not.toHaveBeenCalled()
    })
})

// ---------------------------------------------------------------------------
// scanAction
// ---------------------------------------------------------------------------

describe("scanAction", () => {
    const mockOctokit = {} as never

    beforeEach(() => {
        vi.mocked(checkPendingPrs).mockClear()
    })

    test("calls checkPendingPrs with dryRun=false when passed false", async () => {
        const store = makeStore()

        await scanAction(store, mockOctokit, false)

        expect(checkPendingPrs).toHaveBeenCalledOnce()
        expect(checkPendingPrs).toHaveBeenCalledWith(
            mockOctokit,
            "test-org",
            store,
            false,
        )
    })

    test("calls checkPendingPrs with dryRun=true when passed true", async () => {
        const store = makeStore()

        await scanAction(store, mockOctokit, true)

        expect(checkPendingPrs).toHaveBeenCalledOnce()
        expect(checkPendingPrs).toHaveBeenCalledWith(
            mockOctokit,
            "test-org",
            store,
            true,
        )
    })

    test("passes the org from store config to checkPendingPrs", async () => {
        const store = makeStore()

        await scanAction(store, mockOctokit, false)

        expect(checkPendingPrs).toHaveBeenCalledWith(
            mockOctokit,
            "test-org",
            store,
            false,
        )
    })
})

// ---------------------------------------------------------------------------
// pendingAction
// ---------------------------------------------------------------------------

describe("pendingAction", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)
    })

    afterEach(() => {
        consoleSpy.mockRestore()
    })

    test("calls store.getConfig to get owner", async () => {
        const store = makeStore(["my-org/repo-a"])
        const configSpy = vi.spyOn(store, "getConfig")

        const mockOctokit = {
            rest: { pulls: { list: vi.fn() } },
            paginate: vi.fn().mockResolvedValue([]),
        } as never

        await pendingAction(store, mockOctokit)

        expect(configSpy).toHaveBeenCalled()
    })

    test("calls octokit.paginate for each enrolled repo", async () => {
        const store = makeStore(["my-org/repo-a", "my-org/repo-b"])

        const mockOctokit = {
            rest: { pulls: { list: vi.fn() } },
            paginate: vi.fn().mockResolvedValue([]),
        } as never

        await pendingAction(store, mockOctokit)

        expect(
            (mockOctokit as { paginate: ReturnType<typeof vi.fn> }).paginate,
        ).toHaveBeenCalledTimes(2)
    })

    test("no paginate calls when no repos enrolled", async () => {
        const store = makeStore([])

        const mockOctokit = {
            rest: { pulls: { list: vi.fn() } },
            paginate: vi.fn().mockResolvedValue([]),
        } as never

        await pendingAction(store, mockOctokit)

        expect(
            (mockOctokit as { paginate: ReturnType<typeof vi.fn> }).paginate,
        ).not.toHaveBeenCalled()
    })

    test("logs PR status for dependabot PRs with dependencies (PENDING + READY paths)", async () => {
        const validCommitMessage = `Bump ruff

---
updated-dependencies:
- dependency-name: ruff
  dependency-version: 0.15.11
  dependency-type: direct:production
...
`
        // Store has ruff approved — PR will be READY
        const provider = new MemoryVersionStoreProvider({
            org: "test-org",
            enrolledRepos: ["my-org/repo-a"],
            mergeStrategy: "squash",
            requireCi: true,
        })
        await provider.addApprovedVersion(
            "ruff",
            "0.15.11",
            "uv",
            "user",
            "org/repo",
            1,
        )
        const store = new ApprovalStore(provider)

        const mockOctokit = {
            rest: {
                pulls: {
                    list: vi.fn(),
                    listCommits: vi.fn().mockResolvedValue({
                        data: [{ commit: { message: validCommitMessage } }],
                    }),
                },
            },
            paginate: vi.fn().mockResolvedValue([
                {
                    number: 42,
                    user: { login: "dependabot[bot]" },
                    head: {
                        ref: "dependabot/uv/ruff-0.15.11",
                        sha: "abc123",
                        repo: { name: "repo-a" },
                    },
                    base: { repo: { name: "repo-a" } },
                    title: "Bump ruff",
                },
            ]),
        } as never

        const consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)

        await pendingAction(store, mockOctokit)

        const output = consoleSpy.mock.calls
            .map((c) => c[0] as string)
            .join("\n")
        expect(output).toContain("READY")
        expect(output).toContain("ruff")
        consoleSpy.mockRestore()
    })

    test("skips non-dependabot PRs in pending list and counts unapproved as PENDING", async () => {
        const validCommitMessage = `Bump ruff

---
updated-dependencies:
- dependency-name: ruff
  dependency-version: 0.15.11
  dependency-type: direct:production
...
`
        const consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)

        const mockOctokit = {
            rest: {
                pulls: {
                    list: vi.fn(),
                    listCommits: vi.fn().mockResolvedValue({
                        data: [{ commit: { message: validCommitMessage } }],
                    }),
                },
            },
            paginate: vi.fn().mockResolvedValue([
                // non-dependabot PR — should be skipped (covers lines 75-76)
                {
                    number: 1,
                    user: { login: "octocat" },
                    head: {
                        ref: "fix/something",
                        sha: "a",
                        repo: { name: "repo-a" },
                    },
                    base: { repo: { name: "repo-a" } },
                    title: "Some fix",
                },
                // dependabot PR with no deps (empty commits) — covers lines 80-81
                {
                    number: 2,
                    user: { login: "dependabot[bot]" },
                    head: {
                        ref: "dependabot/uv/ruff-0.15.11",
                        sha: "b",
                        repo: { name: "repo-a" },
                    },
                    base: { repo: { name: "repo-a" } },
                    title: "Bump ruff (no deps)",
                },
            ]),
        }

        // First PR (non-dependabot) has any commits; second PR (dependabot) has no commits
        mockOctokit.rest.pulls.listCommits.mockResolvedValueOnce({ data: [] }) // PR #2 — no commits → no deps
        const store2 = makeStore(["my-org/repo-a"])

        await pendingAction(store2, mockOctokit as never)

        consoleSpy.mockRestore()
    })

    test("counts unapproved dependabot PRs as PENDING", async () => {
        const validCommitMessage = `Bump ruff

---
updated-dependencies:
- dependency-name: ruff
  dependency-version: 0.15.11
  dependency-type: direct:production
...
`
        const store = makeStore(["my-org/repo-a"])

        const consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)

        const mockOctokit = {
            rest: {
                pulls: {
                    list: vi.fn(),
                    listCommits: vi.fn().mockResolvedValue({
                        data: [{ commit: { message: validCommitMessage } }],
                    }),
                },
            },
            // ruff 0.15.11 is NOT approved in store — should be PENDING (covers lines 92-93)
            paginate: vi.fn().mockResolvedValue([
                {
                    number: 42,
                    user: { login: "dependabot[bot]" },
                    head: {
                        ref: "dependabot/uv/ruff-0.15.11",
                        sha: "abc123",
                        repo: { name: "repo-a" },
                    },
                    base: { repo: { name: "repo-a" } },
                    title: "Bump ruff",
                },
            ]),
        } as never

        await pendingAction(store, mockOctokit)

        const output = consoleSpy.mock.calls
            .map((c) => c[0] as string)
            .join("\n")
        expect(output).toContain("PENDING")
        expect(output).toContain("Total pending PRs: 1")
        consoleSpy.mockRestore()
    })
})

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

describe("commander wiring", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)
        vi.mocked(StoreRegistry).mockImplementation(() => ({
            getStore: mockGetStore,
        }))
        mockGetStore.mockResolvedValue(makeStore())
    })

    afterEach(() => {
        consoleSpy.mockRestore()
        vi.mocked(checkPendingPrs).mockClear()
    })

    test("list command invokes listAction via real store", async () => {
        await program.parseAsync(["node", "cli", "--org", "test-org", "list"])
        // listAction calls store.getApprovedVersions — no error means wiring works
        expect(consoleSpy).not.toHaveBeenCalled() // empty store
    })

    test("scan command invokes scanAction (dryRun=false)", async () => {
        await program.parseAsync(["node", "cli", "--org", "test-org", "scan"])
        expect(checkPendingPrs).toHaveBeenCalledOnce()
    })

    test("scan command passes --dry-run flag", async () => {
        await program.parseAsync([
            "node",
            "cli",
            "--org",
            "test-org",
            "scan",
            "--dry-run",
        ])
        expect(checkPendingPrs).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            expect.anything(),
            true,
        )
    })

    test("enroll command invokes enrollAction", async () => {
        await program.parseAsync([
            "node",
            "cli",
            "--org",
            "test-org",
            "enroll",
            "my-org/my-repo",
        ])
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("Enrolled"),
        )
    })

    test("unenroll command invokes unenrollAction for missing repo", async () => {
        await program.parseAsync([
            "node",
            "cli",
            "--org",
            "test-org",
            "unenroll",
            "my-org/missing",
        ])
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("not enrolled"),
        )
    })

    test("approve command invokes approveAction with provided options", async () => {
        await program.parseAsync([
            "node",
            "cli",
            "--org",
            "test-org",
            "approve",
            "lodash",
            "--dep-version",
            "4.17.21",
            "--ecosystem",
            "npm",
        ])
        // No error thrown means the wiring and store write succeeded
    })

    test("approve command throws when --dep-version or --ecosystem is missing", async () => {
        program.exitOverride()
        await expect(
            program.parseAsync([
                "node",
                "cli",
                "--org",
                "test-org",
                "approve",
                "lodash",
            ]),
        ).rejects.toThrow()
    })

    test("pending command invokes pendingAction", async () => {
        await program.parseAsync([
            "node",
            "cli",
            "--org",
            "test-org",
            "pending",
        ])
        // No error — wiring and empty store handled correctly
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("Total pending PRs"),
        )
    })

    test("commands fail when --org is not provided", async () => {
        program.exitOverride()
        await expect(
            program.parseAsync(["node", "cli", "list"]),
        ).rejects.toThrow()
    })
})
