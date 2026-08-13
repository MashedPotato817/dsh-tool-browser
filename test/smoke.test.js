import test from "node:test";
import assert from "node:assert/strict";
import { apply, name, inject, Config } from "../lib/index.js";

function makeCtx() {
	const registered = { tools: [], sections: [] };
	const ctx = {
		tools: { register: (definition) => registered.tools.push(definition) },
		systemPrompt: { section: (section) => registered.sections.push(section) },
		effect: () => {}
	};
	return { ctx, registered };
}

test("exports the Cordis plugin surface", () => {
	assert.equal(typeof name, "string");
	assert.ok(name.length > 0);
	assert.deepEqual(inject, ["tools", "systemPrompt"]);
	assert.equal(typeof Config, "function");
	assert.equal(typeof apply, "function");
});

test("apply registers 10 browser tools and one system-prompt section", async () => {
	const { ctx, registered } = makeCtx();
	await apply(ctx, { outputDir: "output" });

	assert.equal(registered.tools.length, 10);
	assert.deepEqual(
		registered.tools.map((tool) => tool.name).sort(),
		[
			"browser_back",
			"browser_click",
			"browser_console_messages",
			"browser_evaluate",
			"browser_navigate",
			"browser_press_key",
			"browser_snapshot",
			"browser_take_screenshot",
			"browser_type",
			"browser_wait_for"
		]
	);
	for (const tool of registered.tools) {
		assert.equal(typeof tool.execute, "function");
		assert.ok(Array.isArray(tool.output.render({}, { text: "" })));
	}

	assert.equal(registered.sections.length, 1);
	assert.equal(registered.sections[0].name, "tool:browser");
});
