import { expect, test } from "bun:test";
import { adminState } from "../src/admin-state";
import type { Member } from "../src/types";

const member = (userId: string, role: Member["role"]): Member => ({ userId, name: userId, email: `${userId}@x.test`, role });

test("the viewer is loading until the members list arrives", () => {
  expect(adminState(null, "u1")).toBe("loading");
});

test("an Admin is admin, a Member or Guest or unknown viewer is other", () => {
  expect(adminState([member("u1", "Admin")], "u1")).toBe("admin");
  expect(adminState([member("u1", "Member")], "u1")).toBe("other");
  expect(adminState([member("u1", "Guest")], "u1")).toBe("other");
  expect(adminState([member("u2", "Admin")], "u1")).toBe("other");
});
