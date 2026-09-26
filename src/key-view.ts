import { DIGIT_BOTTOM, DIGIT_TOP, GLYPHS } from "./digit-glyphs";

/**
 * Background of a running key whose entry has no project (Toggl Track's pink). Also used while a project's color is
 * still being looked up.
 */
export const NO_PROJECT_COLOR = "#e57cd8";

/** Key images are 144 × 144; Stream Deck's title font sizes use the key's 72-point scale, i.e. half these values. */
const KEY_SIZE = 144;

/** The elapsed time is drawn as large as fits this width, up to this font size (22 on Stream Deck's title scale). */
const TIME_MAX_WIDTH = 128;
const TIME_MAX_FONT_SIZE = 44;

/**
 * Renders the image of a running key: the elapsed time, centered on the project's color. Centering it leaves room for
 * the key's title above or below it, depending on the user's title settings.
 * @param color The project's color, as a `#rrggbb` hex string.
 * @param elapsedMs How long the entry has been running.
 * @returns The image as an SVG data URL.
 */
export function runningKeyImage(color: string, elapsedMs: number): string {
	const fill = /^#[0-9a-f]{6}$/i.test(color) ? color : NO_PROJECT_COLOR;
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">` +
		`<rect width="${KEY_SIZE}" height="${KEY_SIZE}" fill="${fill}"/>` +
		`<g fill="#ffffff">${centeredDigits(formatElapsed(elapsedMs))}</g>` +
		`</svg>`;

	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Formats a duration as `MM:SS`, or `H:MM:SS` from an hour upwards.
 * @param ms The duration, in milliseconds.
 * @returns The formatted duration.
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (value: number): string => value.toString().padStart(2, "0");

	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Lays out digits and colons as outlines, centered on the key. Outlines are used rather than SVG text so the result
 * doesn't depend on the fonts available to Stream Deck.
 * @param text The text, containing only digits and colons.
 * @returns The SVG paths.
 */
function centeredDigits(text: string): string {
	const glyphs = [...text].map((char) => GLYPHS[char]);
	const width = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
	const scale = Math.min(TIME_MAX_FONT_SIZE, (TIME_MAX_WIDTH * 1000) / width) / 1000;
	const baseline = KEY_SIZE / 2 - ((DIGIT_TOP + DIGIT_BOTTOM) / 2) * scale;
	let x = (KEY_SIZE - width * scale) / 2;

	return glyphs
		.map((glyph) => {
			const path = `<path transform="translate(${x.toFixed(2)} ${baseline.toFixed(2)}) scale(${scale.toFixed(5)})" d="${glyph.path}"/>`;
			x += glyph.advance * scale;
			return path;
		})
		.join("");
}
