import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createToastStore } from "./toast.ts";

describe("Toast System", () => {
  it("initializes empty and allows adding toasts", () => {
    const store = createToastStore();
    assert.strictEqual(store.getToasts().length, 0);

    const id = store.info("Test message");
    assert.strictEqual(typeof id, "string");
    assert.strictEqual(store.getToasts().length, 1);
    assert.strictEqual(store.getToasts()[0].message, "Test message");
    assert.strictEqual(store.getToasts()[0].type, "info");
  });

  it("stacks multiple rapid toasts without clobbering earlier messages", () => {
    const store = createToastStore();

    store.success("Stream #1 created.");
    store.info("Discovered 3 stream(s) on-chain.");
    store.error("Transaction rejected by wallet.");

    const current = store.getToasts();
    assert.strictEqual(current.length, 3);
    assert.strictEqual(current[0].type, "success");
    assert.strictEqual(current[0].message, "Stream #1 created.");
    assert.strictEqual(current[1].type, "info");
    assert.strictEqual(current[1].message, "Discovered 3 stream(s) on-chain.");
    assert.strictEqual(current[2].type, "error");
    assert.strictEqual(current[2].message, "Transaction rejected by wallet.");
  });

  it("removes a specific toast by id", () => {
    const store = createToastStore();

    const id1 = store.success("First");
    const id2 = store.error("Second");
    const id3 = store.info("Third");

    assert.strictEqual(store.getToasts().length, 3);

    store.removeToast(id2);
    const remaining = store.getToasts();
    assert.strictEqual(remaining.length, 2);
    assert.strictEqual(remaining.find((t) => t.id === id2), undefined);
    assert.strictEqual(remaining[0].id, id1);
    assert.strictEqual(remaining[1].id, id3);
  });

  it("clears all toasts", () => {
    const store = createToastStore();
    store.success("One");
    store.error("Two");
    assert.strictEqual(store.getToasts().length, 2);

    store.clear();
    assert.strictEqual(store.getToasts().length, 0);
  });

  it("notifies subscribers when toasts are added or removed", () => {
    const store = createToastStore();
    let updatesCount = 0;
    let lastLength = 0;

    const unsubscribe = store.subscribe((toasts) => {
      updatesCount++;
      lastLength = toasts.length;
    });

    const id = store.success("New alert");
    assert.strictEqual(updatesCount, 1);
    assert.strictEqual(lastLength, 1);

    store.removeToast(id);
    assert.strictEqual(updatesCount, 2);
    assert.strictEqual(lastLength, 0);

    unsubscribe();
    store.info("After unsubscribe");
    assert.strictEqual(updatesCount, 2);
  });

  it("sets default durations for variants", () => {
    const store = createToastStore();
    store.success("Success msg");
    store.error("Error msg");

    const toasts = store.getToasts();
    assert.strictEqual(toasts[0].duration, 5000);
    assert.strictEqual(toasts[1].duration, 6000);
  });
});
