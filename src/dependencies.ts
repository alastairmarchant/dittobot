import type { ProbotOctokit } from "probot"
import { parse as parseYaml } from "yaml"
import {
    validate as validateVersion,
    compare,
    compareVersions,
} from "compare-versions"
import type { ApprovedVersions } from "./store.js"
import ApprovalStore, { getStoreProvider } from "./store.js"
import type { components as RestComponents } from "@octokit/openapi-types"
import type { components as WebhookComponents } from "@octokit/openapi-webhooks-types"

export type Dependency = {
    name: string
    version: string
    ecosystem: string
    type: "direct" | "indirect"
}

type WebhookPrPayload = WebhookComponents["schemas"][
    | "webhook-pull-request-opened"
    | "webhook-pull-request-reopened"
    | "webhook-pull-request-synchronize"
    | "webhook-pull-request-closed"
    | "webhook-pull-request-review-submitted"]["pull_request"]
type RestPrPayload = RestComponents["schemas"]["pull-request-simple"]
type PrPayload = WebhookPrPayload | RestPrPayload

type Repository =
    | WebhookComponents["schemas"]["repository-webhooks"]
    | RestComponents["schemas"]["full-repository"]

export const isDepedabotPr = (pr: PrPayload): boolean => {
    return (
        pr.user?.login === "dependabot[bot]" || pr.user?.login === "dependabot"
    )
}

type DependabotYamlData = {
    "updated-dependencies"?: {
        "dependency-name": string
        "dependency-version": string
        "dependency-type": "direct" | "indirect"
    }[]
}

export const extractPrDependencies = async (
    pr: PrPayload,
    octokit: ProbotOctokit,
    owner: string,
): Promise<Dependency[]> => {
    const branchName = pr.head.ref
    const commits = await octokit.rest.pulls.listCommits({
        owner,
        repo: pr.base.repo.name,
        pull_number: pr.number,
    })

    const firstCommitMessage = commits.data[0]?.commit.message
    if (!firstCommitMessage) {
        return []
    }

    const yamlFragment = /^-{3}\n(?<dependencies>[\S|\s]*?)\n^\.{3}\n/m.exec(
        firstCommitMessage,
    )

    const dependencies: Dependency[] = []

    if (yamlFragment?.groups && branchName.startsWith("dependabot")) {
        if (!yamlFragment.groups.dependencies) {
            return dependencies
        }

        const data = parseYaml(
            yamlFragment.groups.dependencies,
        ) as DependabotYamlData

        if (!data["updated-dependencies"]) {
            return dependencies
        }

        const delim = branchName[10]
        if (!delim) {
            return dependencies
        }

        const ecosystem = branchName.split(delim)[1]

        if (!ecosystem) {
            return dependencies
        }

        for (const dep of data["updated-dependencies"]) {
            dependencies.push({
                name: dep["dependency-name"],
                version: dep["dependency-version"],
                type: dep["dependency-type"],
                ecosystem,
            })
        }
    }

    return dependencies
}

export const versionIsApproved = (
    approvedVersions: ApprovedVersions,
    dep: Dependency,
): boolean => {
    const packageVersions = approvedVersions[dep.ecosystem]?.[dep.name]

    if (!packageVersions) {
        return false
    }

    if (packageVersions[dep.version]) {
        return true
    }

    if (!validateVersion(dep.version)) {
        return false
    }

    const maxApprovedVersion = Object.keys(packageVersions)
        .filter((v) => validateVersion(v))
        .sort(compareVersions)
        .pop()

    if (!maxApprovedVersion) {
        return false
    }

    if (compare(maxApprovedVersion, dep.version, ">=")) {
        return true
    }

    return false
}

const buildApprovalComment = (approvedDeps: Dependency[]): string => {
    // TODO: Link to approval store
    const approval_store_link = ""
    const lines = [
        "## :robot: Auto-approved by DittoBot\n",
        "All dependency versions in this PR have been previously reviewed and approved:\n",
    ]
    for (const dep of approvedDeps) {
        lines.push(`- \`${dep.name}\` -> \`${dep.version}\` (${dep.ecosystem})`)
    }

    lines.push(
        `\n---\n_This PR was automatically approved because these versions were manually reviewed in another repository. See the [approval store](${approval_store_link}) for details._`,
    )

    return lines.join("\n")
}

const approveAndMergePr = async (
    pr: PrPayload,
    octokit: ProbotOctokit,
    repository: Repository,
    dependencies: Dependency[],
    mergeStrategy: "squash" | "merge" | "rebase",
): Promise<boolean> => {
    const comment = buildApprovalComment(dependencies)

    try {
        await octokit.rest.pulls.createReview({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: pr.number,
            event: "APPROVE",
            body: comment,
        })

        await octokit.rest.pulls.merge({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: pr.number,
            merge_method: mergeStrategy,
        })

        return true
    } catch (error) {
        console.error("Error approving/merging PR:", error)
        return false
    }
}

