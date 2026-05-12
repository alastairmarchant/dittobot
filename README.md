# DittoBot

> A GitHub App built with [Probot](https://github.com/probot/probot) that
> Automatically approves and merges Dependabot PRs across multiple repos once a
> dependency version has been manually reviewed in any single repo.

## Setup

```sh
# Install dependencies
npm install

# Compile
npm build

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t dittobot .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> dittobot
```

## Contributing

If you have suggestions for how dittobot could be improved, or want to report a
bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 Alastair Marchant
