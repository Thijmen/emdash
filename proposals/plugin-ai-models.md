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

Plugins, including sandboxed plugins installed from the registry, call AI models through one provider that the site owner configures. The pieces:

- **`ai:run`.** A plugin declares the capability and calls `ctx.ai.run()` with messages and, optionally, tools.
- **`ai:generate`.** One exclusive provider hook answers the call. Registering it requires `hooks.ai-provider:register`.
- **`cloudflareAI()`.** A provider in `@emdash-cms/cloudflare/plugins` that answers through the Worker's `AI` binding. It runs Workers AI models and, through AI Gateway unified billing, third-party models such as `anthropic/…` and `openai/…`.
- **`declaredAccess`.** The registry gains an `ai` category, so install consent shows AI use.

The design follows `email:send`. The calling plugin never holds a credential, and the site owner chooses models, limits and the gateway in one place.

## Problem and user case

On Cloudflare, an EmDash site's Worker can have an `AI` binding. Through it, the Worker runs Workers AI models and, with AI Gateway unified billing, third-party models, all billed to the Cloudflare account without provider API keys. Plugins can't use it:

- A sandboxed plugin's isolate gets `PLUGIN_ID`, `PLUGIN_VERSION` and the bridge, no bindings, and no network except `ctx.http`.
- A trusted plugin can import `env` from `cloudflare:workers`, as `@emdash-cms/plugin-ai-moderation` does to run Llama Guard. That plugin only works in-process and can't be installed from the registry. Each such plugin also reimplements model routing, gateway options, tool-call formats and response parsing for each model family.

A registry plugin that needs a model asks every site owner to:

1. create a Cloudflare API token with Workers AI access and look up the account ID;
2. set `EMDASH_ENCRYPTION_KEY` so the plugin can store the token as a secret setting;
3. paste both into the plugin's settings.

That approach has three problems:

- **Token reach.** The token can run any model on the account.
- **Review.** The site owner reviews `network:request` to `api.cloudflare.com`, which doesn't say "runs AI models".
- **Attribution.** Spend is attributed per plugin only when each plugin sends its own gateway metadata.

The author's site runs a native AI writer that uses the `AI` binding with tool calls (search the site, fill fields) and saves drafts. Its sandboxed registry edition has to use the token setup above.

The email pipeline already solves the same shape. Plugins declare `email:send`, an exclusive `email:deliver` provider such as `cloudflareEmail()` holds the `send_email` binding, and the site owner configures it once. This RFC applies that design to AI models.

## Example

The site owner registers the provider once. A site that already uses Workers AI has the binding.

```jsonc title="wrangler.jsonc"
{ "ai": { "binding": "AI" } }
```

```js title="astro.config.mjs"
import { cloudflareAI } from "@emdash-cms/cloudflare/plugins";

emdash({
	plugins: [
		cloudflareAI({
			defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "anthropic/claude-sonnet-5"],
			maxTokens: 4000,
		}),
	],
});
```

A sandboxed plugin declares the capability:

```jsonc title="emdash-plugin.jsonc"
{
	"id": "related-reading",
	"capabilities": ["ai:run", "content:read"],
}
```

The plugin writes a related-reading paragraph. It lets the model search the site and runs the tool calls itself:

```ts title="src/plugin.ts"
const tools: AiTool[] = [
	{
		name: "search_content",
		description: "Search published entries on this site. Returns titles and URLs.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
	},
];
const messages: AiMessage[] = [
	{
		role: "system",
		content: "Write one paragraph of related reading. Link only to search results.",
	},
	{ role: "user", content: entryText },
];

for (let step = 0; step < 3; step++) {
	const result = await ctx.ai!.run({
		model: "anthropic/claude-sonnet-5",
		messages,
		tools,
		maxTokens: 800,
		timeoutMs: 8_000,
		metadata: { entry: entryId },
		promptCacheKey: `related:${entryId}`,
	});
	if (result.toolCalls.length === 0) return result.text;

	messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
	for (const call of result.toolCalls) {
		messages.push({
			role: "tool",
			toolCallId: call.id,
			content: JSON.stringify(await runTool(call, ctx)),
		});
	}
}
```

