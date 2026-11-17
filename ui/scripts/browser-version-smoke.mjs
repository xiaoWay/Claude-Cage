import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

let report = {
  target: "browser", checked_at: new Date().toISOString(),
  browser: { browser_product: "Chrome/156.0.8078.79", javascript_version: "15.6.276.8", user_agent: "Chrome/156.0.0.0", webgl: { renderer: "" }, screen: { width: 1280, height: 900, pixel_ratio: 1 }, viewport: { width: 1280, height: 900 } },
  checks: [{ id: "browser-version", title: "页面 UA 与浏览器进程版本", state: "passed", evidence: "页面 UA 与实际进程主版本一致，不使用启发式版本推断替代实际读回。" }],
};
const { page, browser, errors } = await createWorkbench({ beforeNavigate: async (page, state) => {
  state.status.ready = state.status.vm_running = true;
  await page.route("**/api/environment/device-check", route => route.fulfill({ json: report }));
} });
try {
  await page.getByTitle("网络与隔离检查", { exact: true }).click();
  await page.getByRole("region", { name: "环境评估", exact: true }).locator("details > summary").first().click();
  const checks = page.getByRole("region", { name: "设备配置与渲染检测", exact: true });
  await checks.getByRole("button", { name: "检测浏览器", exact: true }).click();
  await checks.getByText("页面 UA 与浏览器进程版本", { exact: true }).waitFor();
  await checks.locator("summary").click();
  await checks.getByText("Chrome/156.0.8078.79", { exact: true }).waitFor();
  await checks.getByText("15.6.276.8", { exact: true }).waitFor();
  await checks.getByText("Chrome/156.0.0.0", { exact: true }).waitFor();
  await checks.getByText(/不能代替实际进程版本/).waitFor();
  if (process.env.CAGE_BROWSER_VERSION_EVIDENCE) await page.screenshot({ path: process.env.CAGE_BROWSER_VERSION_EVIDENCE, fullPage: true });
  report = { ...report, browser: { ...report.browser, browser_product: undefined, javascript_version: undefined }, checks: [{ ...report.checks[0], state: "unknown", evidence: "未取得进程版本，请更新环境组件后重测。" }] };
  await checks.getByRole("button", { name: "检测浏览器", exact: true }).click();
  await checks.getByText("未取得进程版本，请更新环境组件后重测。", { exact: true }).waitFor();
  await checks.locator("summary").click();
  await checks.getByText("未观测，当前组件或窗口模式未提供", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS native browser/V8 version display, reduced UA, heuristic limits and older-component fallback");
} finally { await browser.close(); }
