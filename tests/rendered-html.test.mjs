import assert from "node:assert/strict";
import test from "node:test";

test("renders the app shell and catalog delete entry", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>Schema Atlas · 表关系探索器<\/title>/);
  assert.match(html, /aria-label="删除 PE_PLAN_POLICY"/);
  assert.match(html, />变更记录</);
  assert.match(html, />导出标注</);
  assert.match(html, /我依赖谁 · 子表/);
  assert.match(html, /字段缺口/);
});
