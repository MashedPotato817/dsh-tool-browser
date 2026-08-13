import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { apply, BrowserSession } from "../lib/index.js";

/** Probe which browser channel works: the installed Edge first, then bundled Chromium (CI). */
async function resolveChannel() {
	for (const channel of ["msedge", undefined]) {
		let browser;
		try {
			browser = await chromium.launch({ ...(channel !== void 0 ? { channel } : {}), headless: true });
			await browser.close();
			return channel;
		} catch { /* try next */ }
	}
	return void 0;
}

const CHANNEL = await resolveChannel();
const SKIP = CHANNEL === void 0 ? "no browser available (tried msedge and bundled chromium)" : false;

/** Run the plugin's registered effect disposers so browsers close after a test. */
async function disposeEffects(effects) {
	for (const generator of effects) {
		const iterator = generator();
		const first = iterator.next();
		if (!first.done && typeof first.value === "function") {
			await first.value();
		}
	}
}

async function mount(channel, overrides = {}) {
	const tools = [];
	const effects = [];
	const ctx = {
		tools: { register: (definition) => tools.push(definition) },
		systemPrompt: { section: () => {} },
		effect: (generator) => effects.push(generator)
	};
	await apply(ctx, { channel, headless: true, outputDir: OUTPUT_DIR, actionTimeoutMs: 2000, ...overrides });
	return {
		tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
		dispose: () => disposeEffects(effects)
	};
}

const OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-browser-out-"));
const signal = new AbortController().signal;
const exec = { signal };

function dataUrl(html) {
	return `data:text/html,${encodeURIComponent(html)}`;
}

test("browser tools navigate, snapshot, evaluate and screenshot (real browser)", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		const { browser_navigate, browser_snapshot, browser_evaluate, browser_take_screenshot } = mounted.tools;

		const html = `<html><head><title>Test Page</title></head><body><h1 id="h">Hello Browser</h1><input id="in"><p class="note">some text</p></body></html>`;

		const nav = await browser_navigate.execute({ url: dataUrl(html) }, exec);
		assert.match(nav.text, /Navigated to/);

		const snap = await browser_snapshot.execute({}, exec);
		assert.match(snap.text, /Hello Browser/);
		assert.match(snap.text, /some text/);

		const evaluated = await browser_evaluate.execute({ script: "document.title" }, exec);
		assert.match(evaluated.text, /Test Page/);

		const shot = await browser_take_screenshot.execute({}, exec);
		assert.match(shot.text, /Screenshot saved/);
		const file = shot.text.split(": ")[1].trim();
		assert.ok(fs.existsSync(file), `screenshot file should exist: ${file}`);
		assert.ok(fs.statSync(file).size > 500, "screenshot should not be empty");
	} finally {
		await mounted.dispose();
	}
});

test("browser_click and browser_type interact with the page (real browser)", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		const { browser_navigate, browser_type, browser_click, browser_snapshot } = mounted.tools;

		const html = `<html><body><input id="in"><button id="btn" onclick="document.getElementById('out').textContent='clicked'">Go</button><div id="out"></div></body></html>`;

		await browser_navigate.execute({ url: dataUrl(html) }, exec);
		await browser_type.execute({ target: "#in", text: "hello" }, exec);
		await browser_click.execute({ target: "#btn" }, exec);
		const snap = await browser_snapshot.execute({}, exec);
		assert.match(snap.text, /clicked/);
	} finally {
		await mounted.dispose();
	}
});

test("browser_back reports when there is no history (real browser)", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		const { browser_navigate, browser_back } = mounted.tools;
		await browser_navigate.execute({ url: dataUrl("<html><body>only</body></html>") }, exec);
		const back = await browser_back.execute({}, exec);
		assert.match(back.text, /No previous page/);
	} finally {
		await mounted.dispose();
	}
});

