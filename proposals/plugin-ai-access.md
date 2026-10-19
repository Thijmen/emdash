---
title: AI model access for plugins
type: rfc
status: proposed
authors:
  - Thijmen Stavenuiter (@Thijmen)
champion: Thijmen Stavenuiter (@Thijmen)
sponsor: TBD
discussions:
  - https://github.com/emdash-cms/emdash/discussions/XXX
created: 2026-10-19
---

# AI model access for plugins

## Summary

Let plugins, sandboxed ones included, run AI models through a provider the site owner configures once, the same way they send email today.

- A plugin declares `ai:run` and calls `ctx.ai.run({ model, messages })`.
- A trusted provider plugin answers through a new exclusive hook, `ai:generate`. Registering it needs a new capability, `hooks.ai-provider:register`.
- `@emdash-cms/cloudflare/plugins` ships `cloudflareAI()`, a provider backed by the Worker's Workers AI binding. Through AI Gateway, that binding also reaches third-party models with unified billing.
- The registry's `declaredAccess` gains an `ai` category with `run` and `provider` operations.

The calling plugin never holds a credential. The site owner sees one consent line ("Run AI models through your site's AI provider, billed to your account") and controls which models plugins may use and what they cost.

## Problem and user case

A sandboxed plugin can't use the AI access its site already has. On Cloudflare, the site's Worker usually has an `AI` binding. A sandboxed plugin's isolate only gets `PLUGIN_ID`, `PLUGIN_VERSION` and the bridge, has no outbound network, and can only reach the outside world through `ctx.http`.

So a registry plugin that needs a model has to ask every site owner for an API key, a Cloudflare API token or an OpenAI or Anthropic key, and store it as a secret setting. That has costs:

- **Credentials.** Each plugin needs its own credential, and it has broader reach than the plugin needs. A Workers AI token can run any model on the account. Secret settings also require `EMDASH_ENCRYPTION_KEY`.
- **Review.** The plugin declares `network:request` to a provider host. That grant is weaker and harder to review than "run a model": the same host serves other APIs, and nothing ties what the plugin sends to model calls.
- **Spend.** The site owner has no single place to see, limit or attribute what plugins spend on AI.

First-party plugins hit the same wall. `@emdash-cms/plugin-ai-moderation` imports `env` from `cloudflare:workers` to run Llama Guard through the `AI` binding, so it only works as a trusted, in-process plugin and can't be installed from the registry. I wrote an AI writing plugin for my own site (it fills an entry's text fields from a brief and saves a draft). Its sandboxed registry version has to call `api.cloudflare.com` with a token the site owner pastes into its settings.

Email had the same shape and EmDash already solved it: plugins declare `email:send` and call `ctx.email.send()`, an exclusive `email:deliver` provider such as `cloudflareEmail()` holds the `send_email` binding, and the site owner configures it once. This RFC applies that design to AI models.

## Example

A sandboxed plugin that writes summaries:

```jsonc title="emdash-plugin.jsonc"
{
	"id": "summaries",
	"capabilities": ["ai:run", "content:read", "content:write"],
}
```

```ts title="src/plugin.ts"
const result = await ctx.ai!.run({
	messages: [
		{ role: "system", content: "Write a one-sentence summary." },
		{ role: "user", content: entryText },
	],
	maxTokens: 200,
});
// { text: "…", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", usage: { inputTokens: 812, outputTokens: 31 }, finishReason: "stop" }
```

The site owner adds the provider once:

```jsonc title="wrangler.jsonc"
{ "ai": { "binding": "AI" } }
```

```js title="astro.config.mjs"
import { cloudflareAI } from "@emdash-cms/cloudflare/plugins";

emdash({
	plugins: [
		cloudflareAI({
			defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "anthropic/claude-haiku-4.5"],
			maxTokens: 4000,
		}),
	],
});
```

When the plugin is installed from the registry, the consent dialog lists "Run AI models through your site's AI provider, billed to your account". AI Gateway logs every request with `metadata.plugin = "summaries"`.

## Goals

