import streamDeck from "@elgato/streamdeck";

import { TimerAction } from "./actions/timer";
import type { GlobalSettings } from "./settings";
import { Catalog } from "./toggl/catalog";
import { TogglClient } from "./toggl/client";
import { PRESS_MAX_AGE_MS, RunningEntryTracker } from "./toggl/running-entry";

const logger = streamDeck.logger.createScope("Plugin");

/** The property inspector saves the API token while it's being typed; wait for a pause before trying it. */
const TOKEN_DEBOUNCE_MS = 1000;

const catalog = new Catalog();
const tracker = new RunningEntryTracker();
const timer = new TimerAction(tracker, catalog);

let apiToken: string | undefined;
let apiTokenTimer: NodeJS.Timeout | undefined;

/**
 * Switches to the given API token, forgetting everything loaded with the previous one.
 * @param token The API token; `undefined` or empty when it was removed.
 */
function useApiToken(token: string | undefined): void {
	const trimmed = token?.trim() || undefined;
	if (trimmed === apiToken) {
		return;
	}

	apiToken = trimmed;
	catalog.clear();
	tracker.setClient(trimmed !== undefined ? new TogglClient(trimmed) : undefined);
	timer.accountChanged().catch((err) => logger.warn(`Couldn't update after the API token changed: ${err}`));
}

streamDeck.actions.registerAction(timer);

// Only fires for changes made in the property inspector.
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
	clearTimeout(apiTokenTimer);
	apiTokenTimer = setTimeout(() => useApiToken(ev.settings.apiToken), TOKEN_DEBOUNCE_MS);
});

// Timers may have been started or stopped in other Toggl apps while the computer was asleep.
streamDeck.system.onSystemDidWakeUp(() => {
	if (tracker.isPolling) {
		tracker.refreshIfOlderThan(PRESS_MAX_AGE_MS).catch((err) => logger.warn(`Couldn't check the running entry after waking up: ${err}`));
	}
});

await streamDeck.connect();
useApiToken((await streamDeck.settings.getGlobalSettings<GlobalSettings>()).apiToken);
