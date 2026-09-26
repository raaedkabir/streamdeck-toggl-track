import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TitleParametersDidChangeEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { NO_PROJECT_COLOR, runningKeyImage } from "../key-view";
import type { TimerSettings } from "../settings";
import type { Catalog } from "../toggl/catalog";
import { describeError } from "../toggl/client";
import type { PressIntent, RunningEntryTracker } from "../toggl/running-entry";
import { isSameEntry, normalizeIds, type EntryTarget, type TimeEntry } from "../toggl/types";

const logger = streamDeck.logger.createScope("Timer");

/**
 * The manifest's states. Keys always show state 0, because Stream Deck keeps title settings (font, size, alignment) per
 * state, and switching states would swap out the user's settings. Running keys are drawn with an image instead; state 1
 * only lets a multi-action step ask for the entry to be running.
 */
const STOPPED = 0;
const RUNNING = 1;

/**
 * A request from one of the property inspector's data-sourced fields (the `datasource` attribute of sdpi-components).
 */
type DataSourceRequest = {
	event?: string;
	isRefresh?: boolean;
};

type DataSourceItem = {
	value: string;
	label: string;
	disabled?: boolean;
};

/** What was last sent to a key, so that only changes are sent; the image changes every second while running. */
type KeyView = {
	/** `undefined` shows the image from the manifest. */
	image?: string;
	title: string;
};

type VisibleKey = {
	action: KeyAction<TimerSettings>;
	settings: TimerSettings;
};

/**
 * A key that starts and stops a Toggl Track time entry. While its entry is running, the key shows the project's color
 * and the elapsed time.
 */
@action({ UUID: "com.raaedkabir.toggl-track.timer" })
export class TimerAction extends SingletonAction<TimerSettings> {
	readonly #tracker: RunningEntryTracker;
	readonly #catalog: Catalog;
	readonly #keys = new Map<string, VisibleKey>();
	readonly #views = new Map<string, KeyView>();
	/** Projects whose color has been looked up, so each is only looked up once. */
	readonly #colorLookups = new Set<number>();
	/** Keys whose blank title has already been sent the description again; see onTitleParametersDidChange. */
	readonly #titlesResent = new Set<string>();
	#ticker?: NodeJS.Timeout;
	/** The key, and workspace, whose projects and tags were last sent to the property inspector. */
	#inspected?: { actionId: string; workspaceId?: string };

	/**
	 * Initializes a new instance of the {@link TimerAction} class.
	 * @param tracker Tracks the running entry.
	 * @param catalog Caches workspaces, projects, and tags.
	 */
	constructor(tracker: RunningEntryTracker, catalog: Catalog) {
		super();
		this.#tracker = tracker;
		this.#catalog = catalog;
		tracker.onChange(() => void this.#renderAll());
	}

	/**
	 * Updates the keys, and the property inspector if it is open, after the API token changes.
	 */
	async accountChanged(): Promise<void> {
		this.#colorLookups.clear();
		await this.#renderAll();

		const inspected = streamDeck.ui.action;
		if (inspected !== undefined && inspected.manifestId === this.manifestId) {
			const settings = (await inspected.getSettings()) as TimerSettings;
			await this.#sendWorkspaces(false);
			await this.#sendProjects(inspected.id, settings, false);
			await this.#sendTags(settings, false);
		}
	}

	/** @inheritdoc */
	override async onWillAppear(ev: WillAppearEvent<TimerSettings>): Promise<void> {
		// Keys within multi-actions aren't shown on the device, so they are only handled when pressed.
		if (!ev.action.isKey() || ev.payload.isInMultiAction) {
			return;
		}

		this.#keys.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		this.#views.delete(ev.action.id);
		this.#tracker.startPolling();

		// Keys left in state 1 by an earlier build would otherwise keep that state's title settings.
		if (ev.payload.state !== undefined && ev.payload.state !== STOPPED) {
			await ev.action.setState(STOPPED);
		}

		await this.#render(ev.action.id);
		this.#updateTicker();
	}

	/** @inheritdoc */
	override onWillDisappear(ev: WillDisappearEvent<TimerSettings>): void {
		this.#keys.delete(ev.action.id);
		this.#views.delete(ev.action.id);
		this.#titlesResent.delete(ev.action.id);

		if (this.#keys.size === 0) {
			this.#tracker.stopPolling();
		}

		this.#updateTicker();
	}

	/** @inheritdoc */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TimerSettings>): Promise<void> {
		const { settings } = ev.payload;
		const key = this.#keys.get(ev.action.id);
		if (key !== undefined) {
			key.settings = settings;
			await this.#render(ev.action.id);
			this.#updateTicker();
		}

		// Projects and tags belong to a workspace, so the property inspector's lists change with it.
		if (this.#inspected?.actionId === ev.action.id && this.#inspected.workspaceId !== settings.workspaceId) {
			await this.#sendProjects(ev.action.id, settings, false);
			await this.#sendTags(settings, false);
		}
	}

