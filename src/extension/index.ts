// pi-auto-thinking — online prompt-difficulty classifier that auto-sets pi's
// thinking level each turn. The idea is borrowed from oh-my-pi's "auto" thinking
// level (can1357/oh-my-pi).
//
// ponytail: classification is delegated to a configured model via
// @earendil-works/pi-ai/compat's completeSimple. The valid thinking levels are
// NEVER hard-coded — they come from pi's getSupportedThinkingLevels(ctx.model),
// so the prompt and the clamp track whatever the current model actually offers.
// If compat is removed upstream, swap to createModels() + provider factories.

import {
	type AssistantMessage,
	clampThinkingLevel,
	getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readConfig } from "../config.ts";
import { getLogger } from "../logger.ts";
import { buildSystemPrompt, parseDifficulty, sliceBetween } from "../logic.ts";

// ponytail: pi-ai's `reasoning` option is typed ThinkingLevel but isn't
// re-exported from the package root, and the classifier deliberately passes
// "off" (an out-of-contract value providers read as "no extended thinking").
// Mirror the union locally so the cast is typed instead of `any`.
type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface Config {
	enabled?: boolean;
	classifier?: string; // "provider/model" — unset => inactive
	minLevel?: string; // a pi thinking level; snapped to the model at runtime
	maxLevel?: string;
	classifierLevel?: string; // reasoning effort for the classifier call itself (default "off")
	timeoutMs?: number;
	maxTokens?: number;
}

const DEFAULTS = {
	enabled: true,
	minLevel: "low",
	maxLevel: "xhigh",
	classifierLevel: "off",
	timeoutMs: 4000,
	maxTokens: 4096, // ponytail: thinking-on models (qwen3) are verbose; needs headroom for the answer after <think>
};

interface Decision {
	snippet: string;
	level: string;
	reason: string;
	kept?: boolean; // true when the level was preserved (keep verdict or fallback), not freshly set
	ms?: number;
}

/** One classification attempt. Never throws; failures land in `error`. */
interface ClassifyResult {
	ok: boolean;
	raw: string; // text blocks joined (the answer)
	thinking: string; // thinking blocks joined (debug)
	verdict?: string; // the parsed level, or "keep"
	level: string; // resulting level, or current level when kept/fallback
	kept: boolean;
	skipped?: boolean; // true when the main model supports only "off" — nothing to classify
	range?: string[]; // the levels the classifier was offered
	ms: number;
	error?: string;
	stopReason?: AssistantMessage["stopReason"];
	usage?: AssistantMessage["usage"];
	providerError?: string;
}

