import nock from "nock"
import { Probot, ProbotOctokit } from "probot"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, beforeEach, afterEach, test, expect, vi } from "vitest"

import dittobotApp from "../src/index.js"

import prOpenedPayload from "./fixtures/pull_request.opened.json" with { type: "json" }
import prReopenedPayload from "./fixtures/pull_request.reopened.json" with { type: "json" }
import prSynchronizePayload from "./fixtures/pull_request.synchronize.json" with { type: "json" }
import prClosedPayload from "./fixtures/pull_request.closed.json" with { type: "json" }
import prReviewSubmittedPayload from "./fixtures/pull_request_review.submitted.json" with { type: "json" }
import checkSuiteCompletedPayload from "./fixtures/check_suite.completed.json" with { type: "json" }
import ApprovalStore from "../src/store.js"
import type { MemoryVersionStoreProvider } from "../src/store.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const privateKey = fs.readFileSync(
    path.join(__dirname, "fixtures/mock-cert.pem"),
    "utf-8",
)

const dependabotCommitMessage = `build(deps-dev): bump the dev group across 1 directory with 1 update


Updates \`ruff\` from 0.15.10 to 0.15.11
- [Release notes](https://github.com/astral-sh/ruff/releases)
- [Changelog](https://github.com/astral-sh/ruff/blob/master/CHANGELOG.md)
- [Commits](https://github.com/astral-sh/ruff/compare/v0.15.10...v0.15.11)

---
updated-dependencies:
- dependency-name: ruff
  dependency-version: 0.15.11
  dependency-type: direct:production
  update-type: version-update:semver-minor
  dependency-group: uv-production
...

Signed-off-by: dependabot[bot] <support@github.com>`

let mockStoreProvider: MemoryVersionStoreProvider

const deepClone = <T>(obj: T): T => {
    return JSON.parse(JSON.stringify(obj)) as T
}

vi.mock("../src/store.js", async () => {
    const store =
        await vi.importActual<typeof import("../src/store.js")>(
            "../src/store.js",
        )
    return {
        ...store,
        getStoreProvider: vi.fn().mockImplementation(() => {
            const provider = new store.MemoryVersionStoreProvider({
                TYPE: "memory",
                ORG: "octocat",
                ENROLLED_REPOS: ["octocat/Hello-World", "octocat/Another-Repo"],
                MERGE_STRATEGY: "squash",
                REQUIRE_CI: true,
            })

            provider.addApprovedVersion(
                "ruff",
                "0.15.11",
                "uv",
                "octocat",
                "octocat/Hello-World",
                28,
            )

            mockStoreProvider = provider

            return provider
        }),
    }
})

