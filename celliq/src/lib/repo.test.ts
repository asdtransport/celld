import { beforeEach, expect, test } from "bun:test";
import { freshDb } from "../test/setup";
import * as repo from "./repo";

beforeEach(() => freshDb());

test("create + list", () => {
  const it = repo.createItem({ name: "alpha", note: "n" });
  expect(it.id).toBeTruthy();
  expect(repo.listItems()).toHaveLength(1);
});

test("update + get + delete", () => {
  const it = repo.createItem({ name: "alpha" });
  repo.updateItem(it.id, { name: "beta" });
  expect(repo.getItem(it.id)?.name).toBe("beta");
  repo.deleteItem(it.id);
  expect(repo.listItems()).toHaveLength(0);
});
