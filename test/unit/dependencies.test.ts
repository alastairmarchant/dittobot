import { describe, test, expect, vi } from "vitest"

vi.mock("../../src/env.js", () => ({
    env: {
        STORE: { TYPE: "memory" },
        STRICT_VERSIONS: true,
    },
}))

import {
    isDependabotPr,
    extractPrDependencies,
    versionIsApproved,
    buildApprovalComment,
    checkPendingPrs,
    captureApproval,
    checkPr,
    type Dependency,
} from "../../src/dependencies.js"
import ApprovalStore, {
    MemoryVersionStoreProvider,
    createDefaultStoreConfig,
} from "../../src/store.js"
import type { ApprovedVersions } from "../../src/store.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeOctokit = (commits: { message: string }[]) => ({
    rest: {
        pulls: {
            listCommits: vi.fn().mockResolvedValue({
                data: commits.map((c) => ({ commit: { message: c.message } })),
            }),
        },
    },
})

const makePr = (branchRef = "dependabot/uv/ruff-0.15.11") => ({
    number: 1,
    head: { ref: branchRef },
    base: { repo: { name: "my-repo" } },
})

const validCommitMessage = `Bump ruff from 0.15.10 to 0.15.11

---
updated-dependencies:
- dependency-name: ruff
  dependency-version: 0.15.11
  dependency-type: direct:production
...
`

const makeVersions = (
    ecosystem: string,
    name: string,
    versions: string[],
): ApprovedVersions => {
    const result: ApprovedVersions = {}
    result[ecosystem] = {}
    result[ecosystem]![name] = {}
    for (const v of versions) {
        result[ecosystem]![name]![v] = {
            approvedAt: "2024-01-01T00:00:00Z",
            approvedBy: "user",
            sourceRepo: "org/repo",
            sourcePr: 1,
        }
    }
    return result
}

const dep = (name: string, version: string, ecosystem: string): Dependency => ({
    name,
    version,
    ecosystem,
    type: "direct" as const,
})

// ---------------------------------------------------------------------------
// isDependabotPr
// ---------------------------------------------------------------------------

