import streamDeck from "@elgato/streamdeck";

import { TogglError, type TogglClient } from "./client";
import { isSameEntry, type EntryTarget, type TimeEntry } from "./types";

/**
 * How often to check Toggl for the running entry while keys are visible. Toggl's Free plan allows 30 requests an hour
 * to `/me` endpoints, which include this check; checking every 5 minutes uses 12 of them, leaving the rest for key
 * presses and the property inspector. The trade-off is that timers started or stopped in other Toggl apps can take up
 * to 5 minutes to show on the keys.
 */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A key press re-checks the running entry first when the last check is older than this, so it stops or starts the
 * right thing even if the timer was changed in another Toggl app since the last check.
 */
export const PRESS_MAX_AGE_MS = 60 * 1000;

/** Background checks pause when this few `/me` requests remain in the hour, saving them for key presses. */
const POLL_RESERVE = 5;

const logger = streamDeck.logger.createScope("RunningEntry");

/**
 * What a key press should do: toggle the key's entry, or (from a multi-action) make sure it is started or stopped.
 */
export type PressIntent = "toggle" | "start" | "stop";

/**
 * Tracks the user's running time entry: checks Toggl periodically while keys are visible, and starts or stops entries
 * when keys are pressed. Elapsed time is counted locally from the entry's start, so it costs no requests.
 */
export class RunningEntryTracker {
	readonly #listeners = new Set<() => void>();
	#client?: TogglClient;
	#entry: TimeEntry | null = null;
	/** When the running entry was last known to be accurate. */
	#checkedAt?: number;
	/** When the last check was attempted, successful or not; paces the polling. */
	#attemptedAt = 0;
	/** Incremented on every change, so a check that was in flight can't overwrite a newer start or stop. */
	#version = 0;
	#pending?: Promise<void>;
	#presses: Promise<void> = Promise.resolve();
	#polling = false;
	#timer?: NodeJS.Timeout;

	/**
	 * The client for the configured API token, if there is one.
	 * @returns The client; otherwise `undefined`.
	 */
	get client(): TogglClient | undefined {
		return this.#client;
	}

	/**
	 * The running entry, as last seen.
	 * @returns The entry; otherwise `null`.
	 */
	get entry(): TimeEntry | null {
		return this.#entry;
	}

	/**
	 * Whether Toggl is being checked periodically, i.e. keys are visible.
	 * @returns `true` when polling.
	 */
	get isPolling(): boolean {
		return this.#polling;
	}

	/**
	 * Registers a listener that is called whenever the running entry changes.
	 * @param listener The listener.
	 */
	onChange(listener: () => void): void {
		this.#listeners.add(listener);
	}

	/**
	 * Switches to the client for a new API token, forgetting the running entry of the previous one.
	 * @param client The new client; `undefined` when the token was removed.
	 */
	setClient(client: TogglClient | undefined): void {
		this.#client = client;
		this.#checkedAt = undefined;
		this.#attemptedAt = 0;
		// A check that is still in flight belongs to the previous token; its result is discarded by #check.
		this.#pending = undefined;
		this.#set(null);
		this.#schedule();
	}

	/**
	 * Starts checking Toggl periodically; called while at least one key is visible.
	 */
	startPolling(): void {
		if (!this.#polling) {
			this.#polling = true;
			this.#schedule();
		}
	}

	/**
	 * Stops checking Toggl periodically; called when no keys are visible.
	 */
	stopPolling(): void {
		this.#polling = false;
		clearTimeout(this.#timer);
	}

	/**
	 * Checks Toggl for the running entry when the last check is older than the given age.
	 * @param maxAgeMs The maximum age of the last check, in milliseconds.
	 */
	async refreshIfOlderThan(maxAgeMs: number): Promise<void> {
		if (this.#checkedAt === undefined || Date.now() - this.#checkedAt > maxAgeMs) {
			await this.refresh();
		}
	}

	/**
	 * Checks Toggl for the running entry. Concurrent calls share a single request.
	 */
	refresh(): Promise<void> {
		if (this.#pending === undefined) {
			const pending = this.#check().finally(() => {
				if (this.#pending === pending) {
					this.#pending = undefined;
				}

				this.#schedule();
			});

			this.#pending = pending;
		}

		return this.#pending;
	}

	/**
	 * Handles a key press. Toggling stops the running entry when it is the target's, and otherwise starts the target
	 * (Toggl stops whatever was running). Multi-actions can instead ask for the target to be started or stopped.
	 * Presses are handled one at a time.
	 * @param target What the pressed key starts.
	 * @param intent What the press should do.
	 */
	press(target: EntryTarget, intent: PressIntent = "toggle"): Promise<void> {
		const run = (): Promise<void> => this.#press(target, intent);
		const result = this.#presses.then(run, run);
		this.#presses = result.catch(() => undefined);

		return result;
	}

	/**
	 * Handles a single key press; see {@link RunningEntryTracker.press}.
	 * @param target What the pressed key starts.
	 * @param intent What the press should do.
	 */
	async #press(target: EntryTarget, intent: PressIntent): Promise<void> {
		const client = this.#client;
		if (client === undefined) {
			throw new Error("No API token has been set.");
		}

		// When the check fails, e.g. because the hourly quota is used up, act on what was seen last.
		await this.refreshIfOlderThan(PRESS_MAX_AGE_MS).catch((err) => logger.warn(`Couldn't check the running entry before a key press: ${err}`));

		const running = this.#entry;
		const isRunning = running !== null && isSameEntry(running, target);
		const stop = intent === "toggle" ? isRunning : intent === "stop";
		if (stop !== isRunning) {
			return;
		}

		let entry: TimeEntry | null = null;
		if (stop && running !== null) {
			try {
				await client.stopEntry(running);
			} catch (err) {
				// Already stopped (409) or deleted (404) in another Toggl app, which is what the press asked for.
				if (!(err instanceof TogglError && (err.status === 404 || err.status === 409))) {
					throw err;
				}
			}
		} else {
			entry = await client.startEntry(target);
		}

		if (client === this.#client) {
			this.#checkedAt = Date.now();
			this.#set(entry);
		}
	}

	/**
	 * Fetches the running entry from Toggl.
	 */
	async #check(): Promise<void> {
		const client = this.#client;
		if (client === undefined) {
			return;
		}

		const version = this.#version;
		this.#attemptedAt = Date.now();
		const entry = await client.getCurrentEntry();

		// Discard the result when the token changed, or a key started or stopped an entry, while this was in flight.
		if (client === this.#client && version === this.#version) {
			this.#checkedAt = Date.now();
			this.#set(entry);
		}
	}

	/**
	 * Schedules the next periodic check, deferring it until the quota resets when few requests remain.
	 */
	#schedule(): void {
		clearTimeout(this.#timer);
		if (!this.#polling || this.#client === undefined) {
			return;
		}

		let due = this.#attemptedAt + POLL_INTERVAL_MS;
		const quota = this.#client.quota("user");
		if (quota !== undefined && quota.remaining <= POLL_RESERVE) {
			due = Math.max(due, quota.resetsAt);
		}

		this.#timer = setTimeout(() => {
			this.refresh().catch((err) => logger.warn(`Couldn't check the running entry: ${err}`));
		}, Math.max(0, due - Date.now()));
	}

	/**
	 * Updates the running entry, notifying listeners when it changed.
	 * @param entry The running entry, if any.
	 */
	#set(entry: TimeEntry | null): void {
		this.#version++;
		if (JSON.stringify(entry) === JSON.stringify(this.#entry)) {
			return;
		}

		this.#entry = entry;
		for (const listener of this.#listeners) {
			listener();
		}
	}
}