- Let sandboxed and trusted plugins run text-generation models without holding credentials.
- Keep credentials, model choice and spend controls with the site owner, in one provider.
- Make AI use a reviewable capability in the manifest, in `declaredAccess` and in the install consent.
- Attribute every request to the calling plugin, so providers can log, limit or bill per plugin.
- Ship a provider for Cloudflare, where most sandboxed sites run, that reaches Workers AI and third-party models through AI Gateway.
- Keep the provider replaceable: any plugin with `hooks.ai-provider:register` can be the provider, on any runtime.

## Non-goals

- **Streaming.** Results arrive complete. Sandbox RPC buffers responses, and a streaming API would need its own design.
- **Tool calling, structured output, images, audio and embeddings.** The request is chat messages with text content. These can be added later as optional fields or new operations (for example `ai:embed`) without breaking `ai:run`.
- **Per-plugin quotas in core.** The provider gets the caller's ID and can enforce limits; AI Gateway already has spend limits and rate limiting. Core-level budgets are an open question below, not part of this design.
- **Providers other than Cloudflare** in this RFC. The hook is the extension point; an OpenAI-compatible provider can follow as its own plugin.
- **Migrating existing plugins** such as `ai-moderation`. They can move to `ctx.ai` later.
- **Prompt-injection defense.** Model output is untrusted text. What a plugin does with it stays the plugin's responsibility, as it is today.

## Detailed design

### Capabilities

Two new capabilities, added to `PluginCapability`, `CURRENT_PLUGIN_CAPABILITIES`, the plugin CLI's manifest schema and `capability-descriptions.ts`:

| Capability                   | Grants                                       | Consent label                                                             |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `ai:run`                     | `ctx.ai.run()`                               | Run AI models through your site's AI provider, billed to your account     |
| `hooks.ai-provider:register` | Registering the exclusive `ai:generate` hook | Answer all AI requests from plugins on your site, including their prompts |

They are separate for the same reason `email:send` and `hooks.email-transport:register` are: using a model and seeing every plugin's prompts are different levels of trust.

### `ctx.ai`

```ts
interface AiAccess {
	run(request: AiRunRequest): Promise<AiRunResult>;
}

interface AiMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface AiRunRequest {
	/** Model id as the provider names it. Omit for the provider's default. */
	model?: string;
	messages: AiMessage[];
	maxTokens?: number;
	temperature?: number;
}

interface AiRunResult {
	text: string;
	/** The model that answered, as the provider reports it. */
	model: string;
	usage?: { inputTokens: number; outputTokens: number };
	/** Why generation stopped, for example "stop" or "length". */
	finishReason?: string;
}
```

`ctx.ai` exists only when the plugin declares `ai:run` and a provider is selected, like `ctx.email`. A plugin checks `if (!ctx.ai)` and tells the site owner to configure a provider. The types are exported from `emdash` and `emdash/plugin`.

Model ids are provider-specific strings. A plugin that names a model ties itself to providers that serve it. A plugin that omits `model` works with any provider. Plugins should treat the model as a setting the site owner can change.

### Request validation

`AiPipeline` in core validates every request before a provider sees it. A sandboxed plugin's request arrives over RPC and is untrusted.

- `messages` holds 1 to 200 messages. Each `role` is `system`, `user` or `assistant`, and each `content` is a string of at most 1,000,000 characters.
- `model`, when present, is a non-empty string.
- `maxTokens`, when present, is a positive integer; `temperature` a finite number.
- Unknown fields are dropped, so a provider only receives the documented shape.

A malformed request rejects with `Invalid AI request: …` and no provider runs. The pipeline also validates the provider's result: `text` and `model` must be strings, and malformed `usage` or `finishReason` are dropped.

### The `ai:generate` hook

```ts
interface AiGenerateEvent {
	request: AiRunRequest;
	/** ID of the plugin that called ctx.ai.run() */
	source: string;
}

type AiGenerateHandler = (event: AiGenerateEvent, ctx: PluginContext) => Promise<AiRunResult>;
```