describe("isDependabotPr", () => {
    test("dependabot[bot] login → true", () => {
        expect(
            isDependabotPr({ user: { login: "dependabot[bot]" } } as never),
        ).toBe(true)
    })

    test("dependabot login → true", () => {
        expect(isDependabotPr({ user: { login: "dependabot" } } as never)).toBe(
            true,
        )
    })

    test("other login → false", () => {
        expect(isDependabotPr({ user: { login: "octocat" } } as never)).toBe(
            false,
        )
    })

    test("null user → false", () => {
        expect(isDependabotPr({ user: null } as never)).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// extractPrDependencies
// ---------------------------------------------------------------------------

describe("extractPrDependencies", () => {
    test("valid commit message → correct Dependency[]", async () => {
        const octokit = makeOctokit([{ message: validCommitMessage }])
        const pr = makePr("dependabot/uv/ruff-0.15.11")
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )

        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
            name: "ruff",
            version: "0.15.11",
            ecosystem: "uv",
            type: "direct:production",
        })
    })

    test("no commits → []", async () => {
        const octokit = makeOctokit([])
        const pr = makePr()
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })

    test("commit message with no YAML block → []", async () => {
        const octokit = makeOctokit([
            { message: "just a regular commit message" },
        ])
        const pr = makePr()
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })

    test("branch name that does not start with 'dependabot' → []", async () => {
        const octokit = makeOctokit([{ message: validCommitMessage }])
        const pr = makePr("renovate/ruff-0.15.11")
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })

    test("empty updated-dependencies list in YAML → []", async () => {
        const message = `Bump something

---
updated-dependencies: []
...
`
        const octokit = makeOctokit([{ message }])
        const pr = makePr()
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })

    test("multiple dependencies in one commit message → all returned", async () => {
        const message = `Bump multiple

---
updated-dependencies:
- dependency-name: ruff
  dependency-version: 0.15.11
  dependency-type: direct:production
- dependency-name: black
  dependency-version: 24.0.0
  dependency-type: direct:development
...
`
        const octokit = makeOctokit([{ message }])
        const pr = makePr("dependabot/uv/multi-bump")
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )

        expect(result).toHaveLength(2)
        expect(result[0]).toMatchObject({
            name: "ruff",
            version: "0.15.11",
            ecosystem: "uv",
        })
        expect(result[1]).toMatchObject({
            name: "black",
            version: "24.0.0",
            ecosystem: "uv",
        })
    })

    test("YAML fragment group is empty string → []", async () => {
        // An empty line between --- and ... makes the regex match with dependencies=""
        const message = `Bump something

---

...
`
        const octokit = makeOctokit([{ message }])
        const pr = makePr("dependabot/uv/something")
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })

    test("YAML has no updated-dependencies key → []", async () => {
        const message = `Bump something

---
other-key: some-value
...
`
        const octokit = makeOctokit([{ message }])
        const pr = makePr("dependabot/uv/something")
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })

    test("branch name exactly 'dependabot' (no char at index 10) → []", async () => {
        const octokit = makeOctokit([{ message: validCommitMessage }])
        // 'dependabot' is exactly 10 chars; branchName[10] is undefined
        const pr = makePr("dependabot")
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })

    test("branch delimiter splits into empty ecosystem → []", async () => {
        const octokit = makeOctokit([{ message: validCommitMessage }])
        // 'dependabot/' has delimiter '/' at index 10; split('/')[1] = ''
        const pr = makePr("dependabot/")
        const result = await extractPrDependencies(
            pr as never,
            octokit as never,
            "my-org",
        )
        expect(result).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// versionIsApproved
// ---------------------------------------------------------------------------

describe("versionIsApproved", () => {
    test("exact version match → true", () => {
        const versions = makeVersions("uv", "ruff", ["0.15.11"])
        expect(versionIsApproved(versions, dep("ruff", "0.15.11", "uv"))).toBe(
            true,
        )
    })

    test("unknown ecosystem → false", () => {
        const versions = makeVersions("uv", "ruff", ["0.15.11"])
        expect(versionIsApproved(versions, dep("ruff", "0.15.11", "npm"))).toBe(
            false,
        )
    })

    test("unknown package → false", () => {
        const versions = makeVersions("uv", "ruff", ["0.15.11"])
        expect(versionIsApproved(versions, dep("black", "0.15.11", "uv"))).toBe(
            false,
        )
    })

    test("dep version <= max approved semver → true", () => {
        const versions = makeVersions("uv", "ruff", ["2.0.0"])
        expect(versionIsApproved(versions, dep("ruff", "1.5.0", "uv"))).toBe(
            true,
        )
    })

    test("dep version > max approved semver → false", () => {
        const versions = makeVersions("uv", "ruff", ["1.0.0"])
        expect(versionIsApproved(versions, dep("ruff", "2.0.0", "uv"))).toBe(
            false,
        )
    })

    test("invalid dep version string → false", () => {
        const versions = makeVersions("uv", "ruff", ["1.0.0"])
        expect(
            versionIsApproved(versions, dep("ruff", "not-a-version", "uv")),
        ).toBe(false)
    })

    test("non-semver approved version keys are filtered — dep version not matched → false", () => {
        const versions = makeVersions("uv", "ruff", ["not-a-semver"])
        expect(versionIsApproved(versions, dep("ruff", "1.0.0", "uv"))).toBe(
            false,
        )
    })

    test("multiple approved versions — uses maximum (dep <= max) → true", () => {
        const versions = makeVersions("uv", "ruff", ["1.0.0", "1.5.0", "2.0.0"])
        expect(versionIsApproved(versions, dep("ruff", "1.8.0", "uv"))).toBe(
            true,
        )
    })
})

// ---------------------------------------------------------------------------
// buildApprovalComment
// ---------------------------------------------------------------------------

describe("buildApprovalComment", () => {
    test("links each dependency to its approving PR", () => {
        const versions = makeVersions("uv", "ruff", ["0.15.11"])
        const comment = buildApprovalComment(
            [dep("ruff", "0.15.11", "uv")],
            versions,
            "",
        )
        expect(comment).toContain(
            "- `ruff` -> `0.15.11` (uv) — approved in [org/repo#1](https://github.com/org/repo/pull/1)",
        )
    })

    test("includes approval store link in footer when provided", () => {
        const versions = makeVersions("uv", "ruff", ["0.15.11"])
        const comment = buildApprovalComment(
            [dep("ruff", "0.15.11", "uv")],
            versions,
            "https://github.com/org/store",
        )
        expect(comment).toContain(
            "See the [approval store](https://github.com/org/store) for the full history._",
        )
    })

    test("omits the store link and provenance when no metadata or link is available", () => {
        const comment = buildApprovalComment(
            [dep("ruff", "0.15.11", "uv")],
            {},
            "",
        )
        expect(comment).toContain("- `ruff` -> `0.15.11` (uv)")
        expect(comment).not.toContain("approved in [")
        expect(comment).not.toContain("approval store")
    })
})

// ---------------------------------------------------------------------------
// checkPendingPrs
// ---------------------------------------------------------------------------

const memConfig = (requireCi: boolean) => ({
    org: "org",
    enrolledRepos: ["org/my-repo"],
    mergeStrategy: "squash" as const,
    requireCi,
})

const makeDepbotPr = (number = 42) => ({
    number,
    state: "open",
    user: { login: "dependabot[bot]" },
    head: {
        ref: "dependabot/uv/ruff-0.15.11",
        sha: "abc123",
        repo: { name: "my-repo" },
    },
    base: { repo: { name: "my-repo" } },
    title: "Bump ruff",
})

const makePendingOctokit = (overrides: Record<string, unknown> = {}) => ({
    paginate: vi.fn().mockResolvedValue([]),
    rest: {
        pulls: {
            list: vi.fn(),
            listCommits: vi.fn().mockResolvedValue({
                data: [{ commit: { message: validCommitMessage } }],
            }),
            get: vi.fn().mockResolvedValue({
                data: {
                    state: "open",
                    mergeable_state: "clean",
                    mergeable: true,
                },
            }),
            createReview: vi.fn().mockResolvedValue({}),
            merge: vi.fn().mockResolvedValue({}),
        },
        checks: {
            listForRef: vi.fn().mockResolvedValue({
                data: {
                    check_runs: [
                        {
                            app: { slug: "github-actions" },
                            conclusion: "success",
                        },
                    ],
                },
            }),
        },
        repos: {
            get: vi.fn().mockResolvedValue({
                data: { owner: { login: "org" }, name: "my-repo" },
            }),
        },
    },
    ...overrides,
})

const makeStoreWithRuff = async (requireCi: boolean) => {
    const provider = new MemoryVersionStoreProvider(memConfig(requireCi))
    await provider.addApprovedVersion(
        "ruff",
        "0.15.11",
        "uv",
        "user",
        "org/repo",
        1,
    )
    return new ApprovalStore(provider)
}

describe("checkPendingPrs", () => {
    test("skips non-dependabot PRs", async () => {
        const store = new ApprovalStore(
            new MemoryVersionStoreProvider(memConfig(false)),
        )
        const octokit = makePendingOctokit({
            paginate: vi
                .fn()
                .mockResolvedValue([
                    { ...makeDepbotPr(), user: { login: "renovate[bot]" } },
                ]),
        })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.listCommits).not.toHaveBeenCalled()
    })

    test("skips dependabot PRs with no extractable dependencies", async () => {
        const store = new ApprovalStore(
            new MemoryVersionStoreProvider(memConfig(false)),
        )
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })
        // Return no commits so extractPrDependencies returns []
        octokit.rest.pulls.listCommits.mockResolvedValue({ data: [] })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    })

    test("skips PRs where not all dependencies are approved", async () => {
        const store = new ApprovalStore(
            new MemoryVersionStoreProvider(memConfig(false)),
        )
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    })

    test("requireCi=true: skips when there are no CI check runs", async () => {
        const store = await makeStoreWithRuff(true)
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })
        octokit.rest.checks.listForRef.mockResolvedValue({
            data: { check_runs: [] },
        })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    })

    test("requireCi=true: skips when some CI checks did not succeed", async () => {
        const store = await makeStoreWithRuff(true)
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })
        octokit.rest.checks.listForRef.mockResolvedValue({
            data: {
                check_runs: [
                    {
                        app: { slug: "github-actions" },
                        conclusion: "failure",
                    },
                ],
            },
        })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    })

    test("dryRun=true: logs but does not approve or merge", async () => {
        const store = await makeStoreWithRuff(false)
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })
        const consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)

        await checkPendingPrs(octokit as never, "org", store, true)

        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("Dry run"),
        )
        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
        consoleSpy.mockRestore()
    })

    test("skips PR that is not mergeable", async () => {
        const store = await makeStoreWithRuff(false)
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })
        octokit.rest.pulls.get.mockResolvedValue({
            data: { mergeable_state: "dirty", mergeable: false },
        })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    })

    test("skips PR that is not open", async () => {
        const store = await makeStoreWithRuff(false)
        const octokit = makePendingOctokit({
            paginate: vi
                .fn()
                .mockResolvedValue([{ ...makeDepbotPr(), state: "closed" }]),
        })
        const consoleSpy = vi
            .spyOn(console, "log")
            .mockImplementation(() => undefined)

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("is not open"),
        )
        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
        consoleSpy.mockRestore()
    })

    test("skips PR that was closed during processing", async () => {
        const store = await makeStoreWithRuff(false)
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })
        octokit.rest.pulls.get.mockResolvedValue({
            data: {
                state: "closed",
                mergeable_state: "clean",
                mergeable: true,
            },
        })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    })

    test("approves and merges PR when all conditions met", async () => {
        const store = await makeStoreWithRuff(false)
        const octokit = makePendingOctokit({
            paginate: vi.fn().mockResolvedValue([makeDepbotPr()]),
        })

        await checkPendingPrs(octokit as never, "org", store, false)

        expect(octokit.rest.pulls.createReview).toHaveBeenCalledOnce()
        expect(octokit.rest.pulls.merge).toHaveBeenCalledOnce()
    })
})

