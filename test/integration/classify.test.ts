import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ext from "../../src/extension/index.ts";
import { getLogger } from "../../src/logger.ts";
import { buildFakeCtx, buildFakePi } from "../support/fakes/pi.ts";
import { __resetPiAi, __setPiAi } from "../support/fakes/pi-ai.ts";
import {
	__resetCompleteSimple,
	__setCompleteSimple,
} from "../support/fakes/pi-ai-compat.ts";

// Project config with an active classifier so the extension classifies.
function withConfig(cwd: string, cfg: Record<string, unknown>) {
	const cfgDir = join(cwd, ".pi", "pi-auto-thinking");
	mkdirSync(cfgDir, { recursive: true });
	writeFileSync(join(cfgDir, "config.json"), JSON.stringify(cfg));
}

describe("classify (happy path)", () => {
	let tmp: string;
	before(() => {
		__resetPiAi();
		tmp = mkdtempSync(join(tmpdir(), "pi-auto-thinking-int-"));
		withConfig(tmp, {
			enabled: true,
			classifier: "fake/classifier",
			minLevel: "low",
			maxLevel: "xhigh",
		});
	});
	after(() => {
		__resetCompleteSimple();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("sets the classified level on a verdict", async () => {
		__setCompleteSimple(async () => ({
			content: [{ type: "text", text: "high" }],
		}));
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		const ctx = buildFakeCtx({ model: { id: "fake/main" } });
		ctx.cwd = tmp;
		await pi.emit(
			"input",
			{
				source: "interactive",
				text: "debug a subtle concurrency bug",
				streamingBehavior: undefined,
			},
			ctx,
		);
		assert.deepEqual(pi.setLevelCalls, ["high"]);
	});

	it("keeps the level on a keep verdict (no setThinkingLevel)", async () => {
		__setCompleteSimple(async () => ({
			content: [{ type: "text", text: "keep" }],
		}));
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		pi.setThinkingLevel("medium"); // pre-existing level
		pi.setLevelCalls.length = 0;
		const ctx = buildFakeCtx({ model: { id: "fake/main" } });
		ctx.cwd = tmp;
		await pi.emit(
			"input",
			{ source: "interactive", text: "continue", streamingBehavior: undefined },
			ctx,
		);
		assert.deepEqual(pi.setLevelCalls, []);
	});

	it("falls back (keeps level) when completeSimple rejects", async () => {
		__setCompleteSimple(async () => {
			throw new Error("boom");
		});
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		pi.setThinkingLevel("low");
		pi.setLevelCalls.length = 0;
		const ctx = buildFakeCtx({ model: { id: "fake/main" } });
		ctx.cwd = tmp;
		await pi.emit(
			"input",
			{ source: "interactive", text: "anything", streamingBehavior: undefined },
			ctx,
		);
		assert.deepEqual(pi.setLevelCalls, []);
	});

	it("skips classify when the model supports only off", async () => {
		let called = false;
		__setCompleteSimple(async () => {
			called = true;
			return { content: [{ type: "text", text: "low" }] };
		});
		__setPiAi({ supported: ["off"] });
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		const ctx = buildFakeCtx({ model: { id: "off-only" } });
		ctx.cwd = tmp;
		await pi.emit(
			"input",
			{ source: "interactive", text: "x", streamingBehavior: undefined },
			ctx,
		);
		assert.equal(called, false);
		__resetPiAi();
	});

	for (const api of ["openai-codex-responses", "openai-responses"]) {
		it(`sends compatible temperature options for ${api}`, async () => {
			let called = false;
			__setCompleteSimple(async (_model, _context, options) => {
				called = true;
				if (api === "openai-codex-responses") {
					assert.equal(Object.hasOwn(options as object, "temperature"), false);
				} else {
					assert.equal((options as { temperature: number }).temperature, 0);
				}
				return { content: [{ type: "text", text: "low" }] };
			});
			const pi = buildFakePi();
			ext(pi as unknown as ExtensionAPI);
			const ctx = buildFakeCtx({ classifier: { id: "classifier", api } });
			ctx.cwd = tmp;
			await pi.emit("input", { source: "interactive", text: "hello" }, ctx);
			assert.equal(called, true);
			assert.deepEqual(pi.setLevelCalls, ["low"]);
		});
	}

	it("logs actual provider failures without changing thinking or leaking the key", {
		timeout: 2000,
	}, async () => {
		const key = "test-private-api-key";
		__setCompleteSimple(async () => ({
			content: [],
			stopReason: "error",
			errorMessage: `Unsupported parameter: temperature; key=${key}`,
		}));
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		pi.setThinkingLevel("high");
		pi.setLevelCalls.length = 0;
		const ctx = buildFakeCtx({ apiKey: key });
		ctx.cwd = tmp;
		const logged = once(getLogger(), "data");
		await pi.emit(
			"input",
			{ source: "interactive", text: "private user text" },
			ctx,
		);
		const [record] = await logged;
		assert.deepEqual(pi.setLevelCalls, []);
		assert.equal(record.message, "kept");
		assert.equal(record.thinkingBefore, "high");
		assert.equal(record.thinkingAfter, "high");
		assert.equal(record.stopReason, "error");
		assert.match(record.reason, /Unsupported parameter: temperature/);
		assert.equal(record.providerError, record.reason);
		const serialized = record[Symbol.for("message")];
		assert.ok(!serialized.includes(key));
		assert.ok(!serialized.includes("private user text"));
	});

	for (const verdict of ["low", "keep"]) {
		it(`logs session correlation, token usage and before/after levels for ${verdict}`, {
			timeout: 2000,
		}, async () => {
			const usage = { input: 100, output: 1, totalTokens: 101 };
			__setCompleteSimple(async () => ({
				content: [{ type: "text", text: verdict }],
				stopReason: "stop",
				usage,
			}));
			const pi = buildFakePi();
			ext(pi as unknown as ExtensionAPI);
			pi.setThinkingLevel("high");
			pi.setLevelCalls.length = 0;
			const ctx = buildFakeCtx({ model: { provider: "fake", id: "main" } });
			ctx.cwd = tmp;
			const logged = once(getLogger(), "data");
			await pi.emit(
				"input",
				{ source: "interactive", text: "private user text" },
				ctx,
			);
			const [record] = await logged;
			assert.equal(record.sessionId, ctx.sessionManager.getSessionId());
			assert.equal(record.sessionFile, ctx.sessionManager.getSessionFile());
			assert.equal(record.parentEntryId, ctx.sessionManager.getLeafId());
			assert.equal(record.source, "interactive");
			assert.equal(record.hasUI, false);
			assert.equal(record.mainModel, "fake/main");
			assert.equal(record.classifier, "fake/classifier");
			assert.equal(record.thinkingBefore, "high");
			assert.equal(record.thinkingAfter, verdict === "keep" ? "high" : "low");
			assert.equal(record.verdict, verdict);
			assert.deepEqual(record.usage, usage);
			assert.equal(record.stopReason, "stop");
			assert.deepEqual(pi.setLevelCalls, verdict === "keep" ? [] : ["low"]);
			assert.ok(!record[Symbol.for("message")].includes("private user text"));
		});
	}

	it("logs skipped RPC requests without classifying or changing thinking", {
		timeout: 2000,
	}, async () => {
		let called = false;
		__setCompleteSimple(async () => {
			called = true;
			return { content: [{ type: "text", text: "low" }] };
		});
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		const ctx = buildFakeCtx();
		ctx.cwd = tmp;
		const logged = once(getLogger(), "data");
		const result = await pi.emit(
			"input",
			{ source: "rpc", text: "private user text" },
			ctx,
		);
		const [record] = await logged;
		assert.equal(called, false);
		assert.deepEqual(pi.setLevelCalls, []);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(record.message, "skipped");
		assert.equal(record.reason, "non-interactive");
		assert.equal(record.source, "rpc");
		assert.ok(!record[Symbol.for("message")].includes("private user text"));
	});

	it("ignores non-interactive turns", async () => {
		let called = false;
		__setCompleteSimple(async () => {
			called = true;
			return { content: [{ type: "text", text: "low" }] };
		});
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		const ctx = buildFakeCtx({ model: { id: "fake/main" } });
		ctx.cwd = tmp;
		await pi.emit(
			"input",
			{ source: "steer", text: "x", streamingBehavior: undefined },
			ctx,
		);
		assert.equal(called, false);
	});

	it("ignores streaming follow-ups (streamingBehavior set)", async () => {
		let called = false;
		__setCompleteSimple(async () => {
			called = true;
			return { content: [{ type: "text", text: "low" }] };
		});
		const pi = buildFakePi();
		ext(pi as unknown as ExtensionAPI);
		const ctx = buildFakeCtx({ model: { id: "fake/main" } });
		ctx.cwd = tmp;
		await pi.emit(
			"input",
			{ source: "interactive", text: "x", streamingBehavior: "append" },
			ctx,
		);
		assert.equal(called, false);
	});
});
