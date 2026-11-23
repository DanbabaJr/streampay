import { test } from "node:test";

test("deliberately slow SDK conformance fixture", async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
});
