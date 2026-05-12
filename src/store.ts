import type { Dependency } from "./dependencies.js"
import type { ProbotOctokit } from "probot"
import { env } from "./env.js"
import type { GithubStoreConfig, LocalStoreConfig, MemoryStoreConfig, StoreProviderConfig } from "./env.js"
import { promises as fs } from "node:fs"
import path from "node:path"
import { ConfigError } from "./errors.js"

interface ApprovedVersionMetadata {
    approvedAt: string
    approvedBy: string
    sourceRepo: string
    sourcePr: number
}

export interface ApprovedVersions {
    [ecosystem: string]: {
        [dependencyName: string]: {
            [version: string]: ApprovedVersionMetadata
        }
    }
}

interface ApprovalFileData {
    metadata: {
        description: string
        last_updated: string
        schema_version: string
    }
    approved: ApprovedVersions
}

export interface AuditEvent {
    action: string
    timestamp: string
    repo?: string
    pr_number?: number
    pr_title?: string
    approved_by?: string
    triggered_by?: string
    dependencies?: Array<{ name: string; type: string; version: string; ecosystem: string }>
    new_versions?: Array<{ name: string; type: string; version: string; ecosystem: string }>
}

interface AuditFileData {
    events: AuditEvent[]
}

export interface StoreConfig {
    org: string
    enrolledRepos: string[]
    mergeStrategy: "squash" | "merge" | "rebase"
    requireCi: boolean
}

export interface VersionStoreProvider {
    getConfig(): Promise<StoreConfig>
    updateConfig<K extends keyof StoreConfig>(field: K, value: StoreConfig[K]): Promise<StoreConfig>
    getApprovedVersions(): Promise<ApprovedVersions>
    addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number
    ): Promise<boolean>
    logEvent(event: AuditEvent): Promise<void>
    get approvalStoreLink(): string
}

export const ensurePackageInVersions = (versions: ApprovedVersions, ecosystem: string, packageName: string) => {
    if (!versions[ecosystem]) {
        versions[ecosystem] = {}
    }
    if (!versions[ecosystem][packageName]) {
        versions[ecosystem][packageName] = {}
    }
    return versions[ecosystem][packageName]
}

export class LocalFileStoreProvider implements VersionStoreProvider {
    private readonly configFile: string
    private readonly approvalFile: string
    private readonly auditFile: string

    constructor(config: LocalStoreConfig) {
        const basePath = path.resolve(config.FILE_PATH)
        this.configFile = path.join(basePath, "config.json")
        this.approvalFile = path.join(basePath, "approved-versions.json")
        this.auditFile = path.join(basePath, "audit-log.json")
    }

    private async readJson<T>(filePath: string, defaultValue: T): Promise<T> {
        try {
            const raw = await fs.readFile(filePath, "utf8")
            return JSON.parse(raw) as T
        } catch {
            return defaultValue
        }
    }

    private async writeJson<T>(filePath: string, data: T): Promise<void> {
        const dir = path.dirname(filePath)
        const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`)
        await fs.writeFile(tmp, JSON.stringify(data, null, 4), "utf8")
        await fs.rename(tmp, filePath)
    }

    get approvalStoreLink(): string {
        return `file://${this.approvalFile}`
    }

    async getConfig(): Promise<StoreConfig> {
        const config = await this.readJson<StoreConfig | null>(this.configFile, null)
        if (!config) {
            throw new ConfigError(`Config file not found at ${this.configFile}`)
        }
        return config
    }

    async updateConfig<K extends keyof StoreConfig>(field: K, value: StoreConfig[K]): Promise<StoreConfig> {
        const config = await this.getConfig()
        config[field] = value
        await this.writeJson(this.configFile, config)
        return config
    }

    async getApprovedVersions(): Promise<ApprovedVersions> {
        const data = await this.readJson<ApprovalFileData>(
            this.approvalFile,
            {
                metadata: {
                    description: "Approved dependency versions for Dependabot auto-merge",
                    last_updated: new Date().toISOString(),
                    schema_version: "1.0",
                },
                approved: {},
            }
        )
        return data.approved
    }

