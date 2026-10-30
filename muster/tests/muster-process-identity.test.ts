import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createMusterProcessKey } from "../recovery.ts";

test("healthy OS identity keeps the existing process-key format", () => {
	assert.equal(
		createMusterProcessKey(101, "boot", 123, "incarnation-a"),
		"pi-101-boot-123",
	);
});

for (const [boot, ticks] of [
	[undefined, 123],
	["boot", undefined],
	[undefined, undefined],
] as const) {
	test(`missing OS identity (${boot}, ${ticks}) cannot collapse two incarnations onto placeholders`, () => {
		const first = createMusterProcessKey(101, boot, ticks, "incarnation-a");
		const second = createMusterProcessKey(101, boot, ticks, "incarnation-b");
		assert.notEqual(first, second);
		assert.equal(
			first,
			createMusterProcessKey(101, boot, ticks, "incarnation-a"),
		);
	});
}

test("missing OS identity requires a nonempty literal incarnation marker", () => {
	assert.throws(() => createMusterProcessKey(101, "boot", undefined, ""));
	assert.throws(() =>
		createMusterProcessKey(101, "boot", undefined, " padded "),
	);
});
