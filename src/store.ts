import type { Dependency } from "./dependencies.js"
import type { ProbotOctokit } from "probot"
import { env } from "./env.js"
import type {
    GithubStoreConfig,
    LocalStoreConfig,
    MemoryStoreConfig,
    StoreProviderConfig,
} from "./env.js"
import { promises as fs } from "node:fs"
import path from "node:path"
import { ConfigError } from "./errors.js"

type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

type ApprovedVersionMetadata = {
    approvedAt: string
    approvedBy: string
    sourceRepo: string
    sourcePr: number
}

export type ApprovedVersions = Record<
    string,
    Record<string, Record<string, ApprovedVersionMetadata>>
>

type ApprovalFileData = {
    metadata: {
        description: string
        last_updated: string
        schema_version: string
    }
    approved: ApprovedVersions
}

const APPROVAL_FILE_METADATA = {
    description: "Approved dependency versions for Dependabot auto-merge",
    schema_version: "1.0",
}

export type AuditEvent = {
    action: string
    timestamp: string
    repo?: string
    pr_number?: number
    pr_title?: string
    approved_by?: string
    triggered_by?: string
    dependencies?: {
        name: string
        type: string
        version: string
        ecosystem: string
    }[]
    new_versions?: {
        name: string
        type: string
        version: string
        ecosystem: string
    }[]
}

type AuditFileData = {
    events: AuditEvent[]
}

export type StoreConfig = {
    org: string
    enrolledRepos: string[]
    mergeStrategy: "squash" | "merge" | "rebase"
    requireCi: boolean
}

export type VersionStoreProvider = {
    getConfig(): Promise<StoreConfig>
    updateConfig<K extends keyof StoreConfig>(
        field: K,
        value: StoreConfig[K],
    ): Promise<StoreConfig>
    getApprovedVersions(): Promise<ApprovedVersions>
    addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number,
    ): Promise<boolean>
    logEvent(event: AuditEvent): Promise<void>
    get approvalStoreLink(): string
}

export const ensurePackageInVersions = (
    versions: ApprovedVersions,
    ecosystem: string,
    packageName: string,
): Record<string, ApprovedVersionMetadata> => {
    versions[ecosystem] ??= {}
    versions[ecosystem][packageName] ??= {}
    return versions[ecosystem][packageName]
}

export class LocalFileStoreProvider implements VersionStoreProvider {
    private readonly _configFile: string
    private readonly _approvalFile: string
    private readonly _auditFile: string

    constructor(config: LocalStoreConfig) {
        const basePath = path.resolve(config.PATH)
        this._configFile = path.join(basePath, "config.json")
        this._approvalFile = path.join(basePath, "approved-versions.json")
        this._auditFile = path.join(basePath, "audit-log.json")
    }

    get approvalStoreLink(): string {
        return `file://${this._approvalFile}`
    }

    async getConfig(): Promise<StoreConfig> {
        const config = await this._readJson<StoreConfig | null>(
            this._configFile,
            null,
        )
        if (!config) {
            throw new ConfigError(
                `Config file not found at ${this._configFile}`,
            )
        }
        return config
    }

    async updateConfig<K extends keyof StoreConfig>(
        field: K,
        value: StoreConfig[K],
    ): Promise<StoreConfig> {
        const config = await this.getConfig()
        config[field] = value
        await this._writeJson(this._configFile, config)
        return config
    }

    async getApprovedVersions(): Promise<ApprovedVersions> {
        const data = await this._readJson<ApprovalFileData>(
            this._approvalFile,
            {
                metadata: {
                    ...APPROVAL_FILE_METADATA,
                    last_updated: new Date().toISOString(),
                },
                approved: {},
            },
        )
        return data.approved
    }

