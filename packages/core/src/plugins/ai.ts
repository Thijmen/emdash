/**
 * AI Pipeline
 *
 * Routes ctx.ai.run() calls to the selected `ai:generate` provider — an
 * exclusive hook, so exactly one plugin answers every AI request on the site.
 * The provider owns credentials and billing (for example a Workers AI binding);
 * calling plugins only see the request and the result.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { HookPipeline } from "./hooks.js";
import type { AiGenerateEvent, AiMessage, AiRunRequest, AiRunResult } from "./types.js";

const AI_GENERATE_HOOK = "ai:generate";

const MAX_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 1_000_000;
const ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);

/**
 * Error thrown when ctx.ai.run() is called but no provider is selected.
 */
export class AiNotConfiguredError extends Error {
	constructor() {
		super(
			"No AI provider is configured. Install and activate an AI provider plugin, " +
				"such as cloudflareAI() from @emdash-cms/cloudflare/plugins.",
		);
		this.name = "AiNotConfiguredError";
	}
}

/**
 * Error thrown when a provider's ai:generate handler calls ctx.ai.run().
 */
export class AiRecursionError extends Error {
	constructor() {
		super(
			"Recursive AI request detected. An ai:generate provider called ctx.ai.run() " +
				"while answering a request.",
		);
		this.name = "AiRecursionError";
	}
}

/**
 * Scoped to the current async context: the pipeline is a worker-lifetime
 * singleton, so instance state would see unrelated concurrent requests.
 */
const aiRunALS = new AsyncLocalStorage<{ depth: number }>();

export class AiPipeline {
	private pipeline: HookPipeline;

	constructor(pipeline: HookPipeline) {
		this.pipeline = pipeline;
	}

	/** Replace the hook pipeline after plugins are enabled or disabled. */
	setPipeline(pipeline: HookPipeline): void {
		this.pipeline = pipeline;
	}

	/**
	 * Run one request through the selected provider.
	 *
	 * @param request - Untrusted: sandboxed plugins reach this over RPC
	 * @param source - ID of the calling plugin, passed to the provider
	 * @throws AiNotConfiguredError if no provider is selected
	 * @throws AiRecursionError if called from inside a provider
	 */
	async run(request: AiRunRequest, source: string): Promise<AiRunResult> {
		// The ALS store catches in-process providers. A sandboxed provider's
		// ctx.ai call arrives over RPC in a fresh async context, so the
		// provider's own plugin id is refused as well.
		if (aiRunALS.getStore() || source === this.pipeline.getExclusiveSelection(AI_GENERATE_HOOK)) {
			throw new AiRecursionError();
		}
		const normalized = normalizeRequest(request);
		return aiRunALS.run({ depth: 1 }, () => this.generate(normalized, source));
	}

	private async generate(request: AiRunRequest, source: string): Promise<AiRunResult> {
		const event: AiGenerateEvent = { request, source };
		const outcome = await this.pipeline.invokeExclusiveHook(AI_GENERATE_HOOK, event);
		if (!outcome) throw new AiNotConfiguredError();
		if (outcome.error) {
			console.error(
				`[ai:generate] Provider "${outcome.pluginId}" failed a request from "${source}":`,
				outcome.error,
			);
			throw outcome.error;
		}
		return normalizeResult(outcome.result, outcome.pluginId);
	}

	/** True when an ai:generate provider is selected. */
	isAvailable(): boolean {
		return this.pipeline.getExclusiveSelection(AI_GENERATE_HOOK) !== undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRole(value: unknown): value is AiMessage["role"] {
	return typeof value === "string" && ROLES.has(value);
}

function normalizeRequest(request: unknown): AiRunRequest {
	if (!isRecord(request)) {
		throw new Error("Invalid AI request: request must be an object");
	}
	const { model, messages, maxTokens, temperature } = request;
	if (model !== undefined && (typeof model !== "string" || !model.trim())) {
		throw new Error("Invalid AI request: 'model' must be a non-empty string");
	}
	if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
		throw new Error(`Invalid AI request: 'messages' must hold 1 to ${MAX_MESSAGES} messages`);
	}
	const checked = messages.map((message: unknown, index): AiMessage => {
		const role = isRecord(message) ? message.role : undefined;
		const content = isRecord(message) ? message.content : undefined;
		if (!isRole(role)) {
			throw new Error(
				`Invalid AI request: messages[${index}].role must be system, user or assistant`,
			);
		}
		if (typeof content !== "string" || content.length > MAX_MESSAGE_LENGTH) {
			throw new Error(`Invalid AI request: messages[${index}].content must be a string`);
		}
		return { role, content };
	});
	if (
		maxTokens !== undefined &&
		(typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1)
	) {
		throw new Error("Invalid AI request: 'maxTokens' must be a positive integer");
	}
	if (
		temperature !== undefined &&
		(typeof temperature !== "number" || !Number.isFinite(temperature))
	) {
		throw new Error("Invalid AI request: 'temperature' must be a number");
	}
	return {
		...(typeof model === "string" ? { model } : {}),
		messages: checked,
		...(typeof maxTokens === "number" ? { maxTokens } : {}),
		...(typeof temperature === "number" ? { temperature } : {}),
	};
}

function normalizeResult(result: unknown, pluginId: string): AiRunResult {
	const fields = isRecord(result) ? result : {};
	const { text, model, usage, finishReason } = fields;
	if (typeof text !== "string" || typeof model !== "string") {
		throw new Error(
			`AI provider "${pluginId}" returned an invalid result: 'text' and 'model' must be strings`,
		);
	}
	const inputTokens = isRecord(usage) ? usage.inputTokens : undefined;
	const outputTokens = isRecord(usage) ? usage.outputTokens : undefined;
	return {
		text,
		model,
		...(typeof inputTokens === "number" && typeof outputTokens === "number"
			? { usage: { inputTokens, outputTokens } }
			: {}),
		...(typeof finishReason === "string" ? { finishReason } : {}),
	};
}
