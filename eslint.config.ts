import js from "@eslint/js"
import tseslint from "typescript-eslint"
import { defineConfig } from "eslint/config"
import prettier from "eslint-config-prettier"

export default defineConfig([
    js.configs.recommended,
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: [
                        "eslint.config.ts",
                        "vitest.config.ts",
                        "test/*.ts",
                    ],
                    defaultProject: "./tsconfig.json",
                },
            },
            globals: {
                // Node.js globals
                process: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                module: "readonly",
                require: "readonly",
                Buffer: "readonly",
                console: "readonly",
            },
        },
        extends: [
            tseslint.configs.strictTypeChecked,
            tseslint.configs.stylisticTypeChecked,
        ],
        rules: {
            "@typescript-eslint/explicit-function-return-type": [
                "error",
                {
                    allowExpressions: true,
                    allowTypedFunctionExpressions: true,
                },
            ],

            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],

            "@typescript-eslint/restrict-template-expressions": [
                "error",
                {
                    allowNumber: true,
                    allowBoolean: true,
                },
            ],

            "@typescript-eslint/no-floating-promises": "error",

            "@typescript-eslint/consistent-type-assertions": [
                "error",
                {
                    assertionStyle: "as",
                    objectLiteralTypeAssertions: "never",
                },
            ],

            // Enforce consistent naming conventions
            "@typescript-eslint/naming-convention": [
                "error",
                // Type aliases in PascalCase
                {
                    selector: "typeAlias",
                    format: ["PascalCase"],
                },
                // Enum members in UPPER_CASE
                {
                    selector: "enumMember",
                    format: ["UPPER_CASE"],
                },
                // Private members with underscore prefix
                {
                    selector: "memberLike",
                    modifiers: ["private"],
                    format: ["camelCase"],
                    leadingUnderscore: "require",
                },
            ],

            // Prefer type aliases over interfaces
            "@typescript-eslint/consistent-type-definitions": ["error", "type"],

            // Require consistent member ordering in classes
            "@typescript-eslint/member-ordering": [
                "error",
                {
                    default: [
                        "public-static-field",
                        "protected-static-field",
                        "private-static-field",
                        "public-instance-field",
                        "protected-instance-field",
                        "private-instance-field",
                        "constructor",
                        "public-method",
                        "protected-method",
                        "private-method",
                    ],
                },
            ],

            "@typescript-eslint/no-non-null-assertion": "warn",
        },
    },
    {
        files: ["test/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: [
                        "eslint.config.ts",
                        "vitest.config.ts",
                        "test/*.ts",
                    ],
                    defaultProject: "./tsconfig.json",
                },
            },
            globals: {
                // Node.js globals
                process: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                module: "readonly",
                require: "readonly",
                Buffer: "readonly",
                console: "readonly",
            },
        },
        extends: [
            tseslint.configs.recommended,
            tseslint.configs.stylisticTypeChecked,
        ],
    },
    prettier,
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "coverage/**",
            "eslint.config.ts",
            "vitest.config.ts",
        ],
    },
])
