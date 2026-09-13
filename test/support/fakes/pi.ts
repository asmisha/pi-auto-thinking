// Fake ExtensionAPI + ctx for driving index.ts without the real pi runtime.
type AnyFn = (...a: unknown[]) => unknown;

export interface FakePi {
	on(event: string, fn: AnyFn): void;
	registerCommand(
		name: string,
		spec: { description: string; handler: AnyFn },
	): void;
	registerFlag(name: string, options: { default?: boolean | string }): void;
	getFlag(name: string): boolean | string | undefined;
	flagValues: Map<string, boolean | string>;
	getThinkingLevel(): string;
	setThinkingLevel(level: string): void;
	emit(event: string, e: unknown, ctx: unknown): Promise<unknown>;
	commands: Map<string, { description: string; handler: AnyFn }>;
	setLevelCalls: string[];
	level: string;
}

export function buildFakePi(): FakePi {
	const handlers = new Map<string, AnyFn>();
	const commands = new Map<string, { description: string; handler: AnyFn }>();
	const setLevelCalls: string[] = [];
	const registeredFlags = new Set<string>();
	const flagValues = new Map<string, boolean | string>();
	let level = "off";
	const pi: FakePi = {
		on: (event, fn) => {
			handlers.set(event, fn);
		},
		registerCommand: (name, spec) => {
			commands.set(name, spec);
		},
		registerFlag: (name, options) => {
			registeredFlags.add(name);
			if (options.default !== undefined && !flagValues.has(name)) {
				flagValues.set(name, options.default);
			}
		},
		getFlag: (name) =>
			registeredFlags.has(name) ? flagValues.get(name) : undefined,
		flagValues,
		getThinkingLevel: () => level,
		setThinkingLevel: (l) => {
			setLevelCalls.push(l);
			level = l;
		},
		emit: async (event, e, ctx) => handlers.get(event)?.(e, ctx),
		commands,
		setLevelCalls,
		get level() {
			return level;
		},
	};
	return pi;
}

export interface FakeCtxOptions {
	model?: unknown;
	classifier?: unknown;
	apiKey?: string;
}

export function buildFakeCtx(opts: FakeCtxOptions = {}) {
	const classifier = opts.classifier ?? { id: "fake/classifier" };
	return {
		cwd: opts.model?.cwd ?? process.cwd(),
		model: opts.model ?? { id: "fake/main", cwd: process.cwd() },
		hasUI: false,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/tmp/test-session.jsonl",
			getLeafId: () => "previous-entry",
		},
		ui: {
			theme: undefined,
			setWidget: () => {},
			setStatus: () => {},
			notify: () => {},
		},
		modelRegistry: {
			find: () => classifier,
			getApiKeyForProvider: async () => opts.apiKey ?? "k",
		},
	};
}