describe("DittoBot app", () => {
    let probot: Probot

    beforeEach(async () => {
        nock.disableNetConnect()
        probot = new Probot({
            appId: 123,
            privateKey,
            // disable request throttling and retries for testing
            Octokit: ProbotOctokit.defaults((instanceOptions: object) => ({
                ...instanceOptions,
                retry: { enabled: false },
                throttle: { enabled: false },
            })),
        })
        // Load our app into probot
        await probot.load(dittobotApp)
    })

    test.each([
        ["pull_request.opened", prOpenedPayload],
        ["pull_request.reopened", prReopenedPayload],
        ["pull_request.synchronize", prSynchronizePayload],
        ["pull_request.closed", prClosedPayload],
    ])(
        "Skips non-dependabot pull requests for event %s",
        async (event, payload) => {
            payload = deepClone(payload)
            payload.pull_request.user.login = "octocat"
            const mock = nock("https://api.github.com")

            await probot.receive({ name: event, payload })

            expect(mock.pendingMocks()).toStrictEqual([])
        },
    )

    test("Skips dependabot pull requests closed by bots", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(prClosedPayload)
        payload.pull_request.user.login = "dependabot[bot]"
        payload.sender.type = "Bot"

        await probot.receive({ name: "pull_request.closed", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Skips dependabot pull requests approved by bots", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(prReviewSubmittedPayload)
        payload.pull_request.user.login = "dependabot[bot]"
        payload.sender.type = "Bot"

        await probot.receive({ name: "pull_request_review.submitted", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test.each([
        ["pull_request.opened", prOpenedPayload],
        ["pull_request.reopened", prReopenedPayload],
        ["pull_request.synchronize", prSynchronizePayload],
    ])(
        "Merges and creates a comment on %s with approved dependencies",
        async (event, payload) => {
            const mock = nock("https://api.github.com")
                .post("/app/installations/1/access_tokens")
                .reply(200, {
                    token: "test",
                    permissions: {
                        pull_requests: "write",
                    },
                })
                .get("/repos/octocat/Team%20Environment/pulls/42/commits")
                .reply(200, [
                    {
                        sha: "abc123",
                        commit: {
                            message: dependabotCommitMessage,
                        },
                    },
                ])

                // Test that a comment is posted
                .post(
                    "/repos/octocat/Team%20Environment/pulls/42/reviews",
                    (body: object) => {
                        expect(body).toMatchObject({
                            body: `## :robot: Auto-approved by DittoBot

All dependency versions in this PR have been previously reviewed and approved:

- \`ruff\` -> \`0.15.11\` (uv)

---
_This PR was automatically approved because these versions were manually reviewed in another repository. See the [approval store]() for details._`,
                            event: "APPROVE",
                        })
                        return true
                    },
                )
                .reply(200)
                .put("/repos/octocat/Team%20Environment/pulls/42/merge")
                .reply(200)

            await probot.receive({ name: "pull_request", payload })

            expect(mock.pendingMocks()).toStrictEqual([])
        },
    )

    test("Ignores merged PR when version is already approved", async () => {
        const mock = nock("https://api.github.com")
            .post("/app/installations/1/access_tokens")
            .reply(200, {
                token: "test",
                permissions: {
                    pull_requests: "write",
                },
            })
            .get("/repos/octocat/Team%20Environment/pulls/42/commits")
            .reply(200, [
                {
                    sha: "abc123",
                    commit: {
                        message: dependabotCommitMessage,
                    },
                },
            ])

        await probot.receive({ name: "pull_request", payload: prClosedPayload })

        expect(mock.pendingMocks()).toStrictEqual([])

        const store = new ApprovalStore(mockStoreProvider)

        expect(await store.getApprovedVersions()).toMatchObject({
            uv: {
                ruff: {
                    "0.15.11": {
                        approvedBy: "octocat",
                        approvedAt: expect.toSatisfy(
                            (date: string) => !isNaN(Date.parse(date)),
                        ),
                        sourceRepo: "octocat/Hello-World",
                        sourcePr: 28,
                    },
                },
            },
        })
    })

    test("Approves dependency version when PR is merged", async () => {
        const mock = nock("https://api.github.com")
            .post("/app/installations/1/access_tokens")
            .reply(200, {
                token: "test",
                permissions: {
                    pull_requests: "write",
                },
            })
            .get("/repos/octocat/Team%20Environment/pulls/42/commits")
            .reply(200, [
                {
                    sha: "abc123",
                    commit: {
                        message: dependabotCommitMessage
                            .replace(/0\.15\.11/g, "0.15.12")
                            .replace(/0\.15\.10/g, "0.15.11"),
                    },
                },
            ])
            .get(
                "/repos/octocat/octocat%2FHello-World/pulls?state=open&per_page=100",
            )
            .reply(200, [])
            .get(
                "/repos/octocat/octocat%2FAnother-Repo/pulls?state=open&per_page=100",
            )
            .reply(200, [])

        await probot.receive({ name: "pull_request", payload: prClosedPayload })

        expect(mock.pendingMocks()).toStrictEqual([])

        expect(await mockStoreProvider.getApprovedVersions()).toMatchObject({
            uv: {
                ruff: {
                    "0.15.11": {
                        approvedBy: "octocat",
                        approvedAt: expect.toSatisfy(
                            (date: string) => !isNaN(Date.parse(date)),
                        ),
                        sourceRepo: "octocat/Hello-World",
                        sourcePr: 28,
                    },
                    "0.15.12": {
                        approvedBy: "octocat",
                        approvedAt: expect.toSatisfy(
                            (date: string) => !isNaN(Date.parse(date)),
                        ),
                        sourceRepo: "octocat/Hello-World",
                        sourcePr: 42,
                    },
                },
            },
        })
    })

    test("Merges and stores approval when PR is approved", async () => {
        const mock = nock("https://api.github.com")
            .post("/app/installations/1/access_tokens")
            .reply(200, {
                token: "test",
                permissions: {
                    pull_requests: "write",
                },
            })
            .get("/repos/octocat/Team%20Environment/pulls/42/commits")
            .reply(200, [
                {
                    sha: "abc123",
                    commit: {
                        message: dependabotCommitMessage
                            .replace(/0\.15\.11/g, "0.15.12")
                            .replace(/0\.15\.10/g, "0.15.11"),
                    },
                },
            ])
            .get(
                "/repos/octocat/octocat%2FHello-World/pulls?state=open&per_page=100",
            )
            .reply(200, [])
            .get(
                "/repos/octocat/octocat%2FAnother-Repo/pulls?state=open&per_page=100",
            )
            .reply(200, [])

        await probot.receive({
            name: "pull_request_review",
            payload: prReviewSubmittedPayload,
        })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Merges and stores approval when PR is approved, no user", async () => {
        const mock = nock("https://api.github.com")
            .post("/app/installations/1/access_tokens")
            .reply(200, {
                token: "test",
                permissions: {
                    pull_requests: "write",
                },
            })
            .get("/repos/octocat/Team%20Environment/pulls/42/commits")
            .reply(200, [
                {
                    sha: "abc123",
                    commit: {
                        message: dependabotCommitMessage
                            .replace(/0\.15\.11/g, "0.15.12")
                            .replace(/0\.15\.10/g, "0.15.11"),
                    },
                },
            ])
            .get(
                "/repos/octocat/octocat%2FHello-World/pulls?state=open&per_page=100",
            )
            .reply(200, [])
            .get(
                "/repos/octocat/octocat%2FAnother-Repo/pulls?state=open&per_page=100",
            )
            .reply(200, [])

        const payload = deepClone(prReviewSubmittedPayload)
        delete payload.review.user
        await probot.receive({ name: "pull_request_review", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Skips PR review not approved", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(prReviewSubmittedPayload)
        payload.review.state = "changes_requested"
        await probot.receive({ name: "pull_request_review", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Skips PR review when reviewed by bot", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(prReviewSubmittedPayload)
        payload.sender.type = "Bot"
        await probot.receive({ name: "pull_request_review", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Skips PR review when PR not created by dependabot", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(prReviewSubmittedPayload)
        payload.pull_request.user.login = "octocat"
        await probot.receive({ name: "pull_request_review", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Merges and creates a comment on check_suite.completed with approved dependencies", async () => {
        const mock = nock("https://api.github.com")
            .post("/app/installations/1/access_tokens")
            .reply(200, {
                token: "test",
                permissions: {
                    pull_requests: "write",
                },
            })
            .get("/repos/octocat/Team%20Environment/pulls/42")
            .reply(200, {
                number: 42,
                user: {
                    login: "dependabot[bot]",
                },
                head: {
                    sha: "abc123",
                    ref: "dependabot/uv/ruff-0.15.12",
                    repo: {
                        name: "Team Environment",
                    },
                },
                base: {
                    sha: "xyz789",
                    ref: "main",
                    repo: {
                        name: "Team Environment",
                    },
                },
            })
            .get("/repos/octocat/Team%20Environment/pulls/42/commits")
            .reply(200, [
                {
                    sha: "abc123",
                    commit: {
                        message: dependabotCommitMessage,
                    },
                },
            ])

            // Test that a comment is posted
            .post(
                "/repos/octocat/Team%20Environment/pulls/42/reviews",
                (body: object) => {
                    expect(body).toMatchObject({
                        body: `## :robot: Auto-approved by DittoBot

All dependency versions in this PR have been previously reviewed and approved:

- \`ruff\` -> \`0.15.11\` (uv)

---
_This PR was automatically approved because these versions were manually reviewed in another repository. See the [approval store]() for details._`,
                        event: "APPROVE",
                    })
                    return true
                },
            )
            .reply(200)
            .put("/repos/octocat/Team%20Environment/pulls/42/merge")
            .reply(200)

        await probot.receive({
            name: "check_suite",
            payload: checkSuiteCompletedPayload,
        })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Skips check_suite.completed when PR not found", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(checkSuiteCompletedPayload)
        payload.check_suite.pull_requests = []
        await probot.receive({ id: "1", name: "check_suite", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("Skips check_suite.completed when not a dependabot PR", async () => {
        const mock = nock("https://api.github.com")
            .post("/app/installations/1/access_tokens")
            .reply(200, {
                token: "test",
                permissions: {
                    pull_requests: "write",
                },
            })
            .get("/repos/octocat/Team%20Environment/pulls/42")
            .reply(200, {
                number: 42,
                user: {
                    login: "octocat",
                },
                head: {
                    sha: "abc123",
                    ref: "dependabot/uv/ruff-0.15.12",
                    repo: {
                        name: "Team Environment",
                    },
                },
                base: {
                    sha: "xyz789",
                    ref: "main",
                    repo: {
                        name: "Team Environment",
                    },
                },
            })

        await probot.receive({
            name: "check_suite",
            payload: checkSuiteCompletedPayload,
        })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    afterEach(() => {
        nock.cleanAll()
        nock.enableNetConnect()
    })
})

// For more information about testing with Jest see:
// https://facebook.github.io/jest/

// For more information about using TypeScript in your tests, Jest recommends:
// https://github.com/kulshekhar/ts-jest

// For more information about testing with Nock see:
// https://github.com/nock/nock
