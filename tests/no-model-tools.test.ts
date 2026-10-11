import { expect, test } from "vitest";
import manifest from "../plugin.json";
import { activate } from "../src/index";

test("keeps review contributions without exposing Git tools to the model", async () => {
  expect(manifest.tools).toEqual([]);
  expect(manifest.extensions).toEqual(["panel"]);
  const contribution = await activate({ storagePath: "unused", signal: new AbortController().signal } as Parameters<typeof activate>[0]);
  expect(contribution?.tools ?? []).toEqual([]);
  expect(contribution?.runChanges).toBeDefined();
  expect(contribution?.ui?.map(item => item.slot)).toEqual(["panel"]);
});