export default function (pi: ExtensionAPI) {
	let cfg = readConfig<Config>(DEFAULTS, process.cwd());
	let userEnabled = cfg.enabled !== false;
	let last: Decision | undefined;
	let lastMs: number | undefined;
	// Lazy logger: defer winston init to first use rather than factory scope.
	let log: ReturnType<typeof getLogger> | undefined;
	const logger = () => (log ??= getLogger());

	const active = () => userEnabled && !!cfg.classifier;

	// Animated widget spinner. pi's built-in working indicator is gated on the
	// agent's streaming state (session.isStreaming), which is false during the
	// pre-turn `input` hook — so setWorkingMessage never renders there. A widget
	// draws on requestRender regardless of streaming, so we spin our own braille.
	const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	const startSpinner = (ctx: ExtensionContext, label: string) => {
		if (!ctx.hasUI) return;
		const draw = (i: number) => {
			const glyph = SPIN_FRAMES[i % SPIN_FRAMES.length];
			const t = ctx.ui.theme; // matches WorkingStatusIndicator: accent glyph + muted label
			ctx.ui.setWidget(
				"at-spinner",
				[
					t
						? `${t.fg("accent", glyph)} ${t.fg("muted", label)}`
						: `${glyph} ${label}`,
				],
				{ placement: "aboveEditor" },
			);
		};
		draw(0);
		let i = 0;
		spinnerTimer = setInterval(() => draw(++i), 80);
	};
	const stopSpinner = (ctx: ExtensionContext) => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		if (ctx.hasUI) ctx.ui.setWidget("at-spinner", undefined);
	};

	const paint = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"auto-thinking",
			!active()
				? "auto:off"
				: last
					? `auto→${last.level}${last.kept ? "◆" : ""}`
					: "auto",
		);
	};

	const classifyOnce = async (
		ctx: ExtensionContext,
		text: string,
		spin = false,
	): Promise<ClassifyResult> => {
		const t0 = Date.now();
		const cur = (): string => pi.getThinkingLevel();
		const model = ctx.model;

		// Levels come straight from the main model — no hard-coded ladder.
		const supported = model ? getSupportedThinkingLevels(model) : ["off"];
		const scale = supported.filter((l) => l !== "off"); // ordered, non-off
		if (scale.length === 0)
			return {
				ok: false,
				raw: "",
				thinking: "",
				level: cur(),
				kept: true,
				skipped: true,
				ms: Date.now() - t0,
				error: "model supports only 'off'",
			};

		// Snap user bounds to the model's levels via pi, then slice to the range.
		const lo = clampThinkingLevel(model, cfg.minLevel ?? DEFAULTS.minLevel);
		const hi = clampThinkingLevel(model, cfg.maxLevel ?? DEFAULTS.maxLevel);
		const range = sliceBetween(
			scale,
			lo === "off" ? scale[0] : lo,
			hi === "off" ? scale[scale.length - 1] : hi,
		);
		const prompt = buildSystemPrompt(range);

		const spec = cfg.classifier;
		if (!spec)
			return {
				ok: false,
				raw: "",
				thinking: "",
				level: cur(),
				kept: true,
				skipped: true,
				ms: Date.now() - t0,
				error: "no classifier configured",
			};
		const slash = spec.indexOf("/");
		if (slash < 0)
			return {
				ok: false,
				raw: "",
				thinking: "",
				level: cur(),
				kept: true,
				range,
				ms: Date.now() - t0,
				error: `bad spec: ${spec}`,
			};
		const provider = spec.slice(0, slash);
		const modelId = spec.slice(slash + 1);
		const classifierModel = ctx.modelRegistry.find(provider, modelId);
		if (!classifierModel)
			return {
				ok: false,
				raw: "",
				thinking: "",
				level: cur(),
				kept: true,
				range,
				ms: Date.now() - t0,
				error: `${spec} not found`,
			};

		const apiKey = await ctx.modelRegistry
			.getApiKeyForProvider(provider)
			.catch(() => undefined);
		const redactError = (message: string) =>
			(apiKey ? message.split(apiKey).join("[REDACTED]") : message).slice(
				0,
				1000,
			);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			cfg.timeoutMs ?? DEFAULTS.timeoutMs,
		);
		if (spin) startSpinner(ctx, "Setting thinking level…");
		try {
			const res = await completeSimple(
				classifierModel,
				{
					systemPrompt: prompt,
					// Instruction wraps the content and trails it — small models attend to
					// the user position's end and would otherwise answer the task.
					messages: [
						{
							role: "user",
							content: `Prompt to classify:\n"""\n${text}\n"""\n\nOutput ONE word (${["keep", ...range].join(" | ")}):`,
						},
					],
				},
				{
					apiKey,
					maxTokens: cfg.maxTokens ?? DEFAULTS.maxTokens,
					reasoning: cfg.classifierLevel as ReasoningLevel,
					// Codex rejects temperature, even when reasoning is off.
					...(classifierModel.api === "openai-codex-responses"
						? {}
						: { temperature: 0 }),
					signal: controller.signal,
				},
			);
			const telemetry = {
				stopReason: res.stopReason,
				usage: res.usage,
				providerError: res.errorMessage
					? redactError(res.errorMessage)
					: undefined,
			};
			const blocks = res.content as Array<{
				type: string;
				text?: string;
				thinking?: string;
			}>;
			const raw = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(" ")
				.trim();
			const thinking = blocks
				.filter((b) => b.type === "thinking")
				.map((b) => b.thinking ?? "")
				.join(" ")
				.trim();
			const parsed = parseDifficulty(raw, range);
			if (!parsed)
				return {
					...telemetry,
					ok: false,
					raw,
					thinking,
					level: cur(),
					kept: true,
					range,
					ms: Date.now() - t0,
					error:
						telemetry.providerError ??
						`unparseable: ${JSON.stringify(raw).slice(0, 60)}`,
				};
			if (parsed === "keep")
				return {
					...telemetry,
					ok: true,
					raw,
					thinking,
					verdict: "keep",
					level: cur(),
					kept: true,
					range,
					ms: Date.now() - t0,
				};
			// parsed is already within range (model-valid + bounded) — no further clamp needed.
			return {
				...telemetry,
				ok: true,
				raw,
				thinking,
				verdict: parsed,
				level: parsed,
				kept: false,
				range,
				ms: Date.now() - t0,
			};
		} catch (err) {
			return {
				ok: false,
				raw: "",
				thinking: "",
				level: cur(),
				kept: true,
				range,
				ms: Date.now() - t0,
				error: redactError(err instanceof Error ? err.message : String(err)),
			};
		} finally {
			clearTimeout(timer);
			if (spin) stopSpinner(ctx);
		}
	};

	pi.on("session_start", (_e, ctx) => {
		cfg = readConfig<Config>(DEFAULTS, ctx.cwd);
		userEnabled = cfg.enabled !== false;
		paint(ctx);
	});

	// Fires before skill/template expansion and before the agent loop, so the
	// level we set applies to the upcoming turn. Awaited by pi in input order.
	pi.on("input", async (event, ctx) => {
		cfg = readConfig<Config>(DEFAULTS, ctx.cwd); // cheap re-read vs the LLM call; picks up edits
		paint(ctx);

		const metadata = {
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			parentEntryId: ctx.sessionManager.getLeafId(),
			source: event.source,
			hasUI: ctx.hasUI,
			mainModel: ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined,
			classifier: cfg.classifier,
			thinkingBefore: pi.getThinkingLevel(),
		};
		// Keep the upstream eligibility rules; log skips to measure actual coverage.
		const skip = (reason: string) => {
			logger().info("skipped", { ...metadata, reason });
			return { action: "continue" as const };
		};
		if (event.source !== "interactive") return skip("non-interactive");
		if (event.streamingBehavior) return skip("streaming");
		if (!active()) return skip("disabled-or-unconfigured");
		if (!ctx.model || getSupportedThinkingLevels(ctx.model).length <= 1)
			return skip("non-reasoning");

		const r = await classifyOnce(ctx, event.text, true);
		if (r.skipped) {
			paint(ctx);
			return { action: "continue" };
		}
		if (r.ok && !r.kept) pi.setThinkingLevel(r.level);
		last = {
			snippet: snip(event.text),
			level: r.level,
			kept: r.kept,
			ms: r.ms,
			reason: r.ok
				? r.kept
					? `keep — "${r.raw.slice(0, 40)}"`
					: `classified "${r.raw.slice(0, 40)}"`
				: `fallback (kept): ${r.error}`,
		};
		lastMs = r.ms;
		const record = {
			...metadata,
			thinkingAfter: pi.getThinkingLevel(),
			verdict: r.verdict,
			ms: r.ms,
			stopReason: r.stopReason,
			usage: r.usage,
			providerError: r.providerError,
		};
		if (r.ok && !r.kept) logger().info("classified", record);
		else
			logger().warn("kept", {
				...record,
				reason: r.ok ? "keep verdict" : r.error,
			});
		paint(ctx);
		return { action: "continue" };
	});

	pi.registerCommand("auto-thinking", {
		description: "auto-thinking: on | off | status",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = (parts[0] ?? "").toLowerCase();

			if (sub === "off") userEnabled = false;
			else if (sub === "on") userEnabled = true;

			// status (default)
			const supported = ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
			ctx.ui.notify(
				[
					`auto-thinking: ${active() ? "on" : "off"}`,
					`classifier: ${cfg.classifier ?? "(none — set in ~/.pi/agent/pi-auto-thinking/config.json)"} @ ${cfg.classifierLevel ?? "off"}  (max ${cfg.maxTokens ?? DEFAULTS.maxTokens} tok)`,
					`bounds: ${cfg.minLevel ?? DEFAULTS.minLevel}…${cfg.maxLevel ?? DEFAULTS.maxLevel}  timeout: ${cfg.timeoutMs ?? DEFAULTS.timeoutMs}ms`,
					`model: ${ctx.model?.id ?? "?"}  levels: ${supported.join("|") || "?"}`,
					last
						? `last: ${last.level}${last.kept ? "◆" : ""} ${lastMs ?? ""}ms — ${last.reason}  "${last.snippet}"`
						: "last: (none yet)",
				].join("\n"),
				"info",
			);
			paint(ctx);
		},
	});
}

const snip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);
