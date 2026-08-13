import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * dsh-tool-browser — native browser automation tools for DeepSeek Harness.
 *
 * Registers model-facing browser tools (navigate, click, type, snapshot,
 * screenshot, evaluate, tabs, …) backed by Playwright. By default it launches
 * the user's installed Microsoft Edge (`channel: "msedge"`) — no browser
 * download — and falls back to Playwright's bundled Chromium when the channel
 * is missing. One browser per plugin instance keeps a session's browsing state
 * continuous; a tab list replaces the original single page, so the model can
 * open, switch, list and close tabs. Tools are exclusive (not
 * concurrency-safe) because they operate on the shared session. Every tool
 * forwards `exec.signal` so abort/timeout policies never hang an agent turn,
 * and errors are prefixed with the tool name.
 *
 * @module dsh-tool-browser
 */

const name = "dsh-tool-browser";
const inject = ["tools", "systemPrompt"];

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60000;
const DEFAULT_ACTION_TIMEOUT_MS = 10000;
const DEFAULT_SNAPSHOT_MAX_CHARS = 12000;
const DEFAULT_EVALUATE_MAX_CHARS = 4000;
const DEFAULT_CONSOLE_MAX_MESSAGES = 100;
const LAUNCH_TIMEOUT_MS = 30000;

const Config = z.object({
	headless: z.boolean().default(true),
	channel: z.string().default("msedge"),
	outputDir: z.string(),
	allowedHosts: z.array(z.string()).default([]),
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	navigationTimeoutMs: z.number().default(DEFAULT_NAVIGATION_TIMEOUT_MS),
	actionTimeoutMs: z.number().default(DEFAULT_ACTION_TIMEOUT_MS),
	snapshotMaxChars: z.number().default(DEFAULT_SNAPSHOT_MAX_CHARS),
	evaluateMaxChars: z.number().default(DEFAULT_EVALUATE_MAX_CHARS),
	viewportWidth: z.number().default(1280),
	viewportHeight: z.number().default(720)
});

function assertPositiveInteger(field, value) {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`dsh-tool-browser: ${field} must be a positive integer`);
	}
}

/** Reject a promise that does not settle within `ms`. */
function withTimeout(promise, ms, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); }
		);
	});
}

/**
 * Race a Playwright operation against the caller's abort signal. On abort the
 * tool result rejects immediately (the underlying browser work is left to
 * settle on its own) so an agent turn is never blocked.
 */
function withAbort(promise, signal, label) {
	if (signal.aborted) return Promise.reject(new Error(`${label} aborted`));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(`${label} aborted`));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			}
		);
	});
}

/** Wrap a tool body so every failure carries the tool name for the model. */
function tool(label, fn) {
	return async (args, exec) => {
		try {
			return await fn(args, exec);
		} catch (error) {
			throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}

/**
 * Enforce an optional host allowlist before navigation. Empty allowlist allows
 * everything; `"*"` allows every host; local `data:`/`about:` URLs always pass.
 */
function checkAllowedHost(url, allowedHosts) {
	if (allowedHosts.length === 0) return;
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`invalid URL ${JSON.stringify(url)}`);
	}
	if (parsed.protocol === "data:" || parsed.protocol === "about:") return;
	if (allowedHosts.includes("*") || allowedHosts.includes(parsed.hostname)) return;
	throw new Error(`host "${parsed.hostname}" is not allowed; configure allowedHosts to permit it (allowed: ${allowedHosts.join(", ")})`);
}

/** Owns one browser and an ordered list of tabs for the plugin instance. */
class BrowserSession {
	constructor(config) {
		this.config = config;
		this.browser = null;
		this.pages = [];
		this.activeIndex = -1;
		this.pageConsole = new Map();
	}

	/** The active live page, re-launching the browser after a crash or close. */
	async ensurePage() {
		if (this.activeIndex >= 0 && this.activeIndex < this.pages.length) {
			const page = this.pages[this.activeIndex];
			if (!page.isClosed()) return page;
			this.pages.splice(this.activeIndex, 1);
			this.activeIndex = Math.max(0, this.activeIndex - 1);
		}
		if (this.browser === null || !this.browser.isConnected()) {
			this.browser = await this.launchBrowser();
			this.pages = [];
			this.activeIndex = -1;
			this.pageConsole = new Map();
		}
		return this.openTab();
	}

