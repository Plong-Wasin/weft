import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WikiSidebar } from "../src/shell/wiki-sidebar";
import type { Workspace } from "../src/types";

const workspace = { id: "w1", slug: "team", name: "Team" } as Workspace;
const page = (id: string, canEdit: boolean) => ({ id, title: id, parentId: null, collectionId: "c1", projectId: null, access: "public", ownerId: "u1", archived: false, canEdit, canMoveAcrossCollections: false });

test("only people who can edit a Wiki page see its reorder handle; read-only pages keep their drop row", () => {
  const client = new QueryClient();
  client.setQueryData(["wiki-pages", "w1", "sidebar"], [page("editable", true), page("readonly", false)]);
  client.setQueryData(["wiki-pages", "w1", "shared"], []);
  client.setQueryData(["wiki-collections", "w1"], [{ id: "c1", name: "General", icon: "folder", visibility: "public", isDefault: true }]);
  const html = renderToString(<QueryClientProvider client={client}><MemoryRouter><WikiSidebar workspace={workspace} selfId="u1" /></MemoryRouter></QueryClientProvider>);
  expect(html).toContain('data-wiki-drag-handle="editable"');
  expect(html).not.toContain('data-wiki-drag-handle="readonly"');
  expect(html).toContain('data-wiki-drop-id="page:readonly"');
});
