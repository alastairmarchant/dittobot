#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings"
import ApprovalStore from "./store.js"
import {
    extractPrDependencies,
    isDependabotPr,
    versionIsApproved,
    checkPendingPrs,
} from "./dependencies.js"
import type { Dependency } from "./dependencies.js"
import { ProbotOctokit } from "probot"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"
import { StoreRegistry } from "./registry.js"
import { env } from "./env.js"

const program = new Command()

export { program }

program
    .name("DittoBot")
    .description(
        "Automatically approves and merges Dependabot PRs across multiple repos once a dependency version has been manually reviewed in any single repo.",
    )
    .version("1.0.0")
    .option("--org <org>", "The GitHub org to manage")

export async function approveAction(
    store: ApprovalStore,
    dep: Dependency,
    user: string,
): Promise<void> {
    await store.approveVersion(dep, user, "dittobot-cli", -1)
}

export async function listAction(store: ApprovalStore): Promise<void> {
    const approvedVersions = await store.getApprovedVersions()

    for (const [ecosystem, packages] of Object.entries(approvedVersions)) {
        for (const [packageName, versions] of Object.entries(packages)) {
            for (const [version, meta] of Object.entries(versions)) {
                console.log(
                    `${packageName}==${version} (${ecosystem}) approved by ${meta.approvedBy} on ${meta.approvedAt} in ${meta.sourceRepo}#${meta.sourcePr}`,
                )
            }
        }
    }
}

export async function pendingAction(
    store: ApprovalStore,
    octokit: ProbotOctokit,
    owner: string,
): Promise<void> {
    const approvedVersions = await store.getApprovedVersions()

    let totalPending = 0
    let totalApproved = 0

    const config = await store.getConfig()
    for (const repo of config.enrolledRepos) {
        const prs = await octokit.paginate(octokit.rest.pulls.list, {
            owner: owner,
            repo: repo,
            state: "open",
            per_page: 100,
        })

        if (prs.length === 0) {
            continue
        }

        console.log(`\n${repo}`)
        for (const pr of prs) {
            if (!isDependabotPr(pr)) {
                continue
            }

            const prDeps = await extractPrDependencies(pr, octokit, owner)
            if (prDeps.length === 0) {
                continue
            }

            const statuses = prDeps.map((dep) => ({
                dep,
                approved: versionIsApproved(approvedVersions, dep),
            }))
            const allApproved = statuses.every((s) => s.approved)

            if (allApproved) {
                totalApproved++
            } else {
                totalPending++
            }

            console.log(
                `  [${allApproved ? "READY" : "PENDING"}] PR #${pr.number}: ${pr.title}`,
            )
            for (const { dep, approved } of statuses) {
                console.log(
                    `      ${dep.name}==${dep.version} (${dep.ecosystem}) ${approved ? "APPROVED" : "PENDING"}`,
                )
            }
        }
    }

    console.log(`\nTotal pending PRs: ${totalPending}`)
    console.log(`Total ready PRs: ${totalApproved}`)
}

export async function scanAction(
    store: ApprovalStore,
    octokit: ProbotOctokit,
    org: string,
    dryRun: boolean,
): Promise<void> {
    await checkPendingPrs(octokit, org, store, dryRun)
}

export async function enrollAction(
    store: ApprovalStore,
    repo: string,
): Promise<void> {
    const config = await store.getConfig()

    if (config.enrolledRepos.includes(repo)) {
        console.log(`${repo} is already enrolled.`)
        return
    }

    config.enrolledRepos.push(repo)
    await store.updateConfig("enrolledRepos", config.enrolledRepos)
    console.log(`Enrolled ${repo}.`)
}

export async function unenrollAction(
    store: ApprovalStore,
    repo: string,
): Promise<void> {
    const config = await store.getConfig()

    if (!config.enrolledRepos.includes(repo)) {
        console.log(`${repo} is not enrolled.`)
        return
    }

    config.enrolledRepos = config.enrolledRepos.filter((r) => r !== repo)
    await store.updateConfig("enrolledRepos", config.enrolledRepos)
    console.log(`Unenrolled ${repo}.`)
}

