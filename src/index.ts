import { Probot } from "probot"
import { isDependabotPr, checkPr, captureApproval } from "./dependencies.js"
import { StoreRegistry } from "./registry.js"
import { env } from "./env.js"

export default (app: Probot): void => {
    const registry = new StoreRegistry(env)

    app.on(
        [
            "pull_request.opened",
            "pull_request.reopened",
            "pull_request.synchronize",
        ],
        async (context) => {
            if (!isDependabotPr(context.payload.pull_request)) {
                return
            }

            const org = context.payload.repository.owner.login
            const store = await registry.getStore(org, context.octokit)
            await checkPr(
                context.payload.pull_request,
                context.octokit,
                context.payload.repository,
                store,
            )
        },
    )

    app.on("pull_request.closed", async (context) => {
        if (!isDependabotPr(context.payload.pull_request)) {
            return
        }

        if (context.isBot) {
            return
        }

        if (!context.payload.pull_request.merged) {
            return
        }

        const org = context.payload.repository.owner.login
        const store = await registry.getStore(org, context.octokit)
        const user = context.payload.sender.login
        await captureApproval(
            context.payload.pull_request,
            context.octokit,
            context.payload.repository,
            user,
            store,
        )
    })

    app.on("pull_request_review.submitted", async (context) => {
        if (context.payload.review.state !== "approved") {
            return
        }

        if (context.isBot) {
            return
        }

        if (!isDependabotPr(context.payload.pull_request)) {
            return
        }
        const org = context.payload.repository.owner.login
        const store = await registry.getStore(org, context.octokit)
        const user =
            context.payload.review.user?.login ?? context.payload.sender.login
        await captureApproval(
            context.payload.pull_request,
            context.octokit,
            context.payload.repository,
            user,
            store,
        )
    })

    app.on("check_suite.completed", async (context) => {
        if (context.payload.check_suite.conclusion !== "success") {
            return
        }

        const pr = context.payload.check_suite.pull_requests[0] as
            | { number: number; head: { ref: string } }
            | undefined
        if (!pr) {
            return
        }

        if (!pr.head.ref.startsWith("dependabot/")) {
            return
        }

        const prDetails = await context.octokit.rest.pulls.get({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            pull_number: pr.number,
        })
        const prData = prDetails.data

        if (!isDependabotPr(prData)) {
            return
        }

        const org = context.payload.repository.owner.login
        const store = await registry.getStore(org, context.octokit)
        await checkPr(
            prData,
            context.octokit,
            context.payload.repository,
            store,
        )
    })

    app.on("installation.created", async (context) => {
        const account = context.payload.installation.account
        if (!account || !("login" in account)) {
            return
        }
        const org = (account as { login: string }).login
        await registry.getStore(org, context.octokit)
    })
}