The install dialog lists "Run AI models through your site's AI provider, billed to your account". The AI Gateway log shows each of the three requests with `plugin: related-reading` and `entry: <id>`. On Anthropic models, the second and third requests can read the first request's prompt prefix from the cache.

## Goals

- Let sandboxed and trusted plugins run text-generation models, with tool calling, without holding credentials.
- Keep credentials, model choice and spend limits with the site owner, in one provider.
- Make a Cloudflare site's setup two lines: the `AI` binding and `cloudflareAI()`. That covers Workers AI models and third-party models through unified billing.
- Give plugin authors one request and result shape for every model family, with errors they can branch on.
- Make AI use a reviewable grant in the manifest, in `declaredAccess` and in install consent.
- Attribute every request to the calling plugin, so providers and AI Gateway can log, limit and bill per plugin.
- Keep the provider replaceable: any plugin with `hooks.ai-provider:register` can answer, on any runtime.

## Non-goals

- **Streaming.** Results arrive complete, because the sandbox bridge buffers responses.
- **Work that outlives one plugin invocation.** A sandboxed plugin's tool loop runs inside its 30-second wall time. Longer agent sessions, run by EmDash across invocations, need their own proposal.
- **Forcing a tool or a JSON response format.** See Open questions.
- **Images, audio and embeddings.** These can follow as optional message parts or new operations, such as `ai:embed`, without changing `ai:run`.
- **Per-plugin budgets in core.** The provider receives the caller's ID, and AI Gateway has spend limits and rate limits.
- **Providers other than Cloudflare.** This RFC ships one; the hook is the extension point.
- **Migrating `ai-moderation`.** It can move to `ctx.ai` later.
- **Defending against prompt injection.** Model output, including tool-call input, is untrusted data. What a plugin does with it stays the plugin's responsibility.

## Detailed design

### Capabilities

Two capabilities join `PluginCapability`, `CURRENT_PLUGIN_CAPABILITIES`, the plugin CLI's manifest schema and `capability-descriptions.ts`:

| Capability                   | Grants                                       | Install consent label                                                     |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `ai:run`                     | `ctx.ai.run()`                               | Run AI models through your site's AI provider, billed to your account     |
| `hooks.ai-provider:register` | Registering the exclusive `ai:generate` hook | Answer all AI requests from plugins on your site, including their prompts |

They are separate for the same reason `email:send` and `hooks.email-transport:register` are separate. Running a model and receiving every plugin's prompts are different levels of trust.

### `ctx.ai`

`ctx.ai` is defined when the plugin declares `ai:run` and a provider is selected; otherwise it is `undefined`, like `ctx.email`. The types are exported from `emdash` and `emdash/plugin`.

```ts
interface AiAccess {
	run(request: AiRunRequest): Promise<AiRunResult>;
}

interface AiRunRequest {
	/** Model id as the provider names it. Omit for the provider's default model. */
	model?: string;
	messages: AiMessage[];
	/** Tools the model may call. The plugin runs them and sends results back as tool messages. */
	tools?: AiTool[];
	maxTokens?: number;
	temperature?: number;
	/** Reject with AI_TIMEOUT after this long. */
	timeoutMs?: number;
	/** Extra entries for the provider's request log, such as a session or entry id. */
	metadata?: Record<string, string | number | boolean>;
	/** Groups calls that share a prompt prefix, such as the steps of one conversation. */
	promptCacheKey?: string;
}

type AiMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: AiToolCall[] }
	| { role: "tool"; toolCallId: string; content: string };

interface AiTool {
	name: string;
	description: string;
	/** JSON Schema for the tool's input. Must have type "object". */
	inputSchema: Record<string, unknown>;
}

interface AiToolCall {
	id: string;
	name: string;
	/** The parsed arguments, or the raw string when the model's arguments aren't valid JSON. */
	input: unknown;
}

interface AiRunResult {
	text: string;
	/** Empty when the model called no tools. */
	toolCalls: AiToolCall[];
	/** The model that answered, as the provider reports it. */
	model: string;
	finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "other";
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
}
```

