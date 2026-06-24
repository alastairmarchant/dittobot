import type { ProbotOctokit } from "probot"
import { promises as fs } from "node:fs"
import path from "node:path"
import { ConfigError } from "./errors.js"
import type { DittoBotConfig, StoreProviderConfig } from "./env.js"
import ApprovalStore, {
    GithubVersionStoreProvider,
    LocalFileStoreProvider,
    MemoryVersionStoreProvider,
    createDefaultStoreConfig,
} from "./store.js"

const INITIAL_APPROVAL_FILE = {
    metadata: {
        description: "Approved dependency versions for Dependabot auto-merge",
        schema_version: "1.0",
    },
    approved: {},
}

export class StoreRegistry {
    private readonly _cache = new Map<string, ApprovalStore>()
    private readonly _bootstrapLocks = new Map<string, Promise<ApprovalStore>>()

    constructor(private readonly _config: DittoBotConfig) {}

    async getStore(
        org: string,
        octokit: ProbotOctokit,
    ): Promise<ApprovalStore> {
        if (!org) throw new ConfigError("org must not be empty")

        const cached = this._cache.get(org)
        if (cached) return cached

        const inflight = this._bootstrapLocks.get(org)
        if (inflight) return inflight

        const bootstrapPromise = this._bootstrap(org, octokit)
            .then((store) => {
                this._cache.set(org, store)
                this._bootstrapLocks.delete(org)
                return store
            })
            .catch((err: unknown) => {
                this._bootstrapLocks.delete(org)
                throw err
            })

        this._bootstrapLocks.set(org, bootstrapPromise)
        return bootstrapPromise
    }

    private async _bootstrap(
        org: string,
        octokit: ProbotOctokit,
    ): Promise<ApprovalStore> {
        const storeConfig = this._config.STORE

        switch (storeConfig.TYPE) {
            case "github": {
                const { DEFAULT_REPO } = storeConfig
                await this._bootstrapGithub(octokit, org, DEFAULT_REPO)
                return new ApprovalStore(
                    new GithubVersionStoreProvider(octokit, org, DEFAULT_REPO),
                )
            }
            case "local": {
                const orgPath = path.join(path.resolve(storeConfig.PATH), org)
                await fs.mkdir(orgPath, { recursive: true })
                const configPath = path.join(orgPath, "config.json")
                try {
                    await fs.access(configPath)
                } catch {
                    await fs.writeFile(
                        configPath,
                        JSON.stringify(createDefaultStoreConfig(org), null, 4),
                        "utf8",
                    )
                }
                return new ApprovalStore(new LocalFileStoreProvider(orgPath))
            }
            case "memory": {
                return new ApprovalStore(
                    new MemoryVersionStoreProvider(
                        createDefaultStoreConfig(org),
                    ),
                )
            }
            default:
                throw new ConfigError(
                    `Unsupported store type: ${(storeConfig as StoreProviderConfig).TYPE}`,
                )
        }
    }

    private async _bootstrapGithub(
        octokit: ProbotOctokit,
        org: string,
        repoName: string,
    ): Promise<void> {
        try {
            await octokit.rest.repos.getContent({
                owner: org,
                repo: repoName,
                path: "config.json",
            })
            return
        } catch (e: unknown) {
            if (!isStatusError(e, 404)) throw e
        }

        try {
            await octokit.rest.repos.createInOrg({
                org,
                name: repoName,
                private: true,
                auto_init: true,
            })
        } catch (e: unknown) {
            if (isStatusError(e, 422)) {
                // repo already exists in org, fall through to file push
            } else if (isStatusError(e, 404)) {
                // not an org account — fall back to user repo creation
                try {
                    await octokit.rest.repos.createForAuthenticatedUser({
                        name: repoName,
                        private: true,
                        auto_init: true,
                    })
                } catch (userErr: unknown) {
                    if (!isStatusError(userErr, 422)) throw userErr
                }
            } else {
                throw e
            }
        }

        const defaultConfig = createDefaultStoreConfig(org)
        const now = new Date().toISOString()
        const filesToPush = [
            {
                path: "config.json",
                content: JSON.stringify(defaultConfig, null, 4),
                message: "chore: initialize DittoBot config",
            },
            {
                path: "approved-versions.json",
                content: JSON.stringify(
                    {
                        ...INITIAL_APPROVAL_FILE,
                        metadata: {
                            ...INITIAL_APPROVAL_FILE.metadata,
                            last_updated: now,
                        },
                    },
                    null,
                    4,
                ),
                message: "chore: initialize approved versions",
            },
            {
                path: "audit-log.json",
                content: JSON.stringify({ events: [] }, null, 4),
                message: "chore: initialize audit log",
            },
        ]

        for (const file of filesToPush) {
            await octokit.rest.repos.createOrUpdateFileContents({
                owner: org,
                repo: repoName,
                path: file.path,
                message: file.message,
                content: Buffer.from(file.content).toString("base64"),
            })
        }
    }
}

function isStatusError(e: unknown, status: number): boolean {
    return (
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        (e as { status: number }).status === status
    )
}
