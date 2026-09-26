import type { TogglClient } from "./client";
import type { Project, Tag, Workspace } from "./types";

/** Workspaces, projects, and tags rarely change, so they are cached to save requests from the hourly quota. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Failed lookups are retried sooner, so a brief outage doesn't leave the property inspector empty for long. */
const FAILURE_TTL_MS = 60 * 1000;

type CacheEntry<T> = {
	value: Promise<T>;
	fetchedAt: number;
	failed: boolean;
};

/**
 * Caches the user's workspaces, and the projects and tags within them, along with the color of each project.
 */
export class Catalog {
	readonly #workspaces = new Map<string, CacheEntry<Workspace[]>>();
	readonly #projects = new Map<number, CacheEntry<Project[]>>();
	readonly #tags = new Map<number, CacheEntry<Tag[]>>();
	readonly #projectColors = new Map<number, string>();
	#generation = 0;

	/**
	 * Forgets everything; used when the API token changes.
	 */
	clear(): void {
		this.#generation++;
		this.#workspaces.clear();
		this.#projects.clear();
		this.#tags.clear();
		this.#projectColors.clear();
	}

	/**
	 * Gets the user's workspaces, sorted by name.
	 * @param client The Toggl client.
	 * @param refresh Whether to bypass the cache.
	 * @returns The workspaces.
	 */
	workspaces(client: TogglClient, refresh = false): Promise<Workspace[]> {
		return this.#cached(this.#workspaces, "", refresh, async () => sortByName(await client.getWorkspaces()));
	}

	/**
	 * Gets the active projects in a workspace, sorted by name.
	 * @param client The Toggl client.
	 * @param workspaceId The workspace.
	 * @param refresh Whether to bypass the cache.
	 * @returns The projects.
	 */
	projects(client: TogglClient, workspaceId: number, refresh = false): Promise<Project[]> {
		const generation = this.#generation;
		return this.#cached(this.#projects, workspaceId, refresh, async () => {
			const projects = sortByName(await client.getProjects(workspaceId));
			if (generation === this.#generation) {
				for (const project of projects) {
					this.rememberProjectColor(project.id, project.color);
				}
			}

			return projects;
		});
	}

	/**
	 * Gets the tags in a workspace, sorted by name.
	 * @param client The Toggl client.
	 * @param workspaceId The workspace.
	 * @param refresh Whether to bypass the cache.
	 * @returns The tags.
	 */
	tags(client: TogglClient, workspaceId: number, refresh = false): Promise<Tag[]> {
		return this.#cached(this.#tags, workspaceId, refresh, async () => sortByName(await client.getTags(workspaceId)));
	}

	/**
	 * Gets the color of a project, when known.
	 * @param projectId The project.
	 * @returns The color, as a `#rrggbb` hex string; otherwise `undefined`.
	 */
	projectColor(projectId: number): string | undefined {
		return this.#projectColors.get(projectId);
	}

	/**
	 * Remembers the color of a project, ignoring anything that isn't a `#rrggbb` hex color.
	 * @param projectId The project.
	 * @param color The color reported by Toggl.
	 */
	rememberProjectColor(projectId: number, color: string | undefined): void {
		if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) {
			this.#projectColors.set(projectId, color);
		}
	}

	/**
	 * Gets a value from a cache, loading it when missing or expired. Concurrent callers share the same request.
	 * @param cache The cache.
	 * @param key The key within the cache.
	 * @param refresh Whether to bypass the cache.
	 * @param load Loads the value.
	 * @returns The value.
	 */
	#cached<K, T>(cache: Map<K, CacheEntry<T>>, key: K, refresh: boolean, load: () => Promise<T>): Promise<T> {
		const hit = cache.get(key);
		if (!refresh && hit !== undefined && Date.now() - hit.fetchedAt < (hit.failed ? FAILURE_TTL_MS : CACHE_TTL_MS)) {
			return hit.value;
		}

		const entry: CacheEntry<T> = { value: load(), fetchedAt: Date.now(), failed: false };
		entry.value.catch(() => (entry.failed = true));
		cache.set(key, entry);

		return entry.value;
	}
}

/**
 * Sorts items by name, case-insensitively.
 * @param items The items.
 * @returns The sorted items.
 */
function sortByName<T extends { name: string }>(items: T[]): T[] {
	return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
