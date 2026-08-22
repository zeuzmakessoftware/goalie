# Goalie CLI

Goalie is a terminal coding assistant backed by OpenRouter.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `OPENROUTER_API_KEY` to an OpenRouter API key.
3. Start the CLI:

```sh
pnpm start
```

`OPENROUTER_MODEL` is optional. The default is
`nvidia/nemotron-3-ultra-550b-a55b:free`; set it to any compatible OpenRouter
model ID when needed.

Run the type check with:

```sh
pnpm test
```