const getOrg = (): string => {
    const org = (program.opts() as { org?: string }).org
    if (!org) {
        throw new Error("--org option is required")
    }
    return org
}

const getStoreForOrg = async (
    octokit: ProbotOctokit,
    org: string,
): Promise<ApprovalStore> => {
    const registry = new StoreRegistry(env)
    return registry.getStore(org, octokit)
}

program
    .command("approve")
    .description("Approve a dependency version")
    .argument("<dependency>", "The dependency to approve")
    .option("-v, --dep-version <version>", "The version to approve")
    .option(
        "-e, --ecosystem <ecosystem>",
        "The ecosystem to approve for (e.g. npm, pip, etc.)",
    )
    .option(
        "-u, --user <user>",
        "The GitHub username of the approver",
        "dittobot-cli",
    )
    .action(
        async (
            dependency: string,
            options: {
                depVersion?: string
                ecosystem?: string
                user: string
            },
        ) => {
            if (!options.depVersion || !options.ecosystem) {
                throw new Error(
                    "Error: --dep-version and --ecosystem options are required",
                )
            }

            const octokit = new ProbotOctokit({
                auth: {
                    token: process.env.GITHUB_PAT_TOKEN,
                },
            })
            const store = await getStoreForOrg(octokit, getOrg())

            const dep: Dependency = {
                name: dependency,
                version: options.depVersion,
                ecosystem: options.ecosystem,
                type: "direct",
            }

            await approveAction(store, dep, options.user)
        },
    )

program
    .command("list")
    .description("List all approved dependency versions")
    .action(async () => {
        const octokit = new ProbotOctokit({
            auth: {
                token: process.env.GITHUB_PAT_TOKEN,
            },
        })
        const store = await getStoreForOrg(octokit, getOrg())
        await listAction(store)
    })

program
    .command("pending")
    .description("Show pending Dependabot PRs")
    .action(async () => {
        const octokit = new ProbotOctokit({
            auth: {
                token: process.env.GITHUB_PAT_TOKEN,
            },
        })
        const org = getOrg()
        const store = await getStoreForOrg(octokit, org)
        await pendingAction(store, octokit, org)
    })

program
    .command("scan")
    .description("Scan and auto-approve matching PRs")
    .option("--dry-run", "Scan and show matching PRs without approving them")
    .action(async (options: { dryRun?: boolean }) => {
        const octokit = new ProbotOctokit({
            auth: {
                token: process.env.GITHUB_PAT_TOKEN,
            },
        })
        const org = getOrg()
        const store = await getStoreForOrg(octokit, org)
        await scanAction(store, octokit, org, options.dryRun ?? false)
    })

program
    .command("enroll")
    .description("Enroll a repository for auto-approvals")
    .argument("<repository>", "The repository to enroll")
    .action(async (repository: string) => {
        const octokit = new ProbotOctokit({
            auth: {
                token: process.env.GITHUB_PAT_TOKEN,
            },
        })
        const store = await getStoreForOrg(octokit, getOrg())
        await enrollAction(store, repository)
    })

program
    .command("unenroll")
    .description("Unenroll a repository for auto-approvals")
    .argument("<repository>", "The repository to unenroll")
    .action(async (repository: string) => {
        const octokit = new ProbotOctokit({
            auth: {
                token: process.env.GITHUB_PAT_TOKEN,
            },
        })
        const store = await getStoreForOrg(octokit, getOrg())
        await unenrollAction(store, repository)
    })

// Only parse if this file is run directly (not imported for tests)
/* v8 ignore start */
if (
    fileURLToPath(import.meta.url) ===
    realpathSync(process.argv[1] ?? "no_argv")
) {
    console.log("______ _ _   _       ______       _   ")
    console.log("|  _  (_) | | |      | ___ \\     | |  ")
    console.log("| | | |_| |_| |_ ___ | |_/ / ___ | |_ ")
    console.log("| | | | | __| __/ _ \\| ___ \\/ _ \\| __|")
    console.log("| |/ /| | |_| || (_) | |_/ / (_) | |_ ")
    console.log("|___/ |_|\\__|\\__\\___/\\____/ \\___/ \\__|\n")

    program.parse()
}
/* v8 ignore stop */
