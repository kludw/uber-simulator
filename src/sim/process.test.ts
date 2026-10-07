import { afterEach, expect, spyOn, test } from "bun:test";
import { log } from "./process.ts";

const consoleLog = spyOn(console, "log").mockImplementation(() => {});

afterEach(() => consoleLog.mockClear());

// A rejected drivers.* chunk holds up to 5,000 entries per array (ADR 0049).
test("log writes an array of more than 100 entries as its length", () => {
	log("dispatch-0", {
		type: "input_rejected",
		input: { xs: Array.from({ length: 101 }, () => 0), ys: [1, 2] },
	});

	expect(consoleLog.mock.calls).toEqual([
		[
			'{"service":"dispatch-0","type":"input_rejected","input":{"xs":{"length":101},"ys":[1,2]}}',
		],
	]);
});
