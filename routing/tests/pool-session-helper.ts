/**
 * Test helper: a real AgentSession over three faux providers, with an inline extension.
 * Providers `alpha`, `beta` and `gamma` each answer from their own scripted queue, so a test
 * sees which provider each request really reached and why Pi routed it (the route reason).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const POOL_PROVIDERS = ["alpha", "beta", "gamma"] as const;
export const POOL_MODEL_IDS: Record<(typeof POOL_PROVIDERS)[number], string> = { alpha: "a", beta: "b", gamma: "c" };

export interface RouteRecord {
	reason: string;
	failedProvider?: string;
	roleModel: string;
	messages: readonly { role: string; content: unknown }[];
}

export interface PoolSessionOptions {
	/** Inline extensions under test. They receive a proxy of the real API that records every virtual-model route. */
	extensions: Array<(pi: ExtensionAPI) => void | Promise<void>>;
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	/** Faux models that support reasoning, so a thinking level survives Pi's clamp to the routed model. */
	reasoning?: boolean;
	/** Continue a session, e.g. to test resume. */
	sessionManager?: SessionManager;
}

export interface PoolSession {
	session: AgentSession;
	sessionManager: SessionManager;
	runtime: ModelRuntime;
	faux: Record<(typeof POOL_PROVIDERS)[number], FauxProviderRegistration>;
	/** The real extension API, for sending messages the way an extension does. */
	pi: () => ExtensionAPI;
	routes: RouteRecord[];
	reasons: () => string[];
	/** provider/model that answered each assistant message, in order. */
	dispatched: () => string[];
	select(provider: string, id: string): Promise<void>;
	cleanup(): void;
}

export async function createPoolSession(options: PoolSessionOptions): Promise<PoolSession> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-pool-session-"));
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const faux = {} as PoolSession["faux"];
	for (const provider of POOL_PROVIDERS) {
		const registration = registerFauxProvider({ provider, models: [{ id: POOL_MODEL_IDS[provider], ...(options.reasoning ? { reasoning: true } : {}) }] });
		registration.setResponses([]);
		faux[provider] = registration;
		runtime.registerProvider(provider, {
			baseUrl: "http://faux.invalid",
			apiKey: "faux-key",
			api: registration.api,
			models: registration.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
				...(options.reasoning ? { thinkingLevelMap: { xhigh: "xhigh" } } : {}),
			})),
		});
	}

	const routes: RouteRecord[] = [];
	let realPi: ExtensionAPI | undefined;
	const wrap = (extension: PoolSessionOptions["extensions"][number]) => (pi: ExtensionAPI) => {
		realPi = pi;
		const recording = new Proxy(pi, {
			get(target, key) {
				const value = Reflect.get(target, key);
				if (key !== "registerVirtualModel") return typeof value === "function" ? value.bind(target) : value;
				return (definition: Parameters<ExtensionAPI["registerVirtualModel"]>[0]) =>
					target.registerVirtualModel({
						...definition,
						route(request, ctx) {
							routes.push({
								reason: request.reason,
								failedProvider: request.failed?.model.provider,
								roleModel: `${request.model.provider}/${request.model.id}`,
								messages: request.messages as RouteRecord["messages"],
							});
							return definition.route(request, ctx);
						},
					});
			},
		});
		return extension(recording);
	};

	const settingsManager = SettingsManager.inMemory(options.settings ?? { retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: options.extensions.map(wrap),
	});
	await resourceLoader.reload();
	const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager,
		settingsManager,
		model: runtime.getModel("alpha", POOL_MODEL_IDS.alpha) as Model<never>,
	});
	// Stream through the runtime so virtual models route and responses record their physical model.
	session.agent.streamFunction = (model, context, streamOptions) => runtime.streamSimple(model, context, streamOptions);

	return {
		session,
		sessionManager,
		runtime,
		faux,
		pi: () => {
			if (!realPi) throw new Error("no extension has loaded");
			return realPi;
		},
		routes,
		reasons: () => routes.map((route) => route.reason),
		dispatched: () => session.messages.flatMap((message) => (message.role === "assistant" ? [`${message.provider}/${message.model}`] : [])),
		async select(provider, id) {
			const model = runtime.getModel(provider, id);
			if (!model) throw new Error(`model ${provider}/${id} is not registered`);
			await session.setModel(model);
		},
		cleanup() {
			session.dispose();
			for (const provider of POOL_PROVIDERS) faux[provider].unregister();
		},
	};
}