Model ids are provider-specific strings. A plugin that omits `model` works with any provider. A plugin that names one should let the site owner change it in its settings.

### Tool calls

The plugin owns the tool loop.

1. The plugin sends `tools`.
2. A result with `finishReason: "tool_calls"` lists the calls.
3. The plugin runs each call, appends the assistant message with its `toolCalls`, and appends one `tool` message per call with the matching `toolCallId`.
4. The plugin calls `run()` again.

Each `run()` is one bridge call, so a sandboxed plugin's loop fits within its wall time and outgoing-call limit when its models are fast.

- **Ids.** The provider returns a unique, non-empty `id` for every call. It generates one when the model returns none; some Workers AI models don't.
- **Input.** `input` is parsed JSON. When the model's arguments aren't valid JSON, `input` is the raw string, so the plugin can send the parse error back to the model as the tool result.
- **Untrusted input.** Tool names and input come from the model. The plugin validates input against its own schema before acting on it, and answers unknown tool names with an error result.

### Request validation

`AiPipeline` in core validates every request before a provider sees it. A sandboxed plugin's request arrives over RPC and is untrusted. A request that fails validation rejects with `AI_INVALID_REQUEST` and a message naming the field. No provider runs.

**Size**

- The JSON-serialized request is at most 4 MB.
- `messages` holds 1 to 500 messages.
- `tools` holds at most 128 tools.

**Messages**

- `system` messages come before every other message.
- `system` and `user` content is a non-empty string.
- `assistant` content is a string, and may be empty only when the message has `toolCalls`.
- Each `toolCalls` entry has a non-empty `id` and the `name` of a tool in `tools`.
- Every `tool` message follows an assistant message with tool calls.
- Each tool call is answered by exactly one `tool` message before the next non-tool message.

**Tools**

- Tool names match `^[a-zA-Z0-9_-]{1,64}$` and are unique.
- Each `description` is a non-empty string.
- Each `inputSchema` is an object whose `type` is `"object"`.

**Options**

- `model`, when present, is a non-empty string.
- `maxTokens` is a positive integer.
- `temperature` is a finite number of at least 0.
- `timeoutMs` is an integer from 1,000 to 600,000.
- `metadata` holds at most 4 entries.
  - Keys match `^[a-zA-Z0-9_.:-]{1,64}$` and aren't `plugin`.
  - Values are booleans, finite numbers or strings of at most 256 characters.
- `promptCacheKey` matches `^[a-zA-Z0-9_.:-]{1,128}$`.

Unknown fields are dropped, so a provider receives only the documented shape.

The pipeline also normalizes the provider's result:

- **Required fields.** `text` and `model` must be strings, and `toolCalls` must be an array of calls with string `id` and `name`. Otherwise the call rejects with `AI_INVALID_RESULT`.
- **Defaults.** A missing `toolCalls` becomes `[]`, an unknown `finishReason` becomes `"other"`, and malformed `usage` is dropped.

### Timeouts

The pipeline rejects with `AI_TIMEOUT` once `timeoutMs` has passed, whether or not the provider has answered. The provider receives `timeoutMs` and passes it on, so the model call stops as well. `cloudflareAI()` sets the gateway's `requestTimeoutMs`.

For sandboxed callers, the bridge caps `timeoutMs` at the sandbox wall-time limit, 30 seconds by default. When the request sets none, it uses that limit. A call abandoned by a killed invocation therefore can't keep running, or keep billing, much past the invocation.

Without `timeoutMs`, a trusted caller waits up to the provider's hook timeout.

### Gateway metadata

The provider receives the caller's plugin ID as `source` and the request's `metadata`.

`cloudflareAI()` sends `plugin: <source>` as the first AI Gateway metadata entry, then the request's entries. AI Gateway stores at most five entries per request. The validation limit of four plugin entries keeps `plugin` from being dropped. A plugin can't set `plugin` itself, so it can't attribute its requests to another plugin.

### Prompt caching

