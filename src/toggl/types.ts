/**
 * The subset of a Toggl Track v9 time entry used by the plugin.
 */
export type TimeEntry = {
	id: number;
	workspace_id: number;
	project_id: number | null;
	description: string | null;
	start: string;
	tag_ids: number[] | null;
	/** Only present when the request asked for `meta=true`. */
	project_color?: string;
};

export type Workspace = {
	id: number;
	name: string;
};

export type Project = {
	id: number;
	name: string;
	color: string;
};

export type Tag = {
	id: number;
	name: string;
};

/**
 * What a key starts, and how it recognizes its own running entry.
 */
export type EntryTarget = {
	workspaceId: number;
	projectId: number | null;
	description: string;
	/** Sorted and de-duplicated, so targets can be compared with {@link isSameEntry}. */
	tagIds: number[];
};

/**
 * Determines whether the running entry is the one the target would start. Tags are compared as a set so that two keys
 * that differ only by tag don't both light up.
 * @param entry The running entry, if any.
 * @param target The key's target.
 * @returns `true` when the entry matches the target.
 */
export function isSameEntry(entry: TimeEntry | null, target: EntryTarget): boolean {
	if (entry === null) {
		return false;
	}

	const tagIds = normalizeIds(entry.tag_ids ?? []);
	return (
		entry.workspace_id === target.workspaceId &&
		(entry.project_id ?? null) === target.projectId &&
		(entry.description ?? "").trim() === target.description &&
		tagIds.length === target.tagIds.length &&
		tagIds.every((id, i) => id === target.tagIds[i])
	);
}

/**
 * Converts IDs to positive integers, dropping anything invalid, then sorts and de-duplicates them.
 * @param ids The IDs to normalize.
 * @returns The normalized IDs.
 */
export function normalizeIds(ids: ReadonlyArray<number | string>): number[] {
	const valid = ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
	return [...new Set(valid)].sort((a, b) => a - b);
}