export const checkPendingPrs = async (
    octokit: ProbotOctokit,
    owner: string,
    store: ApprovalStore,
    dryRun = false,
): Promise<void> => {
    const config = await store.getConfig()
    const repos = config.enrolledRepos
    const mergeStrategy = config.mergeStrategy
    const requireCi = config.requireCi

    const approvedVersions = await store.getApprovedVersions()

    for (const repo of repos) {
        const openPrs = await octokit.paginate(octokit.rest.pulls.list, {
            owner,
            repo,
            state: "open",
            per_page: 100,
        })

        for (const pr of openPrs) {
            if (!isDepedabotPr(pr)) {
                continue
            }

            const prDependencies = await extractPrDependencies(
                pr,
                octokit,
                owner,
            )

            if (prDependencies.length === 0) {
                continue
            }

            const allApproved = prDependencies.every((dep) =>
                versionIsApproved(approvedVersions, dep),
            )

            if (allApproved) {
                if (requireCi) {
                    const checks = await octokit.rest.checks.listForRef({
                        owner,
                        repo,
                        ref: pr.head.sha,
                    })

                    const ciChecks = checks.data.check_runs.filter(
                        (check) => check.app?.slug === "github-actions",
                    )

                    if (
                        ciChecks.length === 0 ||
                        ciChecks.some((check) => check.conclusion !== "success")
                    ) {
                        continue
                    }
                }

                const repoData = await octokit.rest.repos.get({
                    owner,
                    repo,
                })

                if (dryRun) {
                    console.log(
                        `Dry run: would approve and merge PR #${pr.number} in ${repo}`,
                    )
                    continue
                }

                //check merge state
                const prData = await octokit.rest.pulls.get({
                    owner,
                    repo,
                    pull_number: pr.number,
                })

                if (
                    !["clean", "blocked"].includes(
                        prData.data.mergeable_state,
                    ) ||
                    !prData.data.mergeable
                ) {
                    console.log(
                        `PR #${pr.number} in ${repo} cannot be merged, skipping`,
                    )
                    console.log(
                        `Mergeable state: ${prData.data.mergeable_state}, Mergeable: ${prData.data.mergeable}`,
                    )
                    continue
                }

                console.log(
                    `Approving and merging PR #${pr.number} in ${repo}...`,
                )

                const success = await approveAndMergePr(
                    pr,
                    octokit,
                    repoData.data,
                    prDependencies,
                    mergeStrategy,
                )

                if (success) {
                    // TODO: Log event
                }
            }
        }
    }
}

export const captureApproval = async (
    pr: PrPayload,
    octokit: ProbotOctokit,
    repository: Repository,
    user: string,
): Promise<void> => {
    const dependencies = await extractPrDependencies(
        pr,
        octokit,
        repository.owner.login,
    )

    if (dependencies.length === 0) {
        return
    }

    const storeProvider = getStoreProvider(octokit)
    const store = new ApprovalStore(storeProvider)

    const newlyApprovedDeps = []

    for (const dep of dependencies) {
        const newApproval = await store.approveVersion(
            dep,
            user,
            repository.full_name,
            pr.number,
        )
        if (newApproval) {
            newlyApprovedDeps.push(dep)
        }
    }

    if (newlyApprovedDeps.length > 0) {
        console.log(
            `Approved new versions: ${newlyApprovedDeps.map((d) => `${d.name}==${d.version} (${d.ecosystem})`).join(", ")}`,
        )
        await checkPendingPrs(octokit, repository.owner.login, store)
    }
}

export const checkPr = async (
    pr: PrPayload,
    octokit: ProbotOctokit,
    repository: Repository,
): Promise<void> => {
    if (!isDepedabotPr(pr)) {
        return
    }

    const dependencies = await extractPrDependencies(
        pr,
        octokit,
        repository.owner.login,
    )
    if (dependencies.length === 0) {
        return
    }

    const approvedDependencies = []
    const pendingDependencies = []

    const storeProvider = getStoreProvider(octokit)

    const store = new ApprovalStore(storeProvider)
    const approvedVersions = await store.getApprovedVersions()

    for (const dep of dependencies) {
        if (versionIsApproved(approvedVersions, dep)) {
            approvedDependencies.push(dep)
        } else {
            pendingDependencies.push(dep)
        }
    }

    if (pendingDependencies.length > 0) {
        return
    }

    const config = await store.getConfig()

    const success = await approveAndMergePr(
        pr,
        octokit,
        repository,
        dependencies,
        config.mergeStrategy,
    )

    if (!success) {
        // Handle failure (e.g. log, comment on PR, etc.)
    }
}