`promptCacheKey` marks calls that repeat a prompt prefix. Providers use it where the model supports caching and ignore it elsewhere. `cloudflareAI()` maps it per model family (see the table under `cloudflareAI()`). The result's `usage.cacheReadTokens` and `usage.cacheWriteTokens` report what the provider read from or wrote to its cache, when the model reports it.

### Errors

`ctx.ai.run()` rejects with an `AiError` whose `code` is stable. It is exported from `emdash/plugin`.

| `code`                 | Meaning                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AI_NOT_CONFIGURED`    | No provider is selected. Trusted callers see `ctx.ai === undefined` instead; sandboxed callers get this from the bridge.   |
| `AI_INVALID_REQUEST`   | The request failed validation. The message names the field.                                                                |
| `AI_MODEL_NOT_ALLOWED` | The provider doesn't serve the model, or the site doesn't allow it.                                                        |
| `AI_TIMEOUT`           | `timeoutMs` passed.                                                                                                        |
| `AI_RATE_LIMITED`      | The provider or gateway rate-limited the request.                                                                          |
| `AI_PROVIDER_ERROR`    | Any other provider failure, such as no credit, a gateway auth error, or an upstream error. The provider's message is kept. |
| `AI_INVALID_RESULT`    | The provider returned a malformed result.                                                                                  |
| `AI_RECURSION`         | A provider called `ctx.ai.run()`.                                                                                          |

Providers throw `new AiError(code, message)` for `AI_MODEL_NOT_ALLOWED`, `AI_RATE_LIMITED` and `AI_PROVIDER_ERROR`. Any other error a provider throws becomes `AI_PROVIDER_ERROR`, with its message kept.

The sandbox bridge returns `{ ok: false, error: { code, message } }`, and the wrapper rethrows it as an error with `name: "AiError"` and `code`, the way redirect access errors cross the bridge today. A sandboxed plugin without `ai:run` still gets `Missing capability: ai:run`, like every other capability.

### The `ai:generate` hook

```ts
interface AiGenerateEvent {
	/** The validated request. For sandboxed callers, timeoutMs is already capped. */
	request: AiRunRequest;
	/** ID of the plugin that called ctx.ai.run() */
	source: string;
}