- It is exclusive, and registering it requires `hooks.ai-provider:register` (`HOOK_REQUIRED_CAPABILITY`). A plugin without the capability has the hook skipped, as with `email:deliver`.
- The provider applies its default model, its model allow-list and its token cap, and throws to refuse. The error reaches the caller unchanged and is logged as `[ai:generate] Provider "<id>" failed a request from "<source>"`.
- A provider sets its own hook `timeout`. The 5-second hook default is too short for most models; `cloudflareAI()` uses 120 seconds.
- **Recursion.** A provider that calls `ctx.ai.run()` is refused with `AiRecursionError`. Requests made while a provider is answering are caught through an `AsyncLocalStorage` guard. Requests whose `source` is the selected provider's own ID are refused as well, which also covers a sandboxed provider, whose calls arrive over RPC in a fresh async context.

### Provider selection

Selection reuses the exclusive-hook machinery unchanged:

- One active provider is selected automatically.
- With several, the selection is stored under `emdash:exclusive_hook:ai:generate`. It is changed through the existing `GET/PUT /_emdash/api/admin/hooks/exclusive[/:hookName]` routes, which require `settings:manage`.
- Deactivating the selected provider clears the selection, and `ctx.ai` becomes `undefined` on the next request.
- A plugin with a provider hook can be native or sandboxed. A sandboxed provider calls its model through `ctx.http`, within its own limits.

### Sandbox bridge

Both sandbox runners get the same addition as `email:send`:

- **`@emdash-cms/cloudflare`:**
  - The generated wrapper adds `ctx.ai = { run: (request) => bridge.aiRun(request) }` when the manifest declares `ai:run`.
  - `PluginBridge.aiRun()` checks `ai:run` against the bridge's props, which the plugin can't change, then calls the runner's AI callback with the bridge's plugin ID as `source`.
  - Without a callback it throws `AI is not configured. No AI provider is available.`
- **`@emdash-cms/sandbox-workerd`:** The same through an `ai/run` bridge call.
- **Runner wiring:** Runners expose `setAiRun(callback)` (optional on `SandboxRunner`, so other runners keep compiling). The runtime wires it to `AiPipeline.run` at startup.

`source` always comes from the host side, never from the request, so a plugin can't make its requests look like another plugin's.

### `cloudflareAI()` provider

A native plugin in `@emdash-cms/cloudflare/plugins` (entrypoint `@emdash-cms/cloudflare/plugins/cloudflare-ai`), modelled on `cloudflareEmail()`.

```ts
interface CloudflareAIConfig {
	/** Workers AI binding name. Default "AI". */
	binding?: string;
	/** AI Gateway id. Default "default". */
	gateway?: string;
	/** Model for requests that name none. Default "@cf/meta/llama-3.3-70b-instruct-fp8-fast". */
	defaultModel?: string;
	/** When set, the only model ids plugins may request. */
	models?: string[];
	/** Upper bound on output tokens for any request. */
	maxTokens?: number;
}
```

- **Routing.** It calls `env[binding].run(model, inputs, { gateway: { id, metadata: { plugin: source } } })`, so AI Gateway logs, caching, rate limits and spend limits apply, and logs show the calling plugin.
  - `@cf/…` ids run on Workers AI.
  - `provider/model` ids such as `anthropic/…`, `openai/…` and `google/…` run through AI Gateway unified billing, so third-party usage lands on the Cloudflare invoice.
- **Requests.** A model outside `models` is refused before the binding is called, and `maxTokens` caps the request's own value.
- **Anthropic.** Anthropic models get their system messages joined into the top-level `system` field and always get `max_tokens` (default 4096), because the Messages API requires both.
- **Answers.** It normalizes the answer shapes the binding returns: Workers AI `response`, OpenAI chat-completion `choices`, Anthropic `content` blocks and Responses API `output` items. It strips inline `<think>…</think>` reasoning and maps Anthropic's `max_tokens` stop reason to `length`.
- **Missing binding.** It fails with a message naming the wrangler setting to add.

### Registry: `declaredAccess`

[RFC 0001](../rfcs/0001-plugin-registry.md) defers new access categories, including host-pluggable hooks, to follow-on RFCs that specify the lexicon field and its runtime semantics together. This is one. `com.emdashcms.experimental.package.releaseExtension` gains an `ai` category:

```json
"ai": {
	"run": {},
	"provider": {}
}
```

- **`run`:** the plugin may send prompts to the host's AI provider and read the generated text, and usage is billed to the site owner's provider account.
- **`provider`:** the plugin becomes the host's AI provider and receives every AI request plugins on the site make, prompts included. It is exclusive, regardless of record contents.

No constraint keys are defined. Model allow-lists and token budgets are reserved for a follow-up. `capabilitiesToDeclaredAccess` and `declaredAccessToCapabilities` map `ai:run` ↔ `ai.run` and `hooks.ai-provider:register` ↔ `ai.provider`.

In RFC 0001's enforcement terms:

| Category and operation | What's enforced                                                                 | What's advisory      |
| ---------------------- | ------------------------------------------------------------------------------- | -------------------- |
| `ai.run`               | Whether the operation is granted at all.                                        | All constraint keys. |
| `ai.provider`          | Whether the plugin may register `ai:generate`. Exclusive: one provider answers. | All constraint keys. |

Because clients must reject unknown `declaredAccess` categories, older EmDash versions refuse to install a release that declares `ai`. That is correct: an older host has no `ctx.ai` and couldn't honour the grant. See Compatibility.

### Admin

- **Install consent.** The dialog shows the two labels in `CAPABILITY_LABELS`.
- **Settings → AI.** Modelled on Settings → Email: it shows the selected provider, lets the owner switch between active providers, and lists the installed plugins that declare `ai:run`. It uses the existing exclusive-hook routes and needs no new API. Its strings are wrapped for translation.

### Testing support

`@emdash-cms/plugin-test`'s runtime host registers a test provider, selected by default:

- `host.ai.respond(result)` queues the next answer.
- `host.ai.requests()` returns what was asked, with the calling plugin's `source`.
- `host.ai.clear()` resets both.

Plugin authors can then test `ctx.ai` from the isolate without a model.

### Runtime differences

- **Cloudflare (`@emdash-cms/cloudflare` sandbox runner):** sandboxed and trusted plugins get `ctx.ai`; `cloudflareAI()` is the provider.
- **Node with `@emdash-cms/sandbox-workerd`:** sandboxed plugins reach `ctx.ai` through the workerd bridge. There is no bundled provider, so a site needs a provider plugin that calls a model over HTTP.
- **Node without a sandbox:** trusted plugins get `ctx.ai` from any provider.
- **`astro dev` with the Cloudflare adapter:** `cloudflareAI()` needs remote bindings, because Workers AI only runs remotely. Without them the provider fails with the missing-binding error.

## Compatibility and migration

The change is additive:

- No existing API, hook or stored data changes.
- No database migration. The selection uses the existing options key pattern.
- Plugins that don't declare `ai:run` behave exactly as before.
- Sites without a provider see `ctx.ai === undefined` for plugins that declare it.

Compatibility is limited where the new capability crosses versions:

- A plugin built for this version that declares `ai:run` fails manifest validation on older hosts, where the capability is unknown, and older registry clients reject its `ai` `declaredAccess`. Plugin authors should set a minimum EmDash version once the release is known.
- The registry lexicon is still `experimental`.

Rollback is removing the provider plugin: `ctx.ai` disappears and calling plugins get their configured error path.

## Security and privacy

- **Credentials.** No credential reaches a calling plugin. The provider holds the binding or the API key, and the sandboxed caller sees only `ctx.ai.run()`.
- **Authorization.**
  - The bridge checks `ai:run` against host-side props on every call; the wrapper's check is a convenience, not the boundary.
  - The hook registry ignores `ai:generate` from plugins without `hooks.ai-provider:register`.
  - Changing the selected provider requires `settings:manage`.
- **Attribution.** `source` is set by the host from the bridge's plugin ID. A plugin can't spoof another plugin's identity to the provider or in gateway logs.
- **Untrusted input.** Requests are validated and stripped of unknown fields before any provider runs. Providers receive a bounded, documented shape. Results are validated before they reach the caller.
- **Prompts are data the provider sees.**
  - Any plugin with `content:read` and `ai:run` can send site content to the configured model provider. Today the same plugin with `network:request` can send it anywhere; with `ai:run` it goes only to the provider the site owner chose. The consent label says the site owner is billed, and the provider label says it sees all prompts.
  - The provider sees every plugin's prompts, which is why `hooks.ai-provider:register` is separate and labelled that way.
