import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";

import type { EntryTarget, Project, Tag, TimeEntry, Workspace } from "./types";

const BASE_URL = "https://api.track.toggl.com/api/v9";
const CREATED_WITH = "Timer for Toggl Track";

/** The largest page Toggl allows when listing projects and tags. */
const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 2;
/** How long to back off after an HTTP 402 when Toggl doesn't say when the quota resets. */
const DEFAULT_QUOTA_BACKOFF_S = 5 * 60;

/**
 * The hourly quota a request counts against. Toggl counts `/me` requests per user, and all other requests per user
 * per organization; keying by workspace approximates the latter, as Free plan organizations have a single workspace.
 */
export type QuotaScope = "user" | `workspace:${number}`;

/**
 * Remaining requests in a quota window, as reported by Toggl's `X-Toggl-Quota-*` response headers.
 */
export type QuotaStatus = {
	remaining: number;
	resetsAt: number;
};

/**
 * An error response from the Toggl API.
 */
export class TogglError extends Error {
	/**
	 * Initializes a new instance of the {@link TogglError} class.
	 * @param message The error message.
	 * @param status The HTTP status code.
	 * @param retryAt When the request may be retried, for quota errors.
	 */
	constructor(
		message: string,
		readonly status: number,
		readonly retryAt?: number,
	) {
		super(message);
		this.name = "TogglError";
	}

	/** Toggl returns 401 without a token, and 403 for an invalid one. */
	get isAuthError(): boolean {
		return this.status === 401 || this.status === 403;
	}

	get isQuotaExceeded(): boolean {
		return this.status === 402;
	}
}

/**
 * Describes an error from {@link TogglClient} in words suitable for the property inspector.
 * @param error The error.
 * @returns The description.
 */
export function describeError(error: unknown): string {
	if (!(error instanceof TogglError)) {
		return "Couldn't reach Toggl. Check your internet connection.";
	}

	if (error.isAuthError) {
		return "Toggl didn't accept this API token. Copy it again from your Toggl profile.";
	}

	if (error.isQuotaExceeded) {
		const minutes = Math.max(1, Math.ceil(((error.retryAt ?? Date.now()) - Date.now()) / 60_000));
		return `Toggl's hourly request limit has been reached. Try again in ${minutes} min.`;
	}

	return `Toggl returned an error (HTTP ${error.status}).`;
}

/**
 * A minimal client for the Toggl Track v9 API, authenticated with a user's API token. Requests are sent one at a time
 * to stay under Toggl's burst limit, and the hourly quota reported by Toggl is tracked so that callers can avoid
 * spending the last few requests on background work.
 */
export class TogglClient {
	readonly #authorization: string;
	readonly #quotas = new Map<QuotaScope, QuotaStatus>();
	#queue: Promise<unknown> = Promise.resolve();

	/**
	 * Initializes a new instance of the {@link TogglClient} class.
	 * @param apiToken The user's API token, from their Toggl profile.
	 */
	constructor(apiToken: string) {
		this.#authorization = `Basic ${Buffer.from(`${apiToken}:api_token`).toString("base64")}`;
	}

	/**
	 * Gets the quota status of a scope, if Toggl has reported one and its window hasn't reset yet.
	 * @param scope The quota scope.
	 * @returns The quota status; otherwise `undefined`.
	 */
	quota(scope: QuotaScope): QuotaStatus | undefined {
		const quota = this.#quotas.get(scope);
		return quota !== undefined && quota.resetsAt > Date.now() ? quota : undefined;
	}

	/**
	 * Gets the user's running time entry.
	 * @returns The running entry; otherwise `null`.
	 */
	getCurrentEntry(): Promise<TimeEntry | null> {
		return this.#request("user", "GET", "/me/time_entries/current");
	}

