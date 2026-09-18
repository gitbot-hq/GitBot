# Opencode Model Selection — Implementation Notes

## How opencode handles model config

The opencode SDK does **not** accept a model parameter at the session or prompt level.

- `client.session.create()` — no model param
- `client.session.promptAsync()` — no model param

Model is set via the opencode server's config, per directory:

```ts
await client.config.update({
  body: { ...currentConfig, model: "anthropic/claude-sonnet-4-6" },
});
```

## Current wiring in this codebase

`store.model` is populated from the `POST /chat` body and stored on `SessionStore`, but **`start-opencode.ts` does not read it**. The model field is only wired up for claude-code.

## What needs to be done

In `start-opencode.ts`, `runAgent()` should call `client.config.update()` with `store.model` **before** creating the session, e.g.:

```ts
if (store.model) {
  const client = await getClientForDir(store.repoPath);
  const configResult = await client.config.get();
  const currentConfig = (configResult.data ?? {}) as Record<string, any>;
  await client.config.update({
    body: { ...currentConfig, permission: permissionConfig, model: store.model },
  });
}
```

## Complication: client caching

`getClientForDir()` caches clients by directory and sets config only once on first access. A per-session model override needs config to be updated in `runAgent()` on every call, not just on first client creation.

## Model ID format for opencode

opencode uses `provider/model-id` format, sourced from `models.dev/api.json` at runtime.

Examples:
- `anthropic/claude-sonnet-4-6`
- `openai/gpt-4o`
- `google/gemini-2.5-pro`

See `models.json` in this repo for the full curated list.