- **Cost.** A plugin can spend the site owner's AI budget. Mitigations:
  - the explicit consent label;
  - the provider's model allow-list and token cap;
  - per-plugin attribution in AI Gateway;
  - AI Gateway spend limits and rate limits on the gateway the provider uses;
  - the sandbox's own limits on how often a plugin runs.

  Core-level budgets are left open.

- **Recursion.** Providers can't call back into the pipeline (see the hook design).
- **Output.** Model output is untrusted text, like the response of a `ctx.http` call. Plugins that render it or write it to content must treat it that way.
- **Logging.** Provider errors are logged with the provider and caller IDs. Core never logs prompts or results. `cloudflareAI()` logs the caller, model and output token count.

## Performance

- **No hot-path cost.** Nothing runs unless a plugin calls `ctx.ai.run()`. Building `ctx.ai` is one map lookup for the selected provider.
- **Bridge calls.** A sandboxed call is one bridge call, like `ctx.email.send()`. The model call runs in the host Worker, so it doesn't count against the plugin's outbound requests. The plugin's 30-second wall time still includes the time the model takes.
- **Fewer requests than today.** It is fewer than the workaround's: no settings read for an encrypted key, and no `ctx.http` round trip through the bridge.
- **Validation.** It is linear in message count and length, well under a millisecond for typical requests.
- **Bundle.** `cloudflareAI()` is a separate entrypoint, so sites that don't register it don't load it.

## Failure handling

| Failure                                      | Caller sees                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| No provider, trusted plugin                  | `ctx.ai` is `undefined`                                                                                         |
| No provider, sandboxed plugin calling anyway | `AI is not configured. No AI provider is available.`                                                            |
| Missing `ai:run`                             | `ctx.ai` is `undefined`; the bridge rejects with `Missing capability: ai:run`                                   |
| Malformed request                            | `Invalid AI request: …`                                                                                         |
| Model not allowed, no credit, gateway error  | The provider's error, unchanged                                                                                 |
| Provider exceeds its hook timeout            | `Hook timeout after <n>ms`                                                                                      |
| Sandboxed caller exceeds its wall time       | The existing sandbox wall-time error. The provider's call still finishes and is billed; its result is discarded |
| Provider returns a malformed result          | `AI provider "<id>" returned an invalid result: …`                                                              |
| Provider calls `ctx.ai.run()`                | `AiRecursionError`                                                                                              |

- **Retries.** Core never retries. A model call can be expensive and not idempotent, so retries are the caller's decision.
- **Partial failure.** A plugin that gets an error writes nothing unless it chooses to.
- **Observability.** Provider failures appear in Workers Logs as `[ai:generate] …`, and AI Gateway logs every request with the calling plugin. When AI breaks for every plugin, the operator checks Settings → AI, the binding and the gateway's credit and limits.

## Verification

- **Unit (core):**
  - dispatch to the selected provider with `source`;
  - no provider;
  - provider errors;
  - each malformed-request case, with the provider never called;
  - malformed results;
  - both recursion paths;
  - hook registration skipped without `hooks.ai-provider:register`;
  - `ctx.ai` absent without the capability or a provider, and present and attributed with both.
- **Unit (`plugin-types`):** capability ↔ `declaredAccess` round trips for both facets, manifest schema acceptance, and capability descriptions.
- **Unit (`cloudflareAI()`):**
  - default model and gateway with plugin metadata;
  - token cap;
  - allow-list refusal without a binding call;
  - Anthropic reshaping;
  - the missing-binding message;
  - every answer shape;
  - reasoning stripping;
  - the hook timeout.
- **Bridge:**
  - Cloudflare: `aiRun` rejects without the capability and without a callback, and passes the bridge's own plugin ID.
  - `sandbox-workerd`: the same through `ai/run`.