	/** Open a new tab (about:blank unless `url` given), making it active. */
	async openTab(url) {
		const page = await this.browser.newPage({
			viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight }
		});
		page.setDefaultTimeout(this.config.actionTimeoutMs);
		page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
		const messages = [];
		this.pageConsole.set(page, messages);
		page.on("console", (message) => {
			messages.push(`[${message.type()}] ${message.text()}`);
			if (messages.length > DEFAULT_CONSOLE_MAX_MESSAGES) messages.shift();
		});
		this.pages.push(page);
		this.activeIndex = this.pages.length - 1;
		if (url !== void 0) {
			try {
				await page.goto(url, { waitUntil: "domcontentloaded" });
			} catch { /* navigation failures surface on the tool call */ }
		}
		return page;
	}

	/** Make the tab at `index` active and return it. */
	async switchTab(index) {
		if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) {
			throw new Error(`no tab at index ${index} (open tabs: ${this.pages.length})`);
		}
		if (this.pages[index].isClosed()) throw new Error(`tab ${index} is closed`);
		this.activeIndex = index;
		return this.pages[index];
	}

	/** Close the active tab and activate a neighbor. */
	async closeTab() {
		if (this.pages.length === 0) return;
		const page = this.pages[this.activeIndex];
		try {
			await page.close();
		} catch { /* already closed */ }
		this.pageConsole.delete(page);
		this.pages.splice(this.activeIndex, 1);
		if (this.pages.length === 0) this.activeIndex = -1;
		else this.activeIndex = Math.min(this.activeIndex, this.pages.length - 1);
	}

	/** A stable snapshot of every tab (index, active flag, url). */
	tabs() {
		return this.pages.map((page, index) => ({
			index,
			active: index === this.activeIndex,
			url: page.url()
		}));
	}

	/** Launch the configured channel (bounded), falling back to bundled Chromium. */
	async launchBrowser() {
		const attempts = [{ channel: this.config.channel, label: this.config.channel }, { label: "bundled chromium" }];
		let lastError;
		for (const attempt of attempts) {
			try {
				return await withTimeout(chromium.launch({
					...(attempt.channel !== void 0 ? { channel: attempt.channel } : {}),
					headless: this.config.headless
				}), LAUNCH_TIMEOUT_MS, `launch ${attempt.label}`);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
	}

	async close() {
		if (this.browser !== null) {
			try {
				await this.browser.close();
			} catch { /* already closed */ }
			this.browser = null;
			this.pages = [];
			this.activeIndex = -1;
			this.pageConsole = new Map();
		}
	}
}

/** Canonical `{ text }` output contract shared by every browser tool. */
function textOutput() {
	return {
		schema: {
			type: "object",
			additionalProperties: false,
			properties: { text: { type: "string", required: true } }
		},
		render: (_args, value) => [{ type: "text", text: value.text }]
	};
}

/** Trim a string to a char budget with a truncation note. */
function trimTo(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…(truncated)`;
}

function applyTools(ctx, session, caps) {
	ctx.tools.register(defineTool({
		name: "browser_navigate",
		description: "Navigate the browser page to a URL (http/https). Returns the final URL and page title.",
		parameters: {
			url: { type: "string", required: true, description: "The URL to navigate to." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_navigate", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_navigate");
			checkAllowedHost(args.url, caps.allowedHosts);
			await withAbort(page.goto(args.url, { waitUntil: "domcontentloaded" }), exec.signal, "browser_navigate");
			const title = await withAbort(page.title(), exec.signal, "browser_navigate");
			return { text: `Navigated to ${page.url()}\nTitle: ${title}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_back",
		description: "Navigate the browser back to the previous page. Returns the resulting URL or states there was no history.",
		parameters: {},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_back", async (_args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_back");
			const wentBack = await withAbort(page.goBack(), exec.signal, "browser_back");
			if (wentBack === null) return { text: "No previous page in history." };
			return { text: `Navigated back to ${page.url()}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_click",
		description: "Click an element on the page using a CSS selector (e.g. \"button#submit\", \"a.nav-link\").",
		parameters: {
			target: { type: "string", required: true, description: "CSS selector of the element to click." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_click", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_click");
			await withAbort(page.locator(args.target).click(), exec.signal, "browser_click");
			return { text: `Clicked ${args.target}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_type",
		description: "Fill an input/textarea element with text using a CSS selector.",
		parameters: {
			target: { type: "string", required: true, description: "CSS selector of the input element." },
			text: { type: "string", required: true, description: "Text to fill in." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_type", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_type");
			await withAbort(page.locator(args.target).fill(args.text), exec.signal, "browser_type");
			return { text: `Filled ${args.target} with ${JSON.stringify(args.text)}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_press_key",
		description: "Press a keyboard key on the focused page (e.g. \"Enter\", \"Escape\", \"Tab\").",
		parameters: {
			key: { type: "string", required: true, description: "Key name to press (Playwright keyboard key)." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_press_key", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_press_key");
			await withAbort(page.keyboard.press(args.key), exec.signal, "browser_press_key");
			return { text: `Pressed ${args.key}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_snapshot",
		description: "Return the page's visible text content (the body innerText) so the model can read what is on screen. Use after navigate or before deciding the next action.",
		parameters: {},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_snapshot", async (_args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_snapshot");
			const text = await withAbort(page.locator("body").innerText(), exec.signal, "browser_snapshot");
			const url = page.url();
			const body = trimTo(text, caps.snapshotMaxChars);
			return { text: `URL: ${url}\n\n${body}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_take_screenshot",
		description: "Save a screenshot of the current page as a PNG under the configured output directory and return the file path.",
		parameters: {
			fullPage: { type: "boolean", description: "Capture the full scrollable page instead of the visible viewport." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_take_screenshot", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_take_screenshot");
			const file = join(caps.outputDir, `shot-${Date.now()}.png`);
			await withAbort(page.screenshot({ path: file, fullPage: args.fullPage === true }), exec.signal, "browser_take_screenshot");
			return { text: `Screenshot saved: ${file}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_evaluate",
		description: "Evaluate a JavaScript expression in the page and return the JSON-serialized result (e.g. \"document.title\", \"document.querySelectorAll('a').length\").",
		parameters: {
			script: { type: "string", required: true, description: "JavaScript expression to evaluate in the page." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_evaluate", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_evaluate");
			const value = await withAbort(page.evaluate(args.script), exec.signal, "browser_evaluate");
			let serialized;
			try {
				serialized = JSON.stringify(value);
			} catch {
				serialized = String(value);
			}
			return { text: trimTo(serialized ?? "undefined", caps.evaluateMaxChars) };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_console_messages",
		description: "Return recent browser console messages (log/warn/error) collected since the page was created, newest last.",
		parameters: {},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_console_messages", async (_args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_console_messages");
			const messages = session.pageConsole.get(page) ?? [];
			if (messages.length === 0) return { text: "(no console messages captured)" };
			return { text: messages.join("\n") };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_wait_for",
		description: "Wait for a fixed time in milliseconds (useful before reading a page that loads dynamically).",
		parameters: {
			time: { type: "integer", required: true, description: "Milliseconds to wait (max 30000)." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_wait_for", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_wait_for");
			const time = Math.min(Math.max(Number(args.time) || 0, 0), 30000);
			await withAbort(page.waitForTimeout(time), exec.signal, "browser_wait_for");
			return { text: `Waited ${time}ms` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_fill_form",
		description: "Fill multiple form fields at once. Each field needs a CSS selector target and a string value.",
		parameters: {
			fields: {
				type: "array",
				required: true,
				description: "Fields to fill, in order.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						target: { type: "string", required: true, description: "CSS selector of the input element." },
						value: { type: "string", required: true, description: "Text to fill in." }
					}
				}
			}
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_fill_form", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_fill_form");
			if (!Array.isArray(args.fields) || args.fields.length === 0) throw new Error("fields must be a non-empty array");
			for (const field of args.fields) {
				if (typeof field?.target !== "string" || typeof field?.value !== "string") {
					throw new Error("each field needs a string target and a string value");
				}
				await withAbort(page.locator(field.target).fill(field.value), exec.signal, "browser_fill_form");
			}
			return { text: `Filled ${args.fields.length} fields` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_select_option",
		description: "Select one or more options in a <select> dropdown using a CSS selector.",
		parameters: {
			target: { type: "string", required: true, description: "CSS selector of the <select> element." },
			values: { type: "array", required: true, items: { type: "string" }, description: "Option values to select." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_select_option", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_select_option");
			await withAbort(page.selectOption(args.target, args.values), exec.signal, "browser_select_option");
			return { text: `Selected ${args.values.join(", ")} in ${args.target}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_hover",
		description: "Hover over an element on the page using a CSS selector.",
		parameters: {
			target: { type: "string", required: true, description: "CSS selector of the element to hover." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_hover", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_hover");
			await withAbort(page.locator(args.target).hover(), exec.signal, "browser_hover");
			return { text: `Hovered ${args.target}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_drag",
		description: "Perform a drag and drop between two elements using CSS selectors.",
		parameters: {
			startTarget: { type: "string", required: true, description: "CSS selector of the draggable source element." },
			endTarget: { type: "string", required: true, description: "CSS selector of the drop target element." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_drag", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_drag");
			await withAbort(page.dragAndDrop(args.startTarget, args.endTarget), exec.signal, "browser_drag");
			return { text: `Dragged ${args.startTarget} to ${args.endTarget}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_resize",
		description: "Resize the browser viewport to a width and height in pixels.",
		parameters: {
			width: { type: "integer", required: true, description: "Viewport width in pixels." },
			height: { type: "integer", required: true, description: "Viewport height in pixels." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_resize", async (args, exec) => {
			const page = await withAbort(session.ensurePage(), exec.signal, "browser_resize");
			const width = Number(args.width);
			const height = Number(args.height);
			if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
				throw new Error("width and height must be positive integers");
			}
			await withAbort(page.setViewportSize({ width, height }), exec.signal, "browser_resize");
			return { text: `Resized viewport to ${width}x${height}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_open_tab",
		description: "Open a new browser tab (about:blank, or navigate to a URL when given) and switch to it.",
		parameters: {
			url: { type: "string", description: "Optional URL to open in the new tab." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_open_tab", async (args, exec) => {
			if (args.url !== void 0 && args.url.length > 0) checkAllowedHost(args.url, caps.allowedHosts);
			const page = await withAbort(session.openTab(args.url !== void 0 && args.url.length > 0 ? args.url : void 0), exec.signal, "browser_open_tab");
			return { text: `Opened tab ${session.activeIndex}: ${page.url()}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_tabs",
		description: "List all open browser tabs with their index, active flag, and URL.",
		parameters: {},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_tabs", async (_args, exec) => {
			await withAbort(session.ensurePage(), exec.signal, "browser_tabs");
			const tabs = session.tabs();
			if (tabs.length === 0) return { text: "(no tabs open)" };
			return { text: tabs.map((tab) => `${tab.index}${tab.active ? " (active)" : ""}: ${tab.url}`).join("\n") };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_switch_tab",
		description: "Switch to an open browser tab by its index (see browser_tabs).",
		parameters: {
			index: { type: "integer", required: true, description: "Tab index to switch to." }
		},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_switch_tab", async (args, exec) => {
			const page = await withAbort(session.switchTab(Number(args.index)), exec.signal, "browser_switch_tab");
			return { text: `Switched to tab ${args.index}: ${page.url()}` };
		})
	}));

	ctx.tools.register(defineTool({
		name: "browser_close_tab",
		description: "Close the active browser tab and activate a neighbor.",
		parameters: {},
		timeoutMs: caps.timeoutMs,
		output: textOutput(),
		execute: tool("browser_close_tab", async (_args, exec) => {
			const before = session.tabs().length;
			await withAbort(session.closeTab(), exec.signal, "browser_close_tab");
			const after = session.tabs().length;
			return { text: `Closed active tab (${before} → ${after} tabs)` };
		})
	}));
}

async function apply(ctx, config) {
	const caps = {
		headless: config.headless ?? true,
		channel: config.channel ?? "msedge",
		outputDir: config.outputDir ?? join(tmpdir(), "dsh-tool-browser"),
		allowedHosts: Array.isArray(config.allowedHosts) ? config.allowedHosts : [],
		timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		navigationTimeoutMs: config.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
		actionTimeoutMs: config.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
		snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
		evaluateMaxChars: config.evaluateMaxChars ?? DEFAULT_EVALUATE_MAX_CHARS,
		viewportWidth: config.viewportWidth ?? 1280,
		viewportHeight: config.viewportHeight ?? 720
	};
	assertPositiveInteger("timeoutMs", caps.timeoutMs);
	assertPositiveInteger("navigationTimeoutMs", caps.navigationTimeoutMs);
	assertPositiveInteger("actionTimeoutMs", caps.actionTimeoutMs);
	assertPositiveInteger("snapshotMaxChars", caps.snapshotMaxChars);
	assertPositiveInteger("evaluateMaxChars", caps.evaluateMaxChars);
	assertPositiveInteger("viewportWidth", caps.viewportWidth);
	assertPositiveInteger("viewportHeight", caps.viewportHeight);
	mkdirSync(caps.outputDir, { recursive: true });

	const session = new BrowserSession(caps);
	ctx.effect(function* () {
		yield async () => {
			await session.close();
		};
	}, "dsh-tool-browser browser");

	applyTools(ctx, session, caps);

	ctx.systemPrompt.section({
		name: "tool:browser",
		order: 160,
		text: "Use the browser tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_evaluate, browser_take_screenshot, browser_tabs) to inspect and interact with web pages. After navigating, read browser_snapshot before deciding the next action. Prefer browser tools over scraping via shell when a page is involved."
	});
}

export { BrowserSession, Config, apply, inject, name };