    async addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number
    ): Promise<boolean> {
        const versions = await this.getApprovedVersions()
        const packageMap = ensurePackageInVersions(versions, ecosystem, packageName)

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
                description: "Approved dependency versions for Dependabot auto-merge",
                last_updated: new Date().toISOString(),
                schema_version: "1.0",
            },
            approved: versions,
        }

        await this.writeJson(this.approvalFile, fullData)
        return true
    }

    async logEvent(event: AuditEvent): Promise<void> {
        const data = await this.readJson<AuditFileData>(this.auditFile, { events: [] })
        const events = [...data.events, event].slice(-500)
        await this.writeJson(this.auditFile, { events })
    }
}


export class GithubVersionStoreProvider implements VersionStoreProvider {
    private readonly repoName: string
    private readonly configFile = "config.json";
    private readonly approvalFile = "approved-versions.json";
    private readonly auditLogFile = "audit-log.json";
    private versionsSha: string | undefined = undefined;
    configSha: string | undefined = undefined;

    constructor(private readonly octokit: ProbotOctokit, config: GithubStoreConfig) {
        this.repoName = config.REPO
    }

    private async fetchJsonFile(filePath: string): Promise<{ data: Record<string, unknown>; sha: string }> {
        const fileInfo = await this.octokit.rest.repos.getContent({
            owner: this.repoName.split("/")[0],
            repo: this.repoName.split("/")[1],
            path: filePath,
        })
        if ("content" in fileInfo.data) {
            const content = Buffer.from(fileInfo.data.content, 'base64').toString('utf-8')
            return { data: JSON.parse(content), sha: fileInfo.data.sha }
        } else {
            throw new Error("File not found")
        }
    }

    get approvalStoreLink(): string {
        return `https://github.com/${this.repoName}`;
    }

    async getConfig(): Promise<StoreConfig> {
        const { data } = await this.fetchJsonFile(this.configFile)
        return data as unknown as StoreConfig
    }

    async updateConfig<K extends keyof StoreConfig>(field: K, value: StoreConfig[K]): Promise<StoreConfig> {
        const config = await this.getConfig()
        config[field] = value

        const content = Buffer.from(JSON.stringify(config, null, 4)).toString('base64')

        const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
            owner: this.repoName.split("/")[0],
            repo: this.repoName.split("/")[1],
            path: this.configFile,
            message: `Update ${field} in config`,
            content,
            sha: this.configSha,
        })

        const newSha = data.content?.sha

        if (!newSha) {
            throw new Error("Failed to update config")
        }

        this.configSha = newSha
        return config
    }

    async getApprovedVersions(): Promise<ApprovedVersions> {
        const { data, sha } = await this.fetchJsonFile(this.approvalFile)
        this.versionsSha = sha
        return (data as unknown as ApprovalFileData).approved
    }

    async addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number
    ): Promise<boolean> {
        const versions = await this.getApprovedVersions()
        const packageMap = ensurePackageInVersions(versions, ecosystem, packageName)

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
                description: "Approved dependency versions for Dependabot auto-merge",
                last_updated: new Date().toISOString(),
                schema_version: "1.0",
            },
            approved: versions,
        }

        const content = Buffer.from(JSON.stringify(fullData, null, 4)).toString('base64')

        const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
            owner: this.repoName.split("/")[0],
            repo: this.repoName.split("/")[1],
            path: this.approvalFile,
            message: `Add approved version ${version} for ${packageName}`,
            content,
            sha: this.versionsSha,
        })

        const newSha = data.content?.sha

        if (!newSha) {
            throw new Error("Failed to update approved versions")
        }

        this.versionsSha = newSha
        return true
    }

    async logEvent(event: AuditEvent): Promise<void> {
        let auditData: AuditFileData
        try {
            const { data, sha } = await this.fetchJsonFile(this.auditLogFile)
            auditData = data as unknown as AuditFileData
            this.configSha = sha
        } catch {
            auditData = { events: [] }
        }

        const events = [...auditData.events, event].slice(-500)

        const content = Buffer.from(JSON.stringify({ events }, null, 4)).toString('base64')

        await this.octokit.rest.repos.createOrUpdateFileContents({
            owner: this.repoName.split("/")[0],
            repo: this.repoName.split("/")[1],
            path: this.auditLogFile,
            message: `Log event ${event.action}`,
            content,
            sha: this.configSha,
        })
    }
}