- **End to end:**
  - `@emdash-cms/plugin-test` runs a fixture plugin in a real isolate, calls `ctx.ai.run()` from a route and asserts the answer and the recorded `source`.
  - The registry inventory test covers the new capabilities, the hook and the `ai` facet.
- **Admin:** the consent label list and the Settings → AI page, including the multiple-provider and no-provider states.
- **Manual:**
  - Deploy a site with `cloudflareAI()` and a sandboxed plugin that declares `ai:run`.
  - Run one `@cf/…` and one `anthropic/…` request.
  - Check the AI Gateway log shows `metadata.plugin`.
  - Confirm an allow-list refusal and a missing binding produce the documented errors.

A prototype of everything except Settings → AI is in the [`feat/plugin-ai-access` branch of my fork](https://github.com/Thijmen/emdash/tree/feat/plugin-ai-access), with the tests above passing.

## Rollout and implementation

1. **Core contract:**
   - the capabilities, types, hook, `AiPipeline` and `ctx.ai`;
   - the manifest schemas;
   - the capability descriptions and consent labels;
   - the `declaredAccess` mapping and lexicon;
   - the plugin-test provider;
   - docs (capabilities, hooks reference).
2. **Sandbox bridges:** the Cloudflare and workerd runners and wrappers, with their tests.
3. **`cloudflareAI()`:** the provider and its Cloudflare deployment docs.
4. **Settings → AI:** the admin page.

Slices 1 to 3 can land as one pull request; the prototype has them together and they're only useful together. Slice 4 can follow. With one provider it is auto-selected, and the exclusive-hook API already allows switching. No feature flag: nothing changes until a site registers a provider and installs a plugin that declares `ai:run`. Each published package gets a changeset.

## Alternatives

- **Keep API keys in plugin settings.** This is what plugins do now. It works on every host, but it has the credential, review and spend problems above, and it needs `EMDASH_ENCRYPTION_KEY`.
- **Pass the `AI` binding into the sandboxed isolate.** Worker Loader can give an isolate bindings, but the plugin would get the whole binding:
  - every model, with no allow-list;
  - no attribution, because the plugin could set its own gateway metadata;
  - no limits except Cloudflare's.

  It would also tie the plugin API to Cloudflare.

- **A generic `bindings:<name>` capability.** It has the same problems, multiplied, and makes plugins depend on the host's wrangler config.
- **A core AI client without a hook.** Core could call `env.AI` itself. That fixes the provider to Cloudflare and duplicates the exclusive-hook machinery email already uses, and site owners couldn't bring their own provider.
- **A native companion plugin with a sandboxed plugin calling it over HTTP.** The site owner still needs a native install and a deploy, and the HTTP route needs its own authentication.
- **An OpenAI-compatible wire format as the contract.** It is richer, but it imports one vendor's evolving schema as EmDash's public API. A small, owned shape is easier to keep stable, and providers translate.

## Drawbacks

- **Surface.** It adds a public API, two capabilities, a hook and a registry category that EmDash maintains.
- **Lowest common denominator.** No streaming, tools or images until follow-ups land. Plugins that need them will keep using `network:request`.
- **Provider-specific model ids.** They leak into plugin settings; there is no portable model name.
- **Cost exposure.** Every plugin that declares `ai:run` can spend the site owner's money. The consent label and AI Gateway limits mitigate it, but core doesn't enforce budgets.

## Open questions

- **Budgets.** Should core enforce per-plugin request or token budgets? Should `ai.run` constraints in `declaredAccess` (for example a declared token ceiling) be defined now, or in a follow-up?
- **Models.** Should plugins be able to discover the provider's allowed models and default (`ctx.ai.models()`), so they can offer a picker instead of a free-text model id?
- **Names.** Are `ai:run`, `hooks.ai-provider:register` and `ai:generate` the right names? `ai:generate` leaves room for `ai:embed` later.
- **A neutral provider.** Should EmDash also ship an OpenAI-compatible HTTP provider for non-Cloudflare hosts, or leave that to the registry?
- **Size limits.** Is 200 messages × 1,000,000 characters the right request limit, given RPC payload limits on the bridge?