// ---------------------------------------------------------------------------
// captureApproval
// ---------------------------------------------------------------------------

describe("captureApproval", () => {
    const makeRepo = (org = "org") => ({
        owner: { login: org },
        name: "my-repo",
        full_name: `${org}/my-repo`,
    })

    const makeOctokitNoCommits = () => ({
        rest: {
            pulls: {
                listCommits: vi.fn().mockResolvedValue({ data: [] }),
            },
        },
    })

    const makePr = () => ({
        number: 1,
        user: { login: "dependabot[bot]" },
        head: { ref: "dependabot/uv/ruff-0.15.11", repo: { name: "my-repo" } },
        base: { repo: { name: "my-repo" } },
    })

    test("returns early when repo is not enrolled", async () => {
        const store = new ApprovalStore(
            new MemoryVersionStoreProvider(createDefaultStoreConfig("org")),
        )

        await captureApproval(
            makePr() as never,
            makeOctokitNoCommits() as never,
            makeRepo() as never,
            "user",
            store,
        )
        // No listCommits call because repo not enrolled
        expect(
            makeOctokitNoCommits().rest.pulls.listCommits as ReturnType<
                typeof vi.fn
            >,
        ).not.toHaveBeenCalled()
    })

    test("returns early when no dependencies can be extracted (repo enrolled, empty commits)", async () => {
        const provider = new MemoryVersionStoreProvider({
            ...createDefaultStoreConfig("org"),
            enrolledRepos: ["my-repo"],
        })
        const store = new ApprovalStore(provider)
        const octokit = makeOctokitNoCommits()

        await captureApproval(
            makePr() as never,
            octokit as never,
            makeRepo() as never,
            "user",
            store,
        )
        // listCommits was called but returned no commits
        expect(octokit.rest.pulls.listCommits).toHaveBeenCalledOnce()
    })
})