test("BrowserSession re-launches the browser after a crash", { skip: SKIP }, async () => {
	const session = new BrowserSession({ channel: CHANNEL, headless: true, viewportWidth: 800, viewportHeight: 600 });
	try {
		const page = await session.ensurePage();
		assert.ok(!page.isClosed());
		await session.browser.close(); // simulate a browser crash
		const page2 = await session.ensurePage();
		assert.ok(!page2.isClosed());
		assert.notEqual(page2, page);
	} finally {
		await session.close();
	}
});

test("browser_navigate rejects an invalid URL", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		await assert.rejects(
			() => mounted.tools.browser_navigate.execute({ url: "not a url" }, exec),
			/browser_navigate failed/
		);
	} finally {
		await mounted.dispose();
	}
});

test("browser_click reports a missing element", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		await mounted.tools.browser_navigate.execute({ url: dataUrl("<html><body>x</body></html>") }, exec);
		await assert.rejects(
			() => mounted.tools.browser_click.execute({ target: "#nope" }, exec),
			/browser_click failed/
		);
	} finally {
		await mounted.dispose();
	}
});

test("browser_navigate enforces allowedHosts", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL, { allowedHosts: ["example.com"] });
	try {
		await assert.rejects(
			() => mounted.tools.browser_navigate.execute({ url: "https://other-site.test/" }, exec),
			/not allowed/
		);
	} finally {
		await mounted.dispose();
	}
});

test("browser_evaluate surfaces script errors", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		await mounted.tools.browser_navigate.execute({ url: dataUrl("<html><body>x</body></html>") }, exec);
		await assert.rejects(
			() => mounted.tools.browser_evaluate.execute({ script: "throw new Error('boom')" }, exec),
			/browser_evaluate failed/
		);
	} finally {
		await mounted.dispose();
	}
});

test("extended tools: fill_form, select_option, hover, resize (real browser)", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		const { browser_navigate, browser_fill_form, browser_select_option, browser_hover, browser_resize, browser_evaluate } = mounted.tools;

		const html = `<html><body>
			<input id="a"><input id="b">
			<select id="sel"><option value="1">One</option><option value="2">Two</option></select>
			<div id="hov">hover me</div>
		</body></html>`;

		await browser_navigate.execute({ url: dataUrl(html) }, exec);
		await browser_fill_form.execute({ fields: [{ target: "#a", value: "x" }, { target: "#b", value: "y" }] }, exec);
		const values = await browser_evaluate.execute({ script: "[document.getElementById('a').value, document.getElementById('b').value]" }, exec);
		assert.match(values.text, /\["x","y"\]/);

		await browser_select_option.execute({ target: "#sel", values: ["2"] }, exec);
		const selected = await browser_evaluate.execute({ script: "document.getElementById('sel').value" }, exec);
		assert.match(selected.text, /2/);

		await browser_hover.execute({ target: "#hov" }, exec);
		await browser_resize.execute({ width: 900, height: 600 }, exec);
		const innerWidth = await browser_evaluate.execute({ script: "window.innerWidth" }, exec);
		assert.match(innerWidth.text, /900/);
	} finally {
		await mounted.dispose();
	}
});

test("tab management: open, list, switch, close (real browser)", { skip: SKIP }, async () => {
	const mounted = await mount(CHANNEL);
	try {
		const { browser_navigate, browser_open_tab, browser_tabs, browser_switch_tab, browser_close_tab, browser_snapshot } = mounted.tools;

		await browser_navigate.execute({ url: dataUrl("<html><body>tab0</body></html>") }, exec);
		await browser_open_tab.execute({ url: dataUrl("<html><body>tab1</body></html>") }, exec);

		const tabs = await browser_tabs.execute({}, exec);
		assert.equal(tabs.text.split("\n").length, 2);
		assert.match(tabs.text, /\(active\)/);

		await browser_switch_tab.execute({ index: 0 }, exec);
		const snap0 = await browser_snapshot.execute({}, exec);
		assert.match(snap0.text, /tab0/);

		await browser_close_tab.execute({}, exec);
		const snap1 = await browser_snapshot.execute({}, exec);
		assert.match(snap1.text, /tab1/);
	} finally {
		await mounted.dispose();
	}
});
