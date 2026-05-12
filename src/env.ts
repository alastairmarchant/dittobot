import { z } from 'zod'

const GithubStoreConfigSchema = z.object({
    TYPE: z.literal('github'),
    REPO: z.string(),
})

export type GithubStoreConfig = z.infer<typeof GithubStoreConfigSchema>

const LocalStoreConfigSchema = z.object({
    TYPE: z.literal('local'),
    PATH: z.string(),
})

export type LocalStoreConfig = z.infer<typeof LocalStoreConfigSchema>

const MemoryStoreConfigSchema = z.object({
    TYPE: z.literal('memory'),
    ORG: z.string(),
    ENROLLED_REPOS: z.string().transform((str) => str.split(',').map(s => s.trim()).filter(s => s.length > 0)),
    MERGE_STRATEGY: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    REQUIRE_CI: z.coerce.boolean().default(true),
})

export type MemoryStoreConfig = z.infer<typeof MemoryStoreConfigSchema>

const StoreConfigSchema = z.discriminatedUnion('TYPE', [
    GithubStoreConfigSchema,
    LocalStoreConfigSchema,
    MemoryStoreConfigSchema,
])

export type StoreProviderConfig = z.infer<typeof StoreConfigSchema>

const EnvSchema = z.object({
    STRICT_VERSIONS: z.coerce.boolean().default(true),
    STORE: StoreConfigSchema,
})

export type DittoBotConfig = z.infer<typeof EnvSchema>

const nestObject = (flatObj: Record<string, any>, separator = '__'): Record<string, any> => {
    const nestedObj: Record<string, any> = {}

    for (const [key, value] of Object.entries(flatObj)) {
        const parts = key.split(separator)
        let currentLevel = nestedObj

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i]

            if (i === parts.length - 1) {
                currentLevel[part] = value
            } else {
                if (!currentLevel[part]) {
                    currentLevel[part] = {}
                }
                currentLevel = currentLevel[part]
            }
        }
    }
    return nestedObj
}

const parseEnv = (): z.infer<typeof EnvSchema> => {
    const envEntries = Object.entries(process.env)
        .filter(([key]) => key.startsWith('DITTOBOT_'))
        .map(([key, value]) => [key.replace('DITTOBOT_', ''), value] as [string, string])
    const nestedEnv = nestObject(Object.fromEntries(envEntries))
    return EnvSchema.parse(nestedEnv)
}

export const env = parseEnv()