type AiGenerateHandler = (event: AiGenerateEvent, ctx: PluginContext) => Promise<AiRunResult>;
```

- **Exclusive and gated.** Exactly one provider answers. Registering the hook requires `hooks.ai-provider:register` through `HOOK_REQUIRED_CAPABILITY`. The hook registry skips the hook for a plugin without the capability, as it does for `email:deliver`.
- **Provider policy.** The provider applies its own default model, model allow-list and token cap, and throws an `AiError` to refuse a request. The pipeline logs failures as `[ai:generate] Provider "<id>" failed a request from "<source>"`, without the prompt.
- **Timeout.** A provider sets its own hook `timeout`; the 5-second hook default is too short for most models. `cloudflareAI()` uses 120 seconds.
- **Recursion.** A provider that calls `ctx.ai.run()` is refused with `AI_RECURSION`. Two checks cover this:
  - An `AsyncLocalStorage` guard catches calls made in-process while a provider is answering.
  - Requests whose `source` is the selected provider's ID are refused too. This covers a sandboxed provider, whose calls arrive over RPC in a fresh async context.

### Provider selection

Selection reuses the exclusive-hook machinery unchanged:

- When one provider is active, it is selected automatically.
- With several, the selection is stored under `emdash:exclusive_hook:ai:generate` and changed through the existing `GET` and `PUT /_emdash/api/admin/hooks/exclusive[/:hookName]` routes, which require `settings:manage`.
- Deactivating the selected provider clears the selection, and `ctx.ai` is `undefined` from the next request.
- A provider plugin can be native or sandboxed. A sandboxed provider calls its model over `ctx.http`, within its own limits.

### Sandbox bridges

Both sandbox runners get the same addition `email:send` has.

- **`@emdash-cms/cloudflare`.** The generated wrapper defines `ctx.ai` when the manifest declares `ai:run`. `PluginBridge.aiRun()` does the rest:
  - It checks `ai:run` against the bridge's host-side props.
  - It caps `timeoutMs`.
  - It calls the runner's AI callback, with the bridge's plugin ID as `source`.
- **`@emdash-cms/sandbox-workerd`.** The same, through an `ai/run` bridge call.
- **Runners.** They expose an optional `setAiRun(callback)` on `SandboxRunner`, so other runners keep compiling. The runtime wires it to `AiPipeline.run()` at startup.

`source` always comes from the host side, never from the request.

### `cloudflareAI()`

`cloudflareAI()` is a native plugin in `@emdash-cms/cloudflare/plugins`, modelled on `cloudflareEmail()`. Its entrypoint is `@emdash-cms/cloudflare/plugins/cloudflare-ai`.

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

Every request goes through one call:

```ts
env[binding].run(model, inputs, {
	gateway: { id: gateway, metadata: { plugin: source, ...metadata }, requestTimeoutMs },
	extraHeaders,
});
```

That call means AI Gateway's logs, rate limits and spend limits apply to every request:

- `@cf/…` ids run on Workers AI.
- `provider/model` ids run through AI Gateway unified billing and are billed to the Cloudflare account.

Before calling, the provider:

- refuses a model outside `models` with `AI_MODEL_NOT_ALLOWED`;
- caps `maxTokens`;
- fails with `AI_PROVIDER_ERROR`, naming the wrangler setting to add, when the binding is missing.

It translates the request to each model family's wire format:

| Model ids                                  | Wire format                                                                         | Tools                                                                                                                     | `promptCacheKey`                                           | Cache usage                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `@cf/…`                                    | Workers AI `messages`                                                               | Function-style `tools`. Calls are read from top-level `tool_calls` or from `choices`, and ids are generated when missing. | `x-session-affinity` header, for Workers AI prefix caching | As the model reports it                                  |
| `anthropic/…`                              | Anthropic Messages: `system` as a string, `max_tokens` always set (4096 by default) | `tools[].input_schema`, `tool_use` and `tool_result` blocks; consecutive tool messages merged into one user turn          | `cache_control` breakpoint on the last message             | `cache_read_input_tokens`, `cache_creation_input_tokens` |
| `openai/…`, other ids on the OpenAI format | Chat completions                                                                    | `tools[].function`, `tool_calls`, `role: "tool"`                                                                          | `prompt_cache_key`                                         | `usage.prompt_tokens_details.cached_tokens`              |

Families that need another format, such as Google's, which `workers-ai-provider` translates separately, need a translation of their own. Until a family has one, the provider refuses its models with `AI_MODEL_NOT_ALLOWED`.

The provider normalizes every answer to `AiRunResult`:

- It strips inline `<think>…</think>` reasoning from `text`.
- It maps stop reasons to `finishReason`: Anthropic's `max_tokens` becomes `length`, and `tool_use` becomes `tool_calls`.

### Registry: `declaredAccess`

[RFC 0001](../rfcs/0001-plugin-registry.md) defers new access categories, including host-pluggable hooks, to follow-on RFCs that specify the lexicon field and its runtime semantics together. This RFC is one of them.

`com.emdashcms.experimental.package.releaseExtension` gains an `ai` category:

```json
"ai": {
	"run": {},
	"provider": {}
}
```

- **`run`:** the plugin may send prompts to the host's AI provider and read the results, and usage is billed to the site owner's provider account.
- **`provider`:** the plugin becomes the host's AI provider and receives every AI request plugins on the site make, prompts included. It is exclusive, regardless of record contents.

No constraint keys are defined, and model allow-lists and token budgets are reserved for a follow-up. `capabilitiesToDeclaredAccess()` and `declaredAccessToCapabilities()` map `ai:run` to `ai.run` and `hooks.ai-provider:register` to `ai.provider`.

In RFC 0001's enforcement terms:

| Category and operation | What's enforced                                                                 | What's advisory      |
| ---------------------- | ------------------------------------------------------------------------------- | -------------------- |
| `ai.run`               | Whether the operation is granted at all.                                        | All constraint keys. |
| `ai.provider`          | Whether the plugin may register `ai:generate`. Exclusive: one provider answers. | All constraint keys. |

### Admin

- **Install consent.** The dialog shows the two labels from the capability table. They are added to `CAPABILITY_LABELS` and wrapped for translation.
- **Settings → AI.** This page is modelled on Settings → Email:
  - It shows the selected provider, and switches between active providers through the existing exclusive-hook routes.
  - It lists the installed plugins that declare `ai:run`.
  - It needs no new API, and its strings are wrapped for translation.

### Testing support

`@emdash-cms/plugin-test`'s runtime host registers a test provider and selects it by default:

- `host.ai.respond(result)` queues the next result, tool calls included.
- `host.ai.fail(code, message)` queues an error.
- `host.ai.requests()` returns the requests received, each with the calling plugin's `source`.
- `host.ai.clear()` resets the queue and the recorded requests.

Plugin authors can test a tool loop from the isolate without a model.

### Runtime differences

- **Cloudflare.** Sandboxed and trusted plugins get `ctx.ai`, and `cloudflareAI()` is the provider.
- **Node with `@emdash-cms/sandbox-workerd`.** Sandboxed plugins reach `ctx.ai` through the workerd bridge. No provider is bundled, so the site needs a provider plugin that calls a model over HTTP.
- **Node without a sandbox.** Trusted plugins get `ctx.ai` from any provider.
- **`astro dev` with the Cloudflare adapter.** `cloudflareAI()` needs remote bindings, because Workers AI only runs remotely. Without them, requests fail with the missing-binding error.

## Compatibility and migration

The change is additive:

- No existing API, hook or stored data changes, and there is no database migration.
- Provider selection uses the existing option key pattern.
- Plugins that don't declare `ai:run` behave as before.
- On sites without a provider, plugins that declare `ai:run` see `ctx.ai === undefined`, or `AI_NOT_CONFIGURED` from the sandbox bridge.

A plugin that declares `ai:run` fails manifest validation on older hosts, because their capability enum doesn't include it. Older registry clients reject its `ai` `declaredAccess`. Plugin authors set a minimum EmDash version once the release is known.

Rollback is removing the provider plugin. `ctx.ai` then disappears, and calling plugins take their "AI not configured" path.

## Security and privacy

- **Credentials.** No credential reaches a calling plugin. The provider holds the binding or API key.
- **Authorization:**
  - The bridge checks `ai:run` against host-side props on every call. The wrapper's check isn't the boundary.
  - The hook registry ignores `ai:generate` from plugins without `hooks.ai-provider:register`.
  - Changing the selected provider requires `settings:manage`.
- **Attribution.** The host sets `source` from the bridge's plugin ID, and the `plugin` metadata key is reserved. A plugin can't make its requests look like another plugin's, to the provider or in gateway logs.
- **Untrusted requests.** Requests are validated, size-limited and stripped of unknown fields before a provider runs. Results are validated before the caller sees them.
- **Prompts go to the provider.**
  - A plugin with `content:read` and `ai:run` can send site content to the configured model provider. With `network:request`, the same plugin can already send it anywhere; with `ai:run`, it goes only to the provider the site owner chose.
  - The provider sees every plugin's prompts and tool definitions, which is why `hooks.ai-provider:register` is separate and labelled that way.
- **Tool calls.** EmDash never executes a tool. The plugin runs its own code with its own capabilities, so a model can't do more than the plugin could already do. Tool input is model output, and plugins must validate it.
- **Cost.** A plugin can spend the site owner's AI budget. Mitigations:
  - the explicit consent label;
  - the provider's model allow-list and token cap;
  - the sandbox timeout cap;
  - per-plugin attribution and AI Gateway spend and rate limits.

  Core-level budgets are an open question.

- **Logging.** Core logs provider failures with provider and caller IDs, never prompts, tool input or results. `cloudflareAI()` logs the caller, model and token counts.

## Performance

- **Idle cost.** Nothing runs until a plugin calls `ctx.ai.run()`. Logged-out routes are unaffected. Building `ctx.ai` is one lookup of the selected provider.
- **Bridge.** A sandboxed call is one bridge call, like `ctx.email.send()`. The model call runs in the host Worker and doesn't count toward the plugin's outgoing calls, but the plugin's wall time includes the wait.
- **Compared with the workaround.** It saves the secret-setting read and the `ctx.http` round trip per call.
- **Validation.** It is linear in request size. The 4 MB cap bounds both validation and the RPC payload.
- **Bundle.** `cloudflareAI()` is a separate entrypoint, so sites that don't register it don't load it.

## Failure handling

| Failure                                       | Caller sees                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| No provider                                   | `ctx.ai === undefined` (trusted) or `AI_NOT_CONFIGURED` (sandboxed)    |
| Missing `ai:run`                              | `ctx.ai === undefined`; the bridge throws `Missing capability: ai:run` |
| Malformed request                             | `AI_INVALID_REQUEST`, naming the field                                 |
| Model not allowed or not served               | `AI_MODEL_NOT_ALLOWED`                                                 |
| `timeoutMs` passed                            | `AI_TIMEOUT`; the gateway stops the model call                         |
| Rate limited                                  | `AI_RATE_LIMITED`                                                      |
| No credit, gateway auth error, upstream error | `AI_PROVIDER_ERROR` with the provider's message                        |
| Provider exceeds its hook timeout             | `AI_TIMEOUT`                                                           |
| Malformed provider result                     | `AI_INVALID_RESULT`                                                    |
| Provider calls `ctx.ai.run()`                 | `AI_RECURSION`                                                         |

- **Retries.** Core never retries, because model calls cost money and aren't idempotent. Retrying is the caller's decision, guided by `code`.
- **Partial failure.** A tool loop that fails midway has written nothing unless the plugin chose to. Its earlier tool calls were the plugin's own actions.
- **Observability.** Provider failures appear in Workers Logs as `[ai:generate] …`, and AI Gateway logs every request with `plugin` and the plugin's metadata.
- **When AI fails for every plugin,** the operator checks Settings → AI, the binding, and the gateway's credit and limits.

## Verification

- **Core unit tests:**
  - dispatch to the selected provider with `source`;
  - every validation rule, with the provider never called;
  - result normalization and `AI_INVALID_RESULT`;
  - `AI_TIMEOUT` from the pipeline's own timer;
  - error-code mapping for provider errors;
  - both recursion paths;
  - hook registration skipped without `hooks.ai-provider:register`;
  - `ctx.ai` gating by capability and provider.
- **`plugin-types` unit tests:**
  - capability and `declaredAccess` round trips for both operations;
  - manifest schema acceptance;
  - capability descriptions.
- **`cloudflareAI()` unit tests, per wire format:**
  - request translation, including tools, tool results and `promptCacheKey`;
  - result normalization, including tool calls, generated ids, `<think>` stripping, stop reasons and cache usage;
  - the allow-list, the token cap and metadata ordering;
  - the timeout mapping to `requestTimeoutMs` and the missing-binding error;
  - the 120-second hook timeout.
- **Bridges:**
  - `aiRun` rejects without the capability and without a provider;
  - it caps `timeoutMs`;
  - it passes the bridge's own plugin ID;
  - it carries `code` across the bridge, in both the Cloudflare and workerd runners.
- **End to end.** `@emdash-cms/plugin-test` runs a fixture plugin in a real isolate:
  - a two-step tool loop through `ctx.ai.run()`, asserting the requests, the recorded `source` and the final text;
  - an error path that branches on `code`.

  The registry inventory test covers the new capabilities, the hook and the `ai` category.

- **Admin.** The consent label list, and Settings → AI with one provider, several providers and none.
- **Manual:**
  - Deploy a site with `cloudflareAI()` and a sandboxed plugin that declares `ai:run`.
  - Run one `@cf/…` and one `anthropic/…` tool loop.
  - Confirm the gateway log shows `plugin` and the plugin's metadata, and that cached tokens appear on the second Anthropic step.
  - Check a disallowed model, an expired timeout and a missing binding.

## Rollout and implementation

1. **Core contract:**
   - capabilities, types, `AiError`, hook, `AiPipeline` and `ctx.ai`;
   - the manifest schemas;
   - capability descriptions and consent labels;
   - the `declaredAccess` mapping and lexicon;
   - the plugin-test provider;
   - docs (capabilities, hooks reference).
2. **Sandbox bridges.** The Cloudflare and workerd runners and wrappers, with error codes and the timeout cap.
3. **`cloudflareAI()`.** The provider, its three wire formats and its Cloudflare deployment docs.
4. **Settings → AI.** The admin page.

Slices 1 to 3 land in one implementation pull request, because none is useful without the others. Slice 4 can follow: a single provider is selected automatically, and the existing exclusive-hook routes allow switching. No feature flag is needed, because nothing changes until a site registers a provider and installs a plugin that declares `ai:run`. Each published package gets a changeset.

A prototype on the [`feat/plugin-ai-access` branch of the author's fork](https://github.com/Thijmen/emdash/tree/feat/plugin-ai-access) implements the text-only path through slices 1 to 3. It covers the capabilities, the hook, validation, both bridges, `cloudflareAI()` for the three formats, the test host and docs, with unit tests and an isolate end-to-end test. Not yet prototyped:

- tool calls;
- `timeoutMs` and the bridge cap;
- `metadata` and `promptCacheKey`;
- cache usage;
- `AiError` codes;
- Settings → AI.

## Alternatives

- **Keep API keys in plugin settings.** This works on every host, but it has the credential, review and attribution problems described above, and it requires `EMDASH_ENCRYPTION_KEY`.
- **Pass the `AI` binding into the sandboxed isolate.**
  - It exposes every model, without an allow-list.
  - It loses attribution, because the plugin sets its own gateway metadata.
  - It leaves no limits except Cloudflare's.
  - It ties the plugin API to Cloudflare.
- **A generic `bindings:<name>` capability.** It has the same problems for every binding, and plugins would depend on each site's wrangler config.
- **A core AI client without a hook.** Core could call `env.AI` directly. That fixes the provider to Cloudflare, duplicates the exclusive-hook design email already uses, and stops site owners bringing their own provider.
- **OpenAI's chat-completions format as the contract.** Many models accept it, and plugin authors know it. It also brings a vendor-controlled, changing schema into EmDash's public API, with fields no other provider maps. A smaller EmDash-owned shape is easier to validate and keep stable, and providers translate. This is an open question for Maintainers.
- **Core-run tool execution.** EmDash could run tools itself, declared in the manifest like `mcp.tools`. That belongs with long-running sessions, where EmDash drives the loop across invocations. A plugin-run loop covers the single-invocation case without new execution paths.

## Drawbacks

- **Maintenance.** The design adds a public API, two capabilities, a hook, an error type and a registry category that EmDash maintains.
- **Translation code.** `cloudflareAI()` carries a translation for each model family, and every new family needs one.
- **Lowest common denominator.** There is no streaming, forced tool choice, images or JSON mode until follow-ups land.
- **Model ids.** They are provider-specific and leak into plugin settings.
- **Cost exposure.** Every plugin that declares `ai:run` can spend the site owner's money. Consent, the provider's limits and AI Gateway mitigate this, and core doesn't enforce budgets.

## Open questions

- **Contract shape.** Should the contract stay EmDash-owned, as specified here, or follow OpenAI's chat-completions format?
- **Budgets.** Should core enforce per-plugin request or token budgets, and should `ai.run` constraint keys, such as a declared token ceiling, be defined in this RFC?
- **Tool choice and JSON mode.** Should the request support forcing a tool (`toolChoice`) or a JSON response format? Workers AI models support both unevenly.
- **Model discovery.** Should plugins be able to read the provider's allowed models and default model, through `ctx.ai.models()`, to offer a picker instead of a free-text id?
- **Names.** Are `ai:run`, `hooks.ai-provider:register` and `ai:generate` the right names, leaving room for `ai:embed`?
- **Size limits.** Is a 4 MB request limit right for the sandbox bridge's RPC payloads and for models with large context windows?