// ---------------------------------------------------------------------------
// checkPr
// ---------------------------------------------------------------------------

describe("checkPr", () => {
    const makeRepo = () => ({
        owner: { login: "org" },
        name: "my-repo",
        full_name: "org/my-repo",
    })

    const makeCheckOctokit = () => ({
        rest: {
            pulls: {
                listCommits: vi.fn().mockResolvedValue({
                    data: [{ commit: { message: validCommitMessage } }],
                }),
                createReview: vi.fn().mockResolvedValue({}),
                merge: vi.fn().mockResolvedValue({}),
            },
        },
    })

    const makeStore = (enrolledRepos: string[] = []) =>
        new ApprovalStore(
            new MemoryVersionStoreProvider({
                ...createDefaultStoreConfig("org"),
                enrolledRepos,
            }),
        )

    test("returns early when PR is not from dependabot", async () => {
        const octokit = makeCheckOctokit()
        const store = makeStore()
        const pr = {
            number: 1,
            user: { login: "octocat" },
            head: { ref: "main", repo: { name: "my-repo" } },
            base: { repo: { name: "my-repo" } },
        }

        await checkPr(pr as never, octokit as never, makeRepo() as never, store)

        expect(octokit.rest.pulls.listCommits).not.toHaveBeenCalled()
    })

    test("returns early when no dependencies are extractable", async () => {
        const octokit = makeCheckOctokit()
        octokit.rest.pulls.listCommits.mockResolvedValue({ data: [] })
        const store = makeStore(["my-repo"])
        const pr = {
            number: 1,
            state: "open",
            user: { login: "dependabot[bot]" },
            head: {
                ref: "dependabot/uv/ruff-0.15.11",
                repo: { name: "my-repo" },
            },
            base: { repo: { name: "my-repo" } },
        }

        await checkPr(pr as never, octokit as never, makeRepo() as never, store)

        expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    })

    test("returns early when repo is not enrolled", async () => {
        const octokit = makeCheckOctokit()
        const store = makeStore([]) // my-repo not enrolled
        const pr = {
            number: 1,
            state: "open",
            user: { login: "dependabot[bot]" },
            head: {
                ref: "dependabot/uv/ruff-0.15.11",
                repo: { name: "my-repo" },
            },
            base: { repo: { name: "my-repo" } },
        }

        await checkPr(pr as never, octokit as never, makeRepo() as never, store)

        expect(octokit.rest.pulls.listCommits).not.toHaveBeenCalled()
    })

    test("returns early when PR is not open", async () => {
        const octokit = makeCheckOctokit()
        const store = makeStore(["my-repo"])
        const pr = {
            number: 1,
            state: "closed",
            user: { login: "dependabot[bot]" },
            head: {
                ref: "dependabot/uv/ruff-0.15.11",
                repo: { name: "my-repo" },
            },
            base: { repo: { name: "my-repo" } },
        }

        await checkPr(pr as never, octokit as never, makeRepo() as never, store)

        expect(octokit.rest.pulls.listCommits).not.toHaveBeenCalled()
    })
})