	/** @inheritdoc */
	override async onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<TimerSettings>): Promise<void> {
		const key = this.#keys.get(ev.action.id);
		const view = this.#views.get(ev.action.id);
		if (key === undefined || view === undefined) {
			return;
		}

		if (ev.payload.title !== "") {
			this.#titlesResent.delete(ev.action.id);
			return;
		}

		// A key whose title was cleared by the user can be left blank, so send the description again. Only once, in case
		// Stream Deck reports the title as blank again in response.
		if (view.title !== "" && !this.#titlesResent.has(ev.action.id)) {
			this.#titlesResent.add(ev.action.id);
			await key.action.setTitle(view.title);
		}
	}

	/** @inheritdoc */
	override async onKeyDown(ev: KeyDownEvent<TimerSettings>): Promise<void> {
		const target = toTarget(ev.payload.settings);
		if (this.#tracker.client === undefined || target === undefined) {
			// The API token, or the key's workspace, hasn't been set yet.
			await ev.action.showAlert();
			return;
		}

		// Within a multi-action, the user chooses whether the step starts or stops the entry.
		let intent: PressIntent = "toggle";
		if (ev.payload.isInMultiAction) {
			intent = ev.payload.userDesiredState === RUNNING ? "start" : "stop";
		}

		try {
			await this.#tracker.press(target, intent);
		} catch (err) {
			logger.error(`Couldn't ${intent} the time entry: ${err}`);
			await ev.action.showAlert();
		}
	}

	/** @inheritdoc */
	override async onSendToPlugin(ev: SendToPluginEvent<DataSourceRequest, TimerSettings>): Promise<void> {
		if (typeof ev.payload !== "object" || ev.payload === null) {
			return;
		}

		const refresh = ev.payload.isRefresh === true;
		switch (ev.payload.event) {
			case "workspaces":
				await this.#sendWorkspaces(refresh);
				break;
			case "projects":
				await this.#sendProjects(ev.action.id, await ev.action.getSettings(), refresh);
				break;
			case "tags":
				await this.#sendTags(await ev.action.getSettings(), refresh);
				break;
		}
	}

	/**
	 * Sends the user's workspaces to the property inspector. Loading them also checks the API token, so this reports
	 * any problem with it.
	 * @param refresh Whether to bypass the cache.
	 */
	async #sendWorkspaces(refresh: boolean): Promise<void> {
		const client = this.#tracker.client;
		let items: DataSourceItem[] = [];
		let status = "";

		if (client === undefined) {
			status = "Paste your Toggl API token to get started.";
		} else {
			try {
				const workspaces = await this.#catalog.workspaces(client, refresh);
				items = workspaces.map((workspace) => ({ value: workspace.id.toString(), label: workspace.name }));
			} catch (err) {
				logger.warn(`Couldn't load workspaces: ${err}`);
				status = describeError(err);
			}
		}

		await streamDeck.ui.sendToPropertyInspector({ event: "workspaces", items });
		await this.#sendStatus(status);
	}

	/**
	 * Sends the projects of the key's workspace to the property inspector.
	 * @param actionId The key being inspected.
	 * @param settings The key's settings.
	 * @param refresh Whether to bypass the cache.
	 */
	async #sendProjects(actionId: string, settings: TimerSettings, refresh: boolean): Promise<void> {
		this.#inspected = { actionId, workspaceId: settings.workspaceId };

		const items: DataSourceItem[] = [{ value: "", label: "No project" }];
		const client = this.#tracker.client;
		const workspaceId = toWorkspaceId(settings.workspaceId);

		if (client !== undefined && workspaceId !== undefined) {
			try {
				const projects = await this.#catalog.projects(client, workspaceId, refresh);
				items.push(...projects.map((project) => ({ value: project.id.toString(), label: project.name })));
			} catch (err) {
				logger.warn(`Couldn't load projects: ${err}`);
				await this.#sendStatus(describeError(err));
			}
		}

		await streamDeck.ui.sendToPropertyInspector({ event: "projects", items });
	}

	/**
	 * Sends the tags of the key's workspace to the property inspector.
	 * @param settings The key's settings.
	 * @param refresh Whether to bypass the cache.
	 */
	async #sendTags(settings: TimerSettings, refresh: boolean): Promise<void> {
		let items: DataSourceItem[] = [];
		const client = this.#tracker.client;
		const workspaceId = toWorkspaceId(settings.workspaceId);

		if (client !== undefined && workspaceId !== undefined) {
			try {
				const tags = await this.#catalog.tags(client, workspaceId, refresh);
				items = tags.map((tag) => ({ value: tag.id.toString(), label: tag.name }));
			} catch (err) {
				logger.warn(`Couldn't load tags: ${err}`);
				await this.#sendStatus(describeError(err));
			}
		}

		if (items.length === 0) {
			items = [{ value: "", label: workspaceId === undefined ? "Choose a workspace first" : "No tags", disabled: true }];
		}

		await streamDeck.ui.sendToPropertyInspector({ event: "tags", items });
	}

	/**
	 * Shows a message in the property inspector, or hides it when empty.
	 * @param message The message.
	 */
	async #sendStatus(message: string): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector({ event: "status", message });
	}

	/**
	 * Updates every visible key.
	 */
	async #renderAll(): Promise<void> {
		await Promise.all([...this.#keys.keys()].map((id) => this.#render(id)));
		this.#updateTicker();
	}

	/**
	 * Updates a visible key, sending only what changed since it was last updated.
	 * @param actionId The key.
	 */
	async #render(actionId: string): Promise<void> {
		const key = this.#keys.get(actionId);
		if (key === undefined) {
			return;
		}

		const view = this.#viewOf(key.settings);
		const last = this.#views.get(actionId);
		this.#views.set(actionId, view);

		try {
			if (last === undefined || last.image !== view.image) {
				await key.action.setImage(view.image);
			}

			if (last?.title !== view.title) {
				await key.action.setTitle(view.title);
			}
		} catch (err) {
			// Send everything again next time.
			this.#views.delete(actionId);
			logger.warn(`Couldn't update a key: ${err}`);
		}
	}

	/**
	 * Determines what a key should show.
	 * @param settings The key's settings.
	 * @returns The key's view.
	 */
	#viewOf(settings: TimerSettings): KeyView {
		// Stream Deck shows this only when the user hasn't given the key a title of their own. Either way the title doesn't
		// change when the entry starts or stops; the elapsed time is part of the image.
		const title = settings.description?.trim() ?? "";
		const target = toTarget(settings);
		const entry = this.#tracker.entry;

		if (target === undefined || entry === null || !isSameEntry(entry, target)) {
			return { title };
		}

		return { title, image: runningKeyImage(this.#colorOf(entry, target), Date.now() - Date.parse(entry.start)) };
	}

	/**
	 * Gets the color of a running key: its project's color, or Toggl's pink when it has no project. An unknown project
	 * color is looked up once, and the keys are updated when it arrives.
	 * @param entry The running entry.
	 * @param target The key's target, which matches the entry.
	 * @returns The color, as a `#rrggbb` hex string.
	 */
	#colorOf(entry: TimeEntry, target: EntryTarget): string {
		if (target.projectId === null) {
			return NO_PROJECT_COLOR;
		}

		this.#catalog.rememberProjectColor(target.projectId, entry.project_color);
		const color = this.#catalog.projectColor(target.projectId);
		if (color !== undefined) {
			return color;
		}

		const client = this.#tracker.client;
		if (client !== undefined && !this.#colorLookups.has(target.projectId)) {
			this.#colorLookups.add(target.projectId);
			this.#catalog.projects(client, target.workspaceId).then(
				() => this.#renderAll(),
				(err) => logger.warn(`Couldn't look up project colors: ${err}`),
			);
		}

		return NO_PROJECT_COLOR;
	}

	/**
	 * Runs a once-a-second update of the elapsed time while a visible key's entry is running. The time is counted
	 * locally, so this makes no requests.
	 */
	#updateTicker(): void {
		const entry = this.#tracker.entry;
		const running =
			entry !== null &&
			[...this.#keys.values()].some((key) => {
				const target = toTarget(key.settings);
				return target !== undefined && isSameEntry(entry, target);
			});

		if (running && this.#ticker === undefined) {
			this.#ticker = setInterval(() => void this.#renderAll(), 1000);
		} else if (!running && this.#ticker !== undefined) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}
}

/**
 * Reads what a key starts from its settings.
 * @param settings The key's settings.
 * @returns The target; otherwise `undefined` when no workspace has been chosen.
 */
function toTarget(settings: TimerSettings): EntryTarget | undefined {
	const workspaceId = toWorkspaceId(settings.workspaceId);
	if (workspaceId === undefined) {
		return undefined;
	}

	const [projectId] = normalizeIds(settings.projectId ? [settings.projectId] : []);
	return {
		workspaceId,
		projectId: projectId ?? null,
		description: settings.description?.trim() ?? "",
		tagIds: normalizeIds(settings.tagIds ?? []),
	};
}

/**
 * Parses a workspace ID from a key's settings.
 * @param value The setting.
 * @returns The workspace ID; otherwise `undefined`.
 */
function toWorkspaceId(value: string | undefined): number | undefined {
	const [workspaceId] = normalizeIds(value ? [value] : []);
	return workspaceId;
}