	/**
	 * Starts a time entry; Toggl stops any entry that is already running.
	 * @param target What to start.
	 * @returns The running entry, including its project's color.
	 */
	startEntry(target: EntryTarget): Promise<TimeEntry> {
		return this.#request(`workspace:${target.workspaceId}`, "POST", `/workspaces/${target.workspaceId}/time_entries?meta=true`, {
			created_with: CREATED_WITH,
			workspace_id: target.workspaceId,
			description: target.description,
			// "No project" and "no tags" are sent explicitly; when omitted, Toggl copies them from the running entry.
			project_id: target.projectId,
			tag_ids: target.tagIds,
			// Toggl expects whole seconds, e.g. 2006-01-02T15:04:05Z.
			start: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
			duration: -1,
		});
	}

	/**
	 * Stops a running time entry.
	 * @param entry The entry to stop.
	 * @returns The stopped entry.
	 */
	stopEntry(entry: TimeEntry): Promise<TimeEntry> {
		return this.#request(
			`workspace:${entry.workspace_id}`,
			"PATCH",
			`/workspaces/${entry.workspace_id}/time_entries/${entry.id}/stop`,
		);
	}

	/**
	 * Gets the workspaces the user belongs to.
	 * @returns The workspaces.
	 */
	async getWorkspaces(): Promise<Workspace[]> {
		return (await this.#request<Workspace[] | null>("user", "GET", "/me/workspaces")) ?? [];
	}

	/**
	 * Gets the active (non-archived) projects in a workspace.
	 * @param workspaceId The workspace.
	 * @returns The projects.
	 */
	getProjects(workspaceId: number): Promise<Project[]> {
		return this.#getAllPages(`workspace:${workspaceId}`, `/workspaces/${workspaceId}/projects?active=true`);
	}

	/**
	 * Gets the tags in a workspace.
	 * @param workspaceId The workspace.
	 * @returns The tags.
	 */
	getTags(workspaceId: number): Promise<Tag[]> {
		return this.#getAllPages(`workspace:${workspaceId}`, `/workspaces/${workspaceId}/tags`);
	}

	/**
	 * Gets every page of a paginated list, de-duplicated by ID.
	 * @param scope The quota scope.
	 * @param path The path of the list, optionally with a query string.
	 * @returns The items.
	 */
	async #getAllPages<T extends { id: number }>(scope: QuotaScope, path: string): Promise<T[]> {
		const items = new Map<number, T>();
		const separator = path.includes("?") ? "&" : "?";

		for (let page = 1; page <= MAX_PAGES; page++) {
			const batch = (await this.#request<T[] | null>(scope, "GET", `${path}${separator}page=${page}&per_page=${PAGE_SIZE}`)) ?? [];
			for (const item of batch) {
				items.set(item.id, item);
			}

			if (batch.length < PAGE_SIZE) {
				break;
			}
		}

		return [...items.values()];
	}

	/**
	 * Queues a request behind any that are in flight.
	 * @param scope The quota scope.
	 * @param method The HTTP method.
	 * @param path The path, relative to the v9 API.
	 * @param body The JSON body, if any.
	 * @returns The parsed response.
	 */
	#request<T>(scope: QuotaScope, method: string, path: string, body?: object): Promise<T> {
		const send = (): Promise<T> => this.#send<T>(scope, method, path, body);
		const result = this.#queue.then(send, send);
		this.#queue = result.catch(() => undefined);

		return result;
	}

	/**
	 * Sends a request, retrying briefly when Toggl's burst limit is hit.
	 * @param scope The quota scope.
	 * @param method The HTTP method.
	 * @param path The path, relative to the v9 API.
	 * @param body The JSON body, if any.
	 * @param attempt The retry attempt.
	 * @returns The parsed response.
	 */
	async #send<T>(scope: QuotaScope, method: string, path: string, body?: object, attempt = 0): Promise<T> {
		const quota = this.quota(scope);
		if (quota !== undefined && quota.remaining <= 0) {
			throw new TogglError("Toggl's hourly request limit has been reached.", 402, quota.resetsAt);
		}

		const response = await fetch(`${BASE_URL}${path}`, {
			method,
			headers: {
				Authorization: this.#authorization,
				...(body !== undefined && { "Content-Type": "application/json" }),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		this.#recordQuota(scope, response);

		if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
			const retryAfter = Number(response.headers.get("Retry-After"));
			await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
			return this.#send(scope, method, path, body, attempt + 1);
		}

		const text = await response.text();
		if (!response.ok) {
			throw new TogglError(
				`${method} ${path.split("?")[0]} failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
				response.status,
				this.quota(scope)?.resetsAt,
			);
		}

		return (text ? JSON.parse(text) : null) as T;
	}

	/**
	 * Records the quota status reported by a response.
	 * @param scope The quota scope.
	 * @param response The response.
	 */
	#recordQuota(scope: QuotaScope, response: Response): void {
		const remaining = response.headers.get("X-Toggl-Quota-Remaining");
		const resetsIn = response.headers.get("X-Toggl-Quota-Resets-In");

		if (remaining !== null && resetsIn !== null && Number.isFinite(Number(remaining)) && Number.isFinite(Number(resetsIn))) {
			this.#quotas.set(scope, { remaining: Number(remaining), resetsAt: Date.now() + Number(resetsIn) * 1000 });
		}

		if (response.status === 402) {
			const backoff = resetsIn !== null && Number(resetsIn) > 0 ? Number(resetsIn) : DEFAULT_QUOTA_BACKOFF_S;
			this.#quotas.set(scope, { remaining: 0, resetsAt: Date.now() + backoff * 1000 });
		}
	}
}