    async addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number,
    ): Promise<boolean> {
        const versions = await this.getApprovedVersions()
        const packageMap = ensurePackageInVersions(
            versions,
            ecosystem,
            packageName,
        )

        if (packageMap[version]) {
            return false
        }

        packageMap[version] = {
            approvedAt: new Date().toISOString(),
            approvedBy,
            sourceRepo,
            sourcePr,
        }

        const fullData: ApprovalFileData = {
            metadata: {
                ...APPROVAL_FILE_METADATA,
                last_updated: new Date().toISOString(),
            },
            approved: versions,
        }

        await this._writeJson(this._approvalFile, fullData)
        return true
    }

    async logEvent(event: AuditEvent): Promise<void> {
        const data = await this._readJson<AuditFileData>(this._auditFile, {
            events: [],
        })
        const events = [...data.events, event].slice(-500)
        await this._writeJson(this._auditFile, { events })
    }

    private async _readJson<T>(filePath: string, defaultValue: T): Promise<T> {
        try {
            const raw = await fs.readFile(filePath, "utf8")
            return JSON.parse(raw) as T
        } catch {
            return defaultValue
        }
    }

    private async _writeJson(filePath: string, data: JsonValue): Promise<void> {
        const dir = path.dirname(filePath)
        const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`)
        await fs.writeFile(tmp, JSON.stringify(data, null, 4), "utf8")
        await fs.rename(tmp, filePath)
    }
}

export class GithubVersionStoreProvider implements VersionStoreProvider {
    private _configSha: string | undefined = undefined

    get configSha(): string | undefined {
        return this._configSha
    }

    private readonly _owner: string
    private readonly _repo: string
    private readonly _configFile = "config.json"
    private readonly _approvalFile = "approved-versions.json"
    private readonly _auditLogFile = "audit-log.json"
    private _versionsSha: string | undefined = undefined

    constructor(
        private readonly _octokit: ProbotOctokit,
        config: GithubStoreConfig,
    ) {
        const [owner, repo] = config.REPO.split("/")
        this._owner = owner!
        this._repo = repo!
    }

    get approvalStoreLink(): string {
        return `https://github.com/${this._owner}/${this._repo}`
    }

    async getConfig(): Promise<StoreConfig> {
        const { data } = await this._fetchJsonFile(this._configFile)
        return data as unknown as StoreConfig
    }

    async updateConfig<K extends keyof StoreConfig>(
        field: K,
        value: StoreConfig[K],
    ): Promise<StoreConfig> {
        const config = await this.getConfig()
        config[field] = value

        const content = Buffer.from(JSON.stringify(config, null, 4)).toString(
            "base64",
        )

        const { data } =
            await this._octokit.rest.repos.createOrUpdateFileContents({
                owner: this._owner,
                repo: this._repo,
                path: this._configFile,
                message: `Update ${field} in config`,
                content,
                sha: this._configSha,
            })

        const newSha = data.content?.sha

        if (!newSha) {
            throw new Error("Failed to update config")
        }

        this._configSha = newSha
        return config
    }

    async getApprovedVersions(): Promise<ApprovedVersions> {
        const { data, sha } = await this._fetchJsonFile(this._approvalFile)
        this._versionsSha = sha
        return (data as unknown as ApprovalFileData).approved
    }

    async addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number,
    ): Promise<boolean> {
        const versions = await this.getApprovedVersions()
        const packageMap = ensurePackageInVersions(
            versions,
            ecosystem,
            packageName,
        )

        if (packageMap[version]) {
            return false
        }

        packageMap[version] = {
            approvedAt: new Date().toISOString(),
            approvedBy,
            sourceRepo,
            sourcePr,
        }

        const fullData = {
            metadata: {
                ...APPROVAL_FILE_METADATA,
                last_updated: new Date().toISOString(),
            },
            approved: versions,
        }

        const content = Buffer.from(JSON.stringify(fullData, null, 4)).toString(
            "base64",
        )

        const { data } =
            await this._octokit.rest.repos.createOrUpdateFileContents({
                owner: this._owner,
                repo: this._repo,
                path: this._approvalFile,
                message: `Add approved version ${version} for ${packageName}`,
                content,
                sha: this._versionsSha,
            })

        const newSha = data.content?.sha

        if (!newSha) {
            throw new Error("Failed to update approved versions")
        }

        this._versionsSha = newSha
        return true
    }

    async logEvent(event: AuditEvent): Promise<void> {
        let auditData: AuditFileData
        let auditSha: string | undefined = undefined
        try {
            const { data, sha } = await this._fetchJsonFile(this._auditLogFile)
            auditData = data as unknown as AuditFileData
            auditSha = sha
        } catch {
            auditData = { events: [] }
        }

        const events = [...auditData.events, event].slice(-500)

        const content = Buffer.from(
            JSON.stringify({ events }, null, 4),
        ).toString("base64")

        await this._octokit.rest.repos.createOrUpdateFileContents({
            owner: this._owner,
            repo: this._repo,
            path: this._auditLogFile,
            message: `Log event ${event.action}`,
            content,
            sha: auditSha,
        })
    }

    private async _fetchJsonFile(
        filePath: string,
    ): Promise<{ data: JsonObject; sha: string }> {
        const fileInfo = await this._octokit.rest.repos.getContent({
            owner: this._owner,
            repo: this._repo,
            path: filePath,
        })
        if ("content" in fileInfo.data) {
            const content = Buffer.from(
                fileInfo.data.content,
                "base64",
            ).toString("utf-8")
            return {
                data: JSON.parse(content) as JsonObject,
                sha: fileInfo.data.sha,
            }
        } else {
            throw new Error("File not found")
        }
    }
}

