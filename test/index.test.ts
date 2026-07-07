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
import { MemoryVersionStoreProvider } from "../src/store.js"
import { StoreRegistry } from "../src/registry.js"

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

const twoDepCommitMessage = `build(deps-dev): bump the dev group across 1 directory with 2 updates

---
updated-dependencies:
- dependency-name: ruff
  dependency-version: 0.15.11
  dependency-type: direct:production
- dependency-name: black
  dependency-version: 23.1.0
  dependency-type: direct:production
...

Signed-off-by: dependabot[bot] <support@github.com>`

const deepClone = <T>(obj: T): T => {
    return JSON.parse(JSON.stringify(obj)) as T
}

// ---------------------------------------------------------------------------
// StoreRegistry mock
// ---------------------------------------------------------------------------

const mockGetStore = vi.fn()

vi.mock("../src/registry.js", () => ({
    StoreRegistry: vi.fn(function () {
        return { getStore: mockGetStore }
    }),
}))

describe("DittoBot app", () => {
    let probot: Probot
    let mockStoreProvider: MemoryVersionStoreProvider

    beforeEach(async () => {
        vi.mocked(StoreRegistry).mockImplementation(function () {
            return { getStore: mockGetStore }
        })

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

        // Create a fresh store for each test
        mockStoreProvider = new MemoryVersionStoreProvider({
            enrolledRepos: ["Team Environment", "Another-Repo"],
            mergeStrategy: "squash",
            requireCi: false,
        })
        // Pre-load ruff 0.15.11 for tests that need it
        await mockStoreProvider.addApprovedVersion(
            "ruff",
            "0.15.11",
            "uv",
            "octocat",
            "octocat/Hello-World",
            28,
        )
        mockGetStore.mockResolvedValue(new ApprovalStore(mockStoreProvider))
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

    test("Skips dependabot pull requests closed without merging", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(prClosedPayload)
        payload.pull_request.user.login = "dependabot[bot]"
        payload.pull_request.merged = false

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
        "auto-merges and posts approval comment on %s when all versions are pre-approved",
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
                .get("/repos/octocat/Team%20Environment/pulls/42")
                .reply(200, {
                    state: "open",
                    mergeable_state: "clean",
                    mergeable: true,
                })

                // Test that a comment is posted
                .post(
                    "/repos/octocat/Team%20Environment/pulls/42/reviews",
                    (body: object) => {
                        expect(body).toMatchObject({
                            body: `## :robot: Auto-approved by DittoBot

All dependency versions in this PR were reviewed and approved:

- \`ruff\` -> \`0.15.11\` (uv) — approved in [octocat/Hello-World#28](https://github.com/octocat/Hello-World/pull/28)

---
_Automatically approved by DittoBot based on prior manual reviews._`,
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

    test("does not re-approve ruff when version 0.15.11 is already in the store", async () => {
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

    test("stores new approved version when merged PR contains unapproved version", async () => {
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
                "/repos/octocat/Team%20Environment/pulls?state=open&per_page=100",
            )
            .reply(200, [])
            .get("/repos/octocat/Another-Repo/pulls?state=open&per_page=100")
            .reply(200, [])

        await probot.receive({ name: "pull_request", payload: prClosedPayload })

        expect(mock.pendingMocks()).toStrictEqual([])

        const versions = await mockStoreProvider.getApprovedVersions()
        expect(versions.uv?.ruff?.["0.15.12"]).toBeDefined()
        expect(versions.uv?.ruff?.["0.15.12"]?.approvedBy).toBe("octocat")

        expect(versions).toMatchObject({
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
                "/repos/octocat/Team%20Environment/pulls?state=open&per_page=100",
            )
            .reply(200, [])
            .get("/repos/octocat/Another-Repo/pulls?state=open&per_page=100")
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
                "/repos/octocat/Team%20Environment/pulls?state=open&per_page=100",
            )
            .reply(200, [])
            .get("/repos/octocat/Another-Repo/pulls?state=open&per_page=100")
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

    test("auto-merges on check_suite.completed when all versions are approved", async () => {
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
                state: "open",
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
            .get("/repos/octocat/Team%20Environment/pulls/42")
            .reply(200, {
                state: "open",
                mergeable_state: "clean",
                mergeable: true,
            })

            // Test that a comment is posted
            .post(
                "/repos/octocat/Team%20Environment/pulls/42/reviews",
                (body: object) => {
                    expect(body).toMatchObject({
                        body: `## :robot: Auto-approved by DittoBot

All dependency versions in this PR were reviewed and approved:

- \`ruff\` -> \`0.15.11\` (uv) — approved in [octocat/Hello-World#28](https://github.com/octocat/Hello-World/pull/28)

---
_Automatically approved by DittoBot based on prior manual reviews._`,
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

    test("Skips check_suite.completed when branch does not start with dependabot/", async () => {
        const mock = nock("https://api.github.com")

        const payload = deepClone(checkSuiteCompletedPayload)
        payload.check_suite.pull_requests[0]!.head.ref = "feature/some-work"

        await probot.receive({ name: "check_suite", payload })

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

    test("does not auto-merge when only some dependencies are approved", async () => {
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
                        message: twoDepCommitMessage,
                    },
                },
            ])

        await probot.receive({ name: "pull_request", payload: prOpenedPayload })

        // No review or merge should be called
        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("does not throw when GitHub API returns 500 on merge", async () => {
        nock("https://api.github.com")
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
            .get("/repos/octocat/Team%20Environment/pulls/42")
            .reply(200, {
                state: "open",
                mergeable_state: "clean",
                mergeable: true,
            })
            .post("/repos/octocat/Team%20Environment/pulls/42/reviews")
            .reply(500, { message: "Internal Server Error" })

        await expect(
            probot.receive({ name: "pull_request", payload: prOpenedPayload }),
        ).resolves.not.toThrow()
    })

    test("skips check_suite.completed when conclusion is not success", async () => {
        const payload = deepClone(checkSuiteCompletedPayload)
        payload.check_suite.conclusion = "failure"

        const mock = nock("https://api.github.com")

        await probot.receive({ name: "check_suite", payload })

        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("installation.created bootstraps the store for the new org", async () => {
        const mock = nock("https://api.github.com")

        const payload = {
            action: "created",
            installation: {
                id: 2,
                node_id: "MDQ6VXNlcjU4MzIzMw==",
                account: {
                    login: "new-org",
                    id: 999,
                    node_id: "MDQ6VXNlcjU4MzIzMw==",
                    avatar_url: "",
                    gravatar_id: "",
                    url: "",
                    html_url: "",
                    followers_url: "",
                    following_url: "",
                    gists_url: "",
                    starred_url: "",
                    subscriptions_url: "",
                    organizations_url: "",
                    repos_url: "",
                    events_url: "",
                    received_events_url: "",
                    type: "Organization",
                    site_admin: false,
                },
                app_id: 123,
                app_slug: "dittobot",
                target_id: 999,
                target_type: "Organization",
                permissions: {},
                events: [],
                created_at: "2024-01-01T00:00:00Z",
                updated_at: "2024-01-01T00:00:00Z",
                single_file_name: null,
                has_multiple_single_files: false,
                single_file_paths: [],
                repository_selection: "all",
                access_tokens_url: "",
                repositories_url: "",
                html_url: "",
                suspended_by: null,
                suspended_at: null,
            },
            repositories: [],
            sender: {
                login: "new-org",
                id: 999,
                node_id: "MDQ6VXNlcjU4MzIzMw==",
                avatar_url: "",
                gravatar_id: "",
                url: "",
                html_url: "",
                followers_url: "",
                following_url: "",
                gists_url: "",
                starred_url: "",
                subscriptions_url: "",
                organizations_url: "",
                repos_url: "",
                events_url: "",
                received_events_url: "",
                type: "User",
                site_admin: false,
            },
        }

        await probot.receive({
            name: "installation",
            payload: payload as never,
        })

        expect(mockGetStore).toHaveBeenCalledWith("new-org", expect.anything())
        expect(mock.pendingMocks()).toStrictEqual([])
    })

    test("installation.created skips when account has no login", async () => {
        const mock = nock("https://api.github.com")

        const payload = {
            action: "created",
            installation: {
                id: 3,
                node_id: "MDQ6VXNlcjU4MzIzNA==",
                account: {} as never,
                app_id: 123,
                app_slug: "dittobot",
                target_id: 888,
                target_type: "Organization",
                permissions: {},
                events: [],
                created_at: "2024-01-01T00:00:00Z",
                updated_at: "2024-01-01T00:00:00Z",
                single_file_name: null,
                has_multiple_single_files: false,
                single_file_paths: [],
                repository_selection: "all",
                access_tokens_url: "",
                repositories_url: "",
                html_url: "",
                suspended_by: null,
                suspended_at: null,
            },
            repositories: [],
            sender: {
                login: "someone",
                id: 888,
                node_id: "MDQ6VXNlcjU4MzIzNA==",
                avatar_url: "",
                gravatar_id: "",
                url: "",
                html_url: "",
                followers_url: "",
                following_url: "",
                gists_url: "",
                starred_url: "",
                subscriptions_url: "",
                organizations_url: "",
                repos_url: "",
                events_url: "",
                received_events_url: "",
                type: "User",
                site_admin: false,
            },
        }

        await probot.receive({
            name: "installation",
            payload: payload as never,
        })

        expect(mockGetStore).not.toHaveBeenCalled()
        expect(mock.pendingMocks()).toStrictEqual([])
    })

    afterEach(() => {
        nock.cleanAll()
        nock.enableNetConnect()
        vi.resetAllMocks()
    })
})
