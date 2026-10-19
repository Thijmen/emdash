/**
 * AI Pipeline Tests
 *
 * - AiPipeline.run(): dispatch to the selected ai:generate provider, request
 *   validation, provider errors, result validation, recursion guard
 * - AiPipeline.isAvailable(): provider selection
 * - ai:generate registration requires hooks.ai-provider:register
 * - ctx.ai gated by the ai:run capability and a configured provider
 */

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { AiNotConfiguredError, AiPipeline, AiRecursionError } from "../../../src/plugins/ai.js";
import { PluginContextFactory } from "../../../src/plugins/context.js";
import { HookPipeline } from "../../../src/plugins/hooks.js";
import type {
	AiGenerateEvent,
	AiGenerateHandler,
	AiRunRequest,
	ResolvedHook,
	ResolvedPlugin,
} from "../../../src/plugins/types.js";

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [] },
		hooks: {},
		routes: {},
		...overrides,
	};
}

function createProvider(
	id: string,
	handler: AiGenerateHandler,
	capabilities = ["hooks.ai-provider:register"],
): ResolvedPlugin {
	const hook: ResolvedHook<AiGenerateHandler> = {
		pluginId: id,
		handler,
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "continue",
		exclusive: true,
	};
	return createTestPlugin({
		id,
		capabilities: capabilities as ResolvedPlugin["capabilities"],
		hooks: { "ai:generate": hook },
	});
}

const request: AiRunRequest = {
	model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	messages: [
		{ role: "system", content: "Be brief." },
		{ role: "user", content: "Name one prime number." },
	],
	maxTokens: 32,
};

describe("AiPipeline", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database;

	beforeEach(async () => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqliteDb }) });
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	function pipelineWith(provider: ResolvedPlugin): AiPipeline {
		const hooks = new HookPipeline([provider], { db });
		hooks.setExclusiveSelection("ai:generate", provider.id);
		return new AiPipeline(hooks);
	}

	it("sends the request and the calling plugin to the selected provider", async () => {
		const seen: AiGenerateEvent[] = [];
		const ai = pipelineWith(
			createProvider("provider", async (event) => {
				seen.push(event);
				return {
					text: "7",
					model: "llama",
					usage: { inputTokens: 12, outputTokens: 1 },
					finishReason: "stop",
				};
			}),
		);

		const result = await ai.run(request, "writer");

		expect(result).toEqual({
			text: "7",
			model: "llama",
			usage: { inputTokens: 12, outputTokens: 1 },
			finishReason: "stop",
		});
		expect(seen).toEqual([{ request, source: "writer" }]);
	});

	it("throws AiNotConfiguredError without a selected provider", async () => {
		const ai = new AiPipeline(new HookPipeline([], { db }));
		expect(ai.isAvailable()).toBe(false);
		await expect(ai.run(request, "writer")).rejects.toThrow(AiNotConfiguredError);
	});

	it("reports a provider's error to the caller", async () => {
		const ai = pipelineWith(
			createProvider("provider", async () => {
				throw new Error("out of credits");
			}),
		);
		await expect(ai.run(request, "writer")).rejects.toThrow("out of credits");
	});

	it("rejects malformed requests before any provider sees them", async () => {
		let calls = 0;
		const ai = pipelineWith(
			createProvider("provider", async () => {
				calls++;
				return { text: "", model: "m" };
			}),
		);
		const bad: unknown[] = [
			null,
			{ messages: [] },
			{ messages: [{ role: "tool", content: "x" }] },
			{ messages: [{ role: "user", content: 42 }] },
			{ model: "", messages: [{ role: "user", content: "x" }] },
			{ messages: [{ role: "user", content: "x" }], maxTokens: 0 },
		];
		for (const input of bad) {
			await expect(ai.run(input as AiRunRequest, "writer")).rejects.toThrow(/Invalid AI request/);
		}
		expect(calls).toBe(0);
	});

	it("rejects a provider result without text", async () => {
		const ai = pipelineWith(createProvider("provider", async () => ({ model: "m" }) as never));
		await expect(ai.run(request, "writer")).rejects.toThrow(/invalid result/);
	});

	it("stops a provider that calls back into the pipeline", async () => {
		let ai: AiPipeline;
		ai = pipelineWith(
			createProvider("provider", async () => {
				await ai.run(request, "provider");
				return { text: "never", model: "m" };
			}),
		);
		await expect(ai.run(request, "writer")).rejects.toThrow(AiRecursionError);
	});

	it("refuses requests from the selected provider itself, as a sandboxed provider's arrive outside the guard", async () => {
		let calls = 0;
		const ai = pipelineWith(
			createProvider("provider", async () => {
				calls++;
				return { text: "x", model: "m" };
			}),
		);
		await expect(ai.run(request, "provider")).rejects.toThrow(AiRecursionError);
		expect(calls).toBe(0);
	});

	it("skips an ai:generate hook from a plugin without hooks.ai-provider:register", () => {
		const hooks = new HookPipeline(
			[createProvider("sneaky", async () => ({ text: "", model: "m" }), [])],
			{ db },
		);
		expect(hooks.getExclusiveHookProviders("ai:generate")).toEqual([]);
	});
});

describe("ctx.ai gating", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database;

	beforeEach(async () => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqliteDb }) });
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	function setup(selectProvider: boolean) {
		const provider = createProvider("provider", async (event) => ({
			text: `from ${event.source}`,
			model: "m",
		}));
		const hooks = new HookPipeline([provider], { db });
		if (selectProvider) hooks.setExclusiveSelection("ai:generate", "provider");
		return new PluginContextFactory({ db, aiPipeline: new AiPipeline(hooks) });
	}

	it("is undefined without the ai:run capability", () => {
		const ctx = setup(true).createContext(createTestPlugin({ id: "no-ai" }));
		expect(ctx.ai).toBeUndefined();
	});

	it("is undefined while no provider is configured", () => {
		const ctx = setup(false).createContext(
			createTestPlugin({ id: "writer", capabilities: ["ai:run"] }),
		);
		expect(ctx.ai).toBeUndefined();
	});

	it("runs requests as the calling plugin", async () => {
		const ctx = setup(true).createContext(
			createTestPlugin({ id: "writer", capabilities: ["ai:run"] }),
		);
		await expect(ctx.ai?.run(request)).resolves.toMatchObject({ text: "from writer" });
	});
});
