/**
 * Plugin-wide settings shared by every key. The API token lives here rather than in per-key settings because per-key
 * settings are stored as plain text and included when a Stream Deck profile is exported.
 */
export type GlobalSettings = {
	apiToken?: string;
};

/**
 * Settings for a single timer key, edited in its property inspector. IDs are strings because that is how the
 * property inspector's selects and checkboxes store them. The key's label is Stream Deck's own title, not a setting.
 */
export type TimerSettings = {
	description?: string;
	workspaceId?: string;
	projectId?: string;
	tagIds?: string[];
};
