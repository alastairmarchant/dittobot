import { z } from "zod"

const GithubStoreConfigSchema = z.object({
    TYPE: z.literal("github"),
    REPO: z.string(),
})

export type GithubStoreConfig = z.infer<typeof GithubStoreConfigSchema>

const LocalStoreConfigSchema = z.object({
    TYPE: z.literal("local"),
    PATH: z.string(),
})

export type LocalStoreConfig = z.infer<typeof LocalStoreConfigSchema>

const MemoryStoreConfigSchema = z.object({
    TYPE: z.literal("memory"),
})

export type MemoryStoreConfig = z.infer<typeof MemoryStoreConfigSchema>

const StoreConfigSchema = z.discriminatedUnion("TYPE", [
    GithubStoreConfigSchema,
    LocalStoreConfigSchema,
    MemoryStoreConfigSchema,
])

export type StoreProviderConfig = z.infer<typeof StoreConfigSchema>

const EnvSchema = z.object({
    STRICT_VERSIONS: z.stringbool().default(true),
    STORE: StoreConfigSchema,
})

export type DittoBotConfig = z.infer<typeof EnvSchema>

type NestedObject = { [key: string]: string | NestedObject }

export const nestObject = (
    flatObj: Record<string, string>,
    separator = "__",
): NestedObject => {
    const nestedObj: NestedObject = {}

    for (const [key, value] of Object.entries(flatObj)) {
        const parts = key.split(separator)
        let currentLevel = nestedObj

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i]

            if (!part) {
                continue
            }

            if (i === parts.length - 1) {
                currentLevel[part] = value
            } else {
                currentLevel[part] ??= {}
                currentLevel = currentLevel[part] as NestedObject
            }
        }
    }
    return nestedObj
}

export const parseEnv = (): z.infer<typeof EnvSchema> => {
    const envEntries = Object.entries(process.env)
        .filter(([key]) => key.startsWith("DITTOBOT_"))
        .map(
            ([key, value]) =>
                [key.replace("DITTOBOT_", ""), value] as [string, string],
        )
    const nestedEnv = nestObject(Object.fromEntries(envEntries))
    return EnvSchema.parse(nestedEnv)
}

export const env = parseEnv()