export class MemoryVersionStoreProvider implements VersionStoreProvider {
    approvalStoreLink = ""
    private readonly _config: StoreConfig
    private readonly _approvedVersions: ApprovedVersions = {}
    private readonly _auditLog: AuditEvent[] = []

    constructor(config: MemoryStoreConfig) {
        this._config = {
            org: config.ORG,
            enrolledRepos: config.ENROLLED_REPOS,
            mergeStrategy: config.MERGE_STRATEGY,
            requireCi: config.REQUIRE_CI,
        }
    }

    getConfig(): Promise<StoreConfig> {
        return Promise.resolve(this._config)
    }

    updateConfig<K extends keyof StoreConfig>(
        field: K,
        value: StoreConfig[K],
    ): Promise<StoreConfig> {
        this._config[field] = value
        return Promise.resolve(this._config)
    }

    getApprovedVersions(): Promise<ApprovedVersions> {
        return Promise.resolve(this._approvedVersions)
    }

    addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number,
    ): Promise<boolean> {
        const packageMap = ensurePackageInVersions(
            this._approvedVersions,
            ecosystem,
            packageName,
        )

        if (packageMap[version]) {
            return Promise.resolve(false)
        }

        packageMap[version] = {
            approvedAt: new Date().toISOString(),
            approvedBy,
            sourceRepo,
            sourcePr,
        }
        return Promise.resolve(true)
    }

    logEvent(event: AuditEvent): Promise<void> {
        this._auditLog.push(event)
        return Promise.resolve()
    }
}

class ApprovalStore {
    private _configCache: StoreConfig | null = null
    private _versionsCache: ApprovedVersions | null = null

    constructor(private _provider: VersionStoreProvider) {}

    get approvalStoreLink(): string {
        return this._provider.approvalStoreLink
    }

    async getConfig(): Promise<StoreConfig> {
        this._configCache ??= await this._provider.getConfig()
        return this._configCache
    }

    async updateConfig<K extends keyof StoreConfig>(
        field: K,
        value: StoreConfig[K],
    ): Promise<StoreConfig> {
        const updatedConfig = await this._provider.updateConfig(field, value)
        this._configCache = updatedConfig
        return updatedConfig
    }

    invalidateCache(): void {
        this._configCache = null
        this._versionsCache = null
    }

    async getApprovedVersions(): Promise<ApprovedVersions> {
        this._versionsCache ??= await this._provider.getApprovedVersions()
        return this._versionsCache
    }

    async approveVersion(
        dep: Dependency,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number,
    ): Promise<boolean> {
        // TODO: Maybe just return approved versions instead of updating cache manually
        const result = await this._provider.addApprovedVersion(
            dep.name,
            dep.version,
            dep.ecosystem,
            approvedBy,
            sourceRepo,
            sourcePr,
        )

        if (result && this._versionsCache) {
            const packageMap = ensurePackageInVersions(
                this._versionsCache,
                dep.ecosystem,
                dep.name,
            )
            packageMap[dep.version] = {
                approvedAt: new Date().toISOString(),
                approvedBy,
                sourceRepo,
                sourcePr,
            }
        }

        return result
    }

    async logEvent(event: AuditEvent): Promise<void> {
        await this._provider.logEvent(event)
    }
}

export function getStoreProvider(octokit: ProbotOctokit): VersionStoreProvider {
    const storeConfig = env.STORE
    switch (storeConfig.TYPE) {
        case "github":
            return new GithubVersionStoreProvider(octokit, storeConfig)
        case "local":
            return new LocalFileStoreProvider(storeConfig)
        case "memory":
            return new MemoryVersionStoreProvider(storeConfig)
        default:
            throw new ConfigError(
                `Unsupported store type: ${(storeConfig as StoreProviderConfig).TYPE}`,
            )
    }
}

export default ApprovalStore
