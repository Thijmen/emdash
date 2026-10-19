import type { PluginContext } from "emdash";
import type { AiGenerateEvent } from "emdash/plugin";
import { describe, expect, it, vi } from "vitest";

import {
	cloudflareAI,
	createCloudflareAIGenerate,
	createPlugin,
	toResult,
} from "../src/plugins/cloudflare-ai.js";

function fakeCtx(): PluginContext {
	return { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;
}

function fakeEnv(
	answer: unknown = { response: "Hello", usage: { prompt_tokens: 5, completion_tokens: 1 } },
) {
	const run = vi.fn(
		async (_model: string, _inputs: Record<string, unknown>, _options?: unknown) => answer,
	);
	return { loadEnv: async () => ({ AI: { run } }), run };
}

function event(overrides: Partial<AiGenerateEvent["request"]> = {}): AiGenerateEvent {
	return {
		request: {
			messages: [
				{ role: "system", content: "Be brief." },
				{ role: "user", content: "Say hello." },
			],
			...overrides,
		},
		source: "writer",
	};
}

describe("cloudflareAI()", () => {
	it("returns a native descriptor with a bundlable entrypoint", () => {
		const descriptor = cloudflareAI({ gateway: "site" });
		expect(descriptor.id).toBe("cloudflare-ai");
		expect(descriptor.entrypoint).toBe("@emdash-cms/cloudflare/plugins/cloudflare-ai");
		expect(descriptor.format).toBe("native");
		expect(descriptor.capabilities).toEqual(["hooks.ai-provider:register"]);
	});

	it("resolves to a plugin with an exclusive ai:generate hook", () => {
		const plugin = createPlugin();
		expect(plugin.capabilities).toContain("hooks.ai-provider:register");
		expect(plugin.hooks["ai:generate"]?.exclusive).toBe(true);
		// The 5 s hook default would cut off most model calls.
		expect(plugin.hooks["ai:generate"]?.timeout).toBe(120_000);
	});
});

describe("createCloudflareAIGenerate()", () => {
	it("runs the default model through the default gateway, tagged with the calling plugin", async () => {
		const { loadEnv, run } = fakeEnv();
		const generate = createCloudflareAIGenerate({}, loadEnv);

		const result = await generate(event({ maxTokens: 64 }), fakeCtx());

		expect(run).toHaveBeenCalledWith(
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			{ messages: event().request.messages, max_tokens: 64 },
			{ gateway: { id: "default", metadata: { plugin: "writer" } } },
		);
		expect(result).toEqual({
			text: "Hello",
			model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			usage: { inputTokens: 5, outputTokens: 1 },
		});
	});

	it("caps output tokens at the configured limit", async () => {
		const { loadEnv, run } = fakeEnv();
		await createCloudflareAIGenerate({ maxTokens: 100 }, loadEnv)(
			event({ maxTokens: 5000 }),
			fakeCtx(),
		);
		expect(run.mock.calls[0]?.[1]).toMatchObject({ max_tokens: 100 });
	});

	it("refuses models outside the site's allow-list without calling the binding", async () => {
		const { loadEnv, run } = fakeEnv();
		const generate = createCloudflareAIGenerate({ models: ["@cf/openai/gpt-oss-120b"] }, loadEnv);
		await expect(
			generate(event({ model: "anthropic/claude-sonnet-5" }), fakeCtx()),
		).rejects.toThrow(/not allowed/);
		expect(run).not.toHaveBeenCalled();
	});

	it("moves system prompts to Anthropic's top-level field and always sends max_tokens", async () => {
		const { loadEnv, run } = fakeEnv({
			content: [{ type: "text", text: "Hi" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 9, output_tokens: 2 },
		});
		const result = await createCloudflareAIGenerate({}, loadEnv)(
			event({ model: "anthropic/claude-haiku-4.5" }),
			fakeCtx(),
		);

		expect(run.mock.calls[0]?.[1]).toEqual({
			system: "Be brief.",
			messages: [{ role: "user", content: "Say hello." }],
			max_tokens: 4096,
		});
		expect(result).toMatchObject({
			text: "Hi",
			usage: { inputTokens: 9, outputTokens: 2 },
			finishReason: "end_turn",
		});
	});

	it("explains a missing binding", async () => {
		const generate = createCloudflareAIGenerate({}, async () => ({}));
		await expect(generate(event(), fakeCtx())).rejects.toThrow(/AI binding "AI" not found/);
	});
});

describe("toResult()", () => {
	it("reads OpenAI chat completions and maps their finish reason", () => {
		expect(
			toResult(
				{
					model: "gpt",
					choices: [{ message: { content: "Yes" }, finish_reason: "length" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				},
				"openai/gpt-5.4-mini",
			),
		).toEqual({
			text: "Yes",
			model: "gpt",
			usage: { inputTokens: 1, outputTokens: 1 },
			finishReason: "length",
		});
	});

	it("reads Responses API output and drops inline reasoning", () => {
		expect(
			toResult(
				{
					output: [
						{ type: "message", content: [{ type: "output_text", text: "<think>hmm</think>Done" }] },
					],
				},
				"@cf/openai/gpt-oss-120b",
			),
		).toEqual({ text: "Done", model: "@cf/openai/gpt-oss-120b" });
	});

	it("fails on an answer without text", () => {
		expect(() => toResult({ unexpected: true }, "m")).toThrow(/returned no text/);
	});
});
