import { Probot } from "probot"
import { isDependabotPr, checkPr, captureApproval } from "./dependencies.js"

export default (app: Probot): void => {
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

            await checkPr(
                context.payload.pull_request,
                context.octokit,
                context.payload.repository,
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

        const user = context.payload.sender.login
        await captureApproval(
            context.payload.pull_request,
            context.octokit,
            context.payload.repository,
            user,
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
        const user =
            context.payload.review.user?.login ?? context.payload.sender.login
        await captureApproval(
            context.payload.pull_request,
            context.octokit,
            context.payload.repository,
            user,
        )
    })

    app.on("check_suite.completed", async (context) => {
        if (context.payload.check_suite.conclusion !== "success") {
            return
        }

        const pr = context.payload.check_suite.pull_requests[0] as
            | { number: number }
            | undefined
        if (!pr) {
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

        await checkPr(prData, context.octokit, context.payload.repository)
    })
}