export class MemoryVersionStoreProvider implements VersionStoreProvider {
    private readonly config: StoreConfig
    private readonly approvedVersions: ApprovedVersions = {};
    private readonly auditLog: AuditEvent[] = [];

    constructor(config: MemoryStoreConfig) {
        this.config = {
            org: config.ORG,
            enrolledRepos: config.ENROLLED_REPOS,
            mergeStrategy: config.MERGE_STRATEGY,
            requireCi: config.REQUIRE_CI,
        }
    }

    get approvalStoreLink(): string {
        return ""
    }

    async getConfig(): Promise<StoreConfig> {
        return this.config
    }

    async updateConfig<K extends keyof StoreConfig>(field: K, value: StoreConfig[K]): Promise<StoreConfig> {
        this.config[field] = value
        return this.config
    }

    async getApprovedVersions(): Promise<ApprovedVersions> {
        return this.approvedVersions;
    }

    async addApprovedVersion(
        packageName: string,
        version: string,
        ecosystem: string,
        approvedBy: string,
        sourceRepo: string,
        sourcePr: number
    ): Promise<boolean> {
        const packageMap = ensurePackageInVersions(this.approvedVersions, ecosystem, packageName)

        if (packageMap[version]) {
            return false
        }

        packageMap[version] = {
            approvedAt: new Date().toISOString(),
            approvedBy,
            sourceRepo,
            sourcePr,
        }
        return true
    }

    async logEvent(event: AuditEvent): Promise<void> {
        this.auditLog.push(event)
    }
}

class ApprovalStore {
    private configCache: StoreConfig | null = null;
    private versionsCache: ApprovedVersions | null = null;

    constructor(private provider: VersionStoreProvider) {}

    get approvalStoreLink(): string {
        return this.provider.approvalStoreLink
    }

    async getConfig(): Promise<StoreConfig> {
        if (!this.configCache) {
            this.configCache = await this.provider.getConfig()
        }
        return this.configCache
    }

    async updateConfig<K extends keyof StoreConfig>(field: K, value: StoreConfig[K]): Promise<StoreConfig> {
        const updatedConfig = await this.provider.updateConfig(field, value)
        this.configCache = updatedConfig
        return updatedConfig
    }

    invalidateCache() {
        this.configCache = null
        this.versionsCache = null
    }

    async getApprovedVersions(): Promise<ApprovedVersions> {
        if (!this.versionsCache) {
            this.versionsCache = await this.provider.getApprovedVersions()
        }
        return this.versionsCache
    }

    async approveVersion(dep: Dependency, approvedBy: string, sourceRepo: string, sourcePr: number): Promise<boolean> {
        // TODO: Maybe just return approved versions instead of updating cache manually
        const result = await this.provider.addApprovedVersion(dep.name, dep.version, dep.ecosystem, approvedBy, sourceRepo, sourcePr)

        if (result) {
            if (this.versionsCache) {
                const packageMap = ensurePackageInVersions(this.versionsCache, dep.ecosystem, dep.name)
                packageMap[dep.version] = {
                    approvedAt: new Date().toISOString(),
                    approvedBy,
                    sourceRepo,
                    sourcePr,
                }
            }
        } else {
            this.invalidateCache()
        }

        return result
    }

    async logEvent(event: AuditEvent): Promise<void> {
        await this.provider.logEvent(event)
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
            throw new ConfigError(`Unsupported store type: ${(storeConfig as StoreProviderConfig).TYPE}`)
    }
}

export default ApprovalStore
