import { describe, expect, test } from "bun:test";
import {
	isHtmlResponse,
	readLimitedResponseText,
} from "../../apps/extension/src/lib/moodle/limitedResponse";

describe("Moodle HTML応答の上限制御", () => {
	test("Content-Lengthが上限を超える応答を本文読込前に拒否する", async () => {
		const response = new Response("small", {
			headers: { "content-length": "100", "content-type": "text/html; charset=utf-8" },
		});

		expect(await readLimitedResponseText(response, 10)).toBeNull();
		expect(isHtmlResponse(response)).toBe(true);
	});

	test("Content-Lengthがなくてもストリーム実測値で上限を守る", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("1234"));
					controller.enqueue(new TextEncoder().encode("5678"));
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/html" } },
		);

		expect(await readLimitedResponseText(response, 6)).toBeNull();
	});

	test("上限内の原文を保持し、HTML以外を区別する", async () => {
		const response = new Response("<p>Ｐｙｔｈｏｎ</p>", {
			headers: { "content-type": "application/xhtml+xml" },
		});

		expect(await readLimitedResponseText(response, 100)).toBe("<p>Ｐｙｔｈｏｎ</p>");
		expect(isHtmlResponse(response)).toBe(true);
		expect(
			isHtmlResponse(new Response("{}", { headers: { "content-type": "application/json" } })),
		).toBe(false);
	});
});
