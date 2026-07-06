# DittoBot

> A GitHub App built with [Probot](https://github.com/probot/probot) that
> Automatically approves and merges Dependabot PRs across multiple repos once a
> dependency version has been manually reviewed in any single repo.

## Setup

```sh
# Install dependencies
npm install

# Copy environment config and fill in your values
cp .env.example .env

# Compile
npm run build

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t dittobot .

# 2. Start container (pass required Probot vars and your store config)
docker run \
  -e APP_ID=<app-id> \
  -e PRIVATE_KEY=<pem-value> \
  -e WEBHOOK_SECRET=<secret> \
  -e DITTOBOT_STORE__TYPE=github \
  -e DITTOBOT_STORE__DEFAULT_REPO=<owner/repo> \
  dittobot
```

## CLI

DittoBot includes a CLI for managing approved dependency versions. All CLI
commands require a GitHub PAT token:

```sh
export GITHUB_PAT_TOKEN=<your-github-pat>

# Approve a dependency version
npx dittobot approve <dependency> --dep-version <version> --ecosystem <npm|pip|...> --user <github-username>

# List approved versions
npx dittobot list

# Show pending Dependabot PRs
npx dittobot pending

# Scan and auto-approve matching PRs
npx dittobot scan [--dry-run]
```

See `.env.example` for the full list of configuration variables.

## Contributing

If you have suggestions for how dittobot could be improved, or want to report a
bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 Alastair Marchant
