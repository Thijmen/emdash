/**
 * Cloudflare AI Provider Plugin
 *
 * Answers every `ctx.ai.run()` call on the site through the Worker's `AI`
 * binding: Workers AI models (`@cf/…`) and third-party models
 * (`openai/…`, `anthropic/…`, `google/…`) through AI Gateway unified billing.
 * Plugins that declare `ai:run` never see a credential; the site owner
 * configures the provider once.
 *
 * Registers `ai:generate` as an exclusive hook. EmDash selects this plugin
 * automatically when it is the only active AI provider.
 *
 * @example
 * ```typescript
 * // astro.config.mjs
 * import emdash from "emdash/astro";
 * import { cloudflareAI } from "@emdash-cms/cloudflare/plugins";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [cloudflareAI({ defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })],
 *     }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "ai": { "binding": "AI" }
 * }
 * ```
 */

import type { PluginContext, PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";
import type { AiGenerateEvent, AiMessage, AiRunResult } from "emdash/plugin";

export interface CloudflareAIConfig {
	/**
	 * Name of the Workers AI binding in the wrangler config.
	 * @default "AI"
	 */
	binding?: string;

	/**
	 * AI Gateway that requests run through. Third-party models need it for
	 * unified billing; it also gives logs, caching and spend limits.
	 * @default "default"
	 */
	gateway?: string;

	/**
	 * Model used when a request names none.
	 * @default "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
	 */
	defaultModel?: string;

	/**
	 * When set, plugins may only request these model ids. Other requests fail.
	 */
	models?: string[];

	/**
	 * Upper bound on output tokens for any request.
	 */
	maxTokens?: number;
}

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_GATEWAY = "default";
/** Anthropic's API requires max_tokens. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
/** Sandboxed callers are still bounded by their own 30 s wall time. */
const PROVIDER_TIMEOUT_MS = 120_000;

/** Minimal shape of the Workers AI binding. */
interface AiBinding {
	run(
		model: string,
		inputs: Record<string, unknown>,
		options?: { gateway?: { id: string; metadata?: Record<string, string> } },
	): Promise<unknown>;
}

async function loadWorkerEnv(): Promise<Record<string, unknown>> {
	try {
		const { env } = await import("./cloudflare-ai-env.js");
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Env is deployment-specific; the binding lookup validates the shape
		return env as unknown as Record<string, unknown>;
	} catch {
		throw new Error(
			"[cloudflare-ai] cloudflare:workers is not available — this provider only runs on " +
				"the Cloudflare Workers runtime (deployed or via astro dev with the Cloudflare adapter).",
		);
	}
}

/**
 * Build the ai:generate handler.
 *
 * Exported for testing — production code should use {@link cloudflareAI}.
 *
 * @internal
 */
export function createCloudflareAIGenerate(
	config: CloudflareAIConfig = {},
	loadEnv: () => Promise<Record<string, unknown>> = loadWorkerEnv,
): (event: AiGenerateEvent, ctx: PluginContext) => Promise<AiRunResult> {
	const bindingName = config.binding ?? "AI";
	const gateway = config.gateway ?? DEFAULT_GATEWAY;
	const allowed = config.models ? new Set(config.models) : null;

	return async (event, ctx) => {
		const { request, source } = event;
		const model = request.model ?? config.defaultModel ?? DEFAULT_MODEL;
		if (allowed && !allowed.has(model)) {
			throw new Error(
				`[cloudflare-ai] Model "${model}" is not allowed on this site. Allowed: ${[...allowed].join(", ")}.`,
			);
		}

		const env = await loadEnv();
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding accessed from untyped env object; the run() check below validates the shape
		const binding = env[bindingName] as AiBinding | undefined;
		if (!binding || typeof binding.run !== "function") {
			throw new Error(
				`[cloudflare-ai] AI binding "${bindingName}" not found — declare it in the wrangler config ` +
					`("ai": { "binding": "${bindingName}" }).`,
			);
		}

		const maxTokens = capTokens(request.maxTokens, config.maxTokens);
		const inputs = model.startsWith("anthropic/")
			? anthropicInputs(
					request.messages,
					maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
					request.temperature,
				)
			: {
					messages: request.messages,
					...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
					...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
				};

		const raw = await binding.run(model, inputs, {
			gateway: { id: gateway, metadata: { plugin: source } },
		});
		const result = toResult(raw, model);
		ctx.log.info("ai request answered via Workers AI", {
			source,
			model: result.model,
			outputTokens: result.usage?.outputTokens,
		});
		return result;
	};
}

function capTokens(requested: number | undefined, cap: number | undefined): number | undefined {
	if (requested === undefined) return cap;
	return cap === undefined ? requested : Math.min(requested, cap);
}

/** Anthropic's Messages API takes system prompts as a top-level string. */
function anthropicInputs(
	messages: AiMessage[],
	maxTokens: number,
	temperature: number | undefined,
) {
	const system = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");
	return {
		...(system ? { system } : {}),
		messages: messages.filter((m) => m.role !== "system"),
		max_tokens: maxTokens,
		...(temperature !== undefined ? { temperature } : {}),
	};
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | undefined {
	return isObject(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function joinText(parts: unknown[], type: string): string {
	return parts
		.map(asObject)
		.filter((part) => part?.type === type)
		.map((part) => asString(part?.text) ?? "")
		.join("");
}

/**
 * Normalise the answer shapes models return through the binding: Workers AI
 * (`response`), OpenAI chat completions (`choices`), Anthropic Messages
 * (`content` blocks) and the Responses API (`output` items).
 *
 * @internal
 */
export function toResult(raw: unknown, model: string): AiRunResult {
	const r = asObject(raw) ?? {};
	let text: string | undefined;
	let finishReason: string | undefined;
	if (typeof raw === "string") {
		text = raw;
	} else if (typeof r.response === "string") {
		text = r.response;
	} else if (Array.isArray(r.choices)) {
		const choice = asObject(r.choices[0]);
		const content = asObject(choice?.message)?.content;
		text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? joinText(content, "text")
					: undefined;
		finishReason = asString(choice?.finish_reason);
	} else if (Array.isArray(r.content)) {
		text = joinText(r.content, "text");
		const stop = asString(r.stop_reason);
		finishReason = stop === "max_tokens" ? "length" : stop;
	} else if (Array.isArray(r.output)) {
		const messages = r.output.map(asObject).filter((item) => item?.type === "message");
		text = joinText(
			messages.flatMap((item) => asArray(item?.content)),
			"output_text",
		);
	}
	if (text === undefined) throw new Error(`[cloudflare-ai] ${model} returned no text`);

	const usage = asObject(r.usage);
	const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens;
	const outputTokens = usage?.completion_tokens ?? usage?.output_tokens;
	return {
		text: text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
		model: asString(r.model) ?? model,
		...(typeof inputTokens === "number" && typeof outputTokens === "number"
			? { usage: { inputTokens, outputTokens } }
			: {}),
		...(finishReason ? { finishReason } : {}),
	};
}

/**
 * Instantiate the Cloudflare AI provider plugin.
 *
 * Called by the generated `virtual:emdash/plugins` module with the
 * `options` from the {@link cloudflareAI} descriptor.
 */
export function createPlugin(config: CloudflareAIConfig = {}): ResolvedPlugin {
	return definePlugin({
		id: "cloudflare-ai",
		version: "1.0.0",
		capabilities: ["hooks.ai-provider:register"],
		hooks: {
			"ai:generate": {
				exclusive: true,
				// Model calls routinely take longer than the 5 s hook default.
				timeout: PROVIDER_TIMEOUT_MS,
				handler: createCloudflareAIGenerate(config),
			},
		},
	});
}

/**
 * Create a Cloudflare AI provider plugin descriptor.
 *
 * Pass it to the emdash() integration's plugins array. EmDash selects it
 * automatically when it is the only active AI provider.
 */
export function cloudflareAI(
	config: CloudflareAIConfig = {},
): PluginDescriptor<CloudflareAIConfig> {
	return {
		id: "cloudflare-ai",
		version: "1.0.0",
		entrypoint: "@emdash-cms/cloudflare/plugins/cloudflare-ai",
		format: "native",
		options: config,
		capabilities: ["hooks.ai-provider:register"],
	};
}

export default cloudflareAI;
