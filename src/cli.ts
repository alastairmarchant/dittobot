#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings"
import ApprovalStore, { getStoreProvider } from "./store.js"
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

const program = new Command()

export { program }

program
    .name("DittoBot")
    .description(
        "Automatically approves and merges Dependabot PRs across multiple repos once a dependency version has been manually reviewed in any single repo.",
    )
    .version("1.0.0")

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
            const storeProvider = getStoreProvider(octokit)
            const store = new ApprovalStore(storeProvider)

            const dep: Dependency = {
                name: dependency,
                version: options.depVersion,
                ecosystem: options.ecosystem,
                type: "direct",
            }

            await store.approveVersion(dep, options.user, "dittobot-cli", -1)
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
        const storeProvider = getStoreProvider(octokit)
        const store = new ApprovalStore(storeProvider)

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

        const storeProvider = getStoreProvider(octokit)
        const store = new ApprovalStore(storeProvider)
        const approvedVersions = await store.getApprovedVersions()

        let totalPending = 0
        let totalApproved = 0

        const config = await store.getConfig()
        for (const repo of config.enrolledRepos) {
            const prs = await octokit.paginate(octokit.rest.pulls.list, {
                owner: config.org,
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

                const prDeps = await extractPrDependencies(
                    pr,
                    octokit,
                    config.org,
                )
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
        const storeProvider = getStoreProvider(octokit)
        const store = new ApprovalStore(storeProvider)
        const config = await store.getConfig()
        await checkPendingPrs(octokit, config.org, store, options.dryRun)
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
        const storeProvider = getStoreProvider(octokit)
        const store = new ApprovalStore(storeProvider)
        const config = await store.getConfig()

        if (config.enrolledRepos.includes(repository)) {
            console.log(`${repository} is already enrolled.`)
            return
        }

        config.enrolledRepos.push(repository)
        await store.updateConfig("enrolledRepos", config.enrolledRepos)
        console.log(`Enrolled ${repository}.`)
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
        const storeProvider = getStoreProvider(octokit)
        const store = new ApprovalStore(storeProvider)
        const config = await store.getConfig()

        if (!config.enrolledRepos.includes(repository)) {
            console.log(`${repository} is not enrolled.`)
            return
        }

        config.enrolledRepos = config.enrolledRepos.filter(
            (repo) => repo !== repository,
        )
        await store.updateConfig("enrolledRepos", config.enrolledRepos)
        console.log(`Unenrolled ${repository}.`)
    })

// Only parse if this file is run directly (not imported for tests)
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
