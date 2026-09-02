import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../../web/src/skill-block.js";

const BODY = `---
name: demo
---
skill body first line
second line`;

describe("parseSkillBlock", () => {
	it("parses a standard <skill> block (mirrors the SDK regex; do not change independently)", () => {
		const text =
			`<skill name="demo" location="/tmp/demo/SKILL.md">\n${BODY}\n</skill>\n\nhelp me do X`;
		const b = parseSkillBlock(text);
		expect(b).not.toBeNull();
		expect(b!.name).toBe("demo");
		expect(b!.location).toBe("/tmp/demo/SKILL.md");
		expect(b!.content).toBe(BODY);
		expect(b!.userMessage).toBe("help me do X");
	});

	it("userMessage is undefined when absent", () => {
		const text = `<skill name="a" location="/l">\nbody\n</skill>`;
		const b = parseSkillBlock(text);
		expect(b!.userMessage).toBeUndefined();
	});

	it("non-skill text returns null", () => {
		expect(parseSkillBlock("ordinary message")).toBeNull();
	});
});
