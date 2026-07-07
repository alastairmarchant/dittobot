import type { ProbotOctokit } from "probot"
import { parse as parseYaml } from "yaml"
import {
    validate as validateVersion,
    compare,
    compareVersions,
} from "compare-versions"
import type { ApprovedVersions, ApprovedVersionMetadata } from "./store.js"
import ApprovalStore from "./store.js"
import type { components as RestComponents } from "@octokit/openapi-types"
import type { components as WebhookComponents } from "@octokit/openapi-webhooks-types"

export type Dependency = {
    name: string
    version: string
    ecosystem: string
    type: string
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

export const isDependabotPr = (pr: PrPayload): boolean => {
    return (
        pr.user?.login === "dependabot[bot]" || pr.user?.login === "dependabot"
    )
}

type DependabotYamlData = {
    "updated-dependencies"?: {
        "dependency-name": string
        "dependency-version": string
        "dependency-type": string
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

export const getApprovalMetadata = (
    approvedVersions: ApprovedVersions,
    dep: Dependency,
): ApprovedVersionMetadata | undefined => {
    const packageVersions = approvedVersions[dep.ecosystem]?.[dep.name]

    if (!packageVersions) {
        return undefined
    }

    if (packageVersions[dep.version]) {
        return packageVersions[dep.version]
    }

    if (!validateVersion(dep.version)) {
        return undefined
    }

    const maxApprovedVersion = Object.keys(packageVersions)
        .filter((v) => validateVersion(v))
        .sort(compareVersions)
        .pop()

    if (!maxApprovedVersion) {
        return undefined
    }

    if (compare(maxApprovedVersion, dep.version, ">=")) {
        return packageVersions[maxApprovedVersion]
    }

    return undefined
}

export const versionIsApproved = (
    approvedVersions: ApprovedVersions,
    dep: Dependency,
): boolean => {
    return getApprovalMetadata(approvedVersions, dep) !== undefined
}

export const buildApprovalComment = (
    approvedDeps: Dependency[],
    approvedVersions: ApprovedVersions,
    approvalStoreLink: string,
): string => {
    const lines = [
        "## :robot: Auto-approved by DittoBot\n",
        "All dependency versions in this PR were previously reviewed and approved:\n",
    ]
    for (const dep of approvedDeps) {
        let line = `- \`${dep.name}\` -> \`${dep.version}\` (${dep.ecosystem})`
        const metadata = getApprovalMetadata(approvedVersions, dep)
        if (metadata) {
            line += ` — approved in [${metadata.sourceRepo}#${metadata.sourcePr}](https://github.com/${metadata.sourceRepo}/pull/${metadata.sourcePr})`
        }
        lines.push(line)
    }

    const footer = approvalStoreLink
        ? `\n---\n_Automatically approved by DittoBot based on prior manual reviews. See the [approval store](${approvalStoreLink}) for the full history._`
        : `\n---\n_Automatically approved by DittoBot based on prior manual reviews._`
    lines.push(footer)

    return lines.join("\n")
}

const approveAndMergePr = async (
    pr: PrPayload,
    octokit: ProbotOctokit,
    repository: Repository,
    dependencies: Dependency[],
    mergeStrategy: "squash" | "merge" | "rebase",
    approvedVersions: ApprovedVersions,
    approvalStoreLink: string,
): Promise<boolean> => {
    const comment = buildApprovalComment(
        dependencies,
        approvedVersions,
        approvalStoreLink,
    )

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

export const prReadyToMerge = async (
    pr: PrPayload,
    octokit: ProbotOctokit,
    repo: string,
    owner: string,
    approvedVersions: ApprovedVersions,
    prDependencies: Dependency[],
    requireCi: boolean,
): Promise<boolean> => {
    if (pr.state !== "open") {
        console.log(`PR #${pr.number} in ${repo} is not open, skipping`)
        return false
    }

    if (prDependencies.length === 0) {
        console.log(`PR #${pr.number} in ${repo} has no dependencies, skipping`)
        return false
    }

    const allApproved = prDependencies.every((dep) =>
        versionIsApproved(approvedVersions, dep),
    )

    if (!allApproved) {
        console.log(
            `PR #${pr.number} in ${repo} has unapproved dependency versions, skipping`,
        )
        return false
    }

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
            ciChecks.some(
                (check) =>
                    check.conclusion !== "success" &&
                    check.conclusion !== "skipped",
            )
        ) {
            console.log(
                `PR #${pr.number} in ${repo} does not have all CI checks passing, skipping`,
            )
            return false
        }
    }

    const prData = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pr.number,
    })

    if (
        !["clean", "blocked"].includes(prData.data.mergeable_state) ||
        !prData.data.mergeable
    ) {
        console.log(`PR #${pr.number} in ${repo} cannot be merged, skipping`)
        console.log(
            `Mergeable state: ${prData.data.mergeable_state}, Mergeable: ${prData.data.mergeable}`,
        )
        return false
    } else if (prData.data.state !== "open") {
        // Check if PR is still open before attempting to merge
        console.log(`PR #${pr.number} in ${repo} is no longer open, skipping`)
        return false
    }

    return true
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
            if (!isDependabotPr(pr)) {
                continue
            }

            const prDependencies = await extractPrDependencies(
                pr,
                octokit,
                owner,
            )

            const ready = await prReadyToMerge(
                pr,
                octokit,
                repo,
                owner,
                approvedVersions,
                prDependencies,
                requireCi,
            )

            if (!ready) {
                continue
            }

            if (dryRun) {
                console.log(
                    `Dry run: would approve and merge PR #${pr.number} in ${repo}`,
                )
                continue
            }

            console.log(`Approving and merging PR #${pr.number} in ${repo}...`)

            const repoData = await octokit.rest.repos.get({
                owner,
                repo,
            })

            const success = await approveAndMergePr(
                pr,
                octokit,
                repoData.data,
                prDependencies,
                mergeStrategy,
                approvedVersions,
                store.approvalStoreLink,
            )

            if (success) {
                // TODO: Log event
            }
        }
    }
}

export const captureApproval = async (
    pr: PrPayload,
    octokit: ProbotOctokit,
    repository: Repository,
    user: string,
    store: ApprovalStore,
): Promise<void> => {
    const config = await store.getConfig()

    if (!config.enrolledRepos.includes(repository.name)) {
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
    store: ApprovalStore,
): Promise<void> => {
    if (!isDependabotPr(pr)) {
        return
    }

    if (pr.state !== "open") {
        return
    }

    const config = await store.getConfig()

    if (!config.enrolledRepos.includes(repository.name)) {
        return
    }

    const dependencies = await extractPrDependencies(
        pr,
        octokit,
        repository.owner.login,
    )

    const approvedVersions = await store.getApprovedVersions()

    const ready = await prReadyToMerge(
        pr,
        octokit,
        repository.name,
        repository.owner.login,
        approvedVersions,
        dependencies,
        config.requireCi,
    )

    if (!ready) {
        return
    }

    const success = await approveAndMergePr(
        pr,
        octokit,
        repository,
        dependencies,
        config.mergeStrategy,
        approvedVersions,
        store.approvalStoreLink,
    )

    if (!success) {
        // Handle failure (e.g. log, comment on PR, etc.)
    }
}
