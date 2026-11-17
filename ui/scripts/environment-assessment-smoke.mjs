import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const stamp = () => new Date().toISOString();
const ids = ["egress_policy", "proxy_transport", "dns_transport", "guest_settings", "browser_settings", "filesystem_boundary", "management_boundary", "fail_closed", "udp_policy", "ipv6_policy", "exit_consistency"];
const calls = { device: 0, location: 0 };
const configuration = "fixture-configuration", run = "fixture-run";
let location = { ip: "192.0.2.10", country_code: "US", country: "United States", timezone: "America/Los_Angeles", checked_at: stamp(),
  evidence: { status: "conflict", country_status: "consistent", timezone_status: "conflict", checked_at: stamp(), sources: [
    { provider: "source-a", country_code: "US", timezone: "America/Los_Angeles" },
    { provider: "source-b", country_code: "US", timezone: "America/New_York" },
  ] } };
let device = { target: "browser", run_id: run, configuration, checked_at: stamp(), expected_timezone: "America/New_York", expected_language: "en-US",
  browser_timezone: "America/New_York", browser_language: "en-US", browser_platform: "Linux x86_64",
  browser: { browser_product: "Chrome/156.0.8078.79", javascript_version: "15.6.276.8", user_agent: "Chrome/156.0.0.0", webgl: { renderer: "fixture software renderer" }, screen: { width: 1280, height: 900, pixel_ratio: 1 }, viewport: { width: 1280, height: 900 } },
  checks: ["browser-version", "user-agent"].map(id => ({ id, title: id === "browser-version" ? "页面 UA 与浏览器进程版本" : "UA 与 Client Hints", state: "passed", evidence: "isolated browser fixture" })),
};
const fixture = await createWorkbench({ beforeNavigate: async (page, state) => {
  Object.assign(state.settings, { timezone: "America/New_York", locale: "en_US.UTF-8", browser_language: "en-US", auto_timezone: true, auto_language: false });
  state.status.vm_running = state.status.ready = true;
  state.status.guest_system = "debian-13";
  state.status.location = location;
  state.status.safety = {
    exit_ip: location.ip,
    report: { id: "fixture-report", check_id: "fixture-check", run_id: run, configuration, policy: "cage-safety/3", created_at: stamp(), checks: ids.map(id => ({ id, title: id, critical: true, state: "passed", evidence: "isolated current check", checked_at: stamp() })) },
    gate: { mode: "open", run_id: run, configuration, policy: "cage-safety/3", policy_verified: true, report: { id: "fixture-report" }, until: new Date(Date.now() + 600_000).toISOString() },
  };
  await page.route("**/api/environment/device-check", route => { calls.device++; return route.fulfill({ json: { ...device, checked_at: stamp() } }); });
  await page.route("**/api/settings/probe", route => { calls.location++; return route.fulfill({ json: location }); });
} });
const { page, browser, state, errors } = fixture;
page.setDefaultTimeout(12_000);
const output = process.env.CAGE_ASSESSMENT_SCREENSHOTS;
try {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: "时区与语言", exact: true }).click();
  const panel = page.getByRole("region", { name: "环境评估", exact: true });
  const summary = panel.locator("details > summary").first();
  await summary.getByText("已确认 80 / 100 分", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("heading", { name: "当前证据支持的配置建议", exact: true }).isVisible(), false);
  assert.deepEqual(calls, { device: 0, location: 0 });
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/collapsed.png` }); }
  await summary.click();
  await panel.getByText(/当前没有可自动确定的最佳时区/).waitFor();
  assert.equal(await panel.getByRole("button", { name: "将推荐填入草稿", exact: true }).isDisabled(), true);
  assert.deepEqual(calls, { device: 0, location: 0 }, "expansion must not trigger probes");
  await panel.getByRole("button", { name: "检测浏览器", exact: true }).click();
  await summary.getByText("已确认 95 / 100 分", { exact: true }).waitFor();
  device.checks[0].state = "failed";
  await panel.getByRole("button", { name: "检测浏览器", exact: true }).click();
  await summary.getByText("存在不一致", { exact: true }).waitFor();
  device.checks[0].state = "passed";
  device.browser_timezone = "America/Los_Angeles";
  await panel.getByRole("button", { name: "检测浏览器", exact: true }).click();
  await summary.getByText("关键检查未通过", { exact: true }).waitFor();
  device.browser_timezone = "America/New_York";
  await panel.getByRole("button", { name: "检测浏览器", exact: true }).click();
  await summary.getByText("已确认 95 / 100 分", { exact: true }).waitFor();

  const sampled = calls.device;
  await page.keyboard.press("Escape");
  await page.getByTitle("网络与隔离检查", { exact: true }).click();
  const shared = page.getByRole("region", { name: "环境评估", exact: true });
  await shared.locator("details > summary").first().getByText("已确认 95 / 100 分", { exact: true }).waitFor();
  await shared.locator("details > summary").first().click();
  await shared.getByRole("button", { name: "前往时区与语言配置", exact: true }).click();
  await summary.getByText("已确认 95 / 100 分", { exact: true }).waitFor();
  await summary.click();
  assert.equal(calls.device, sampled, "switching views must reuse the bound observation without probing again");

  location = { ...location, evidence: { ...location.evidence, status: "consistent", timezone_status: "consistent", sources: location.evidence.sources.map(source => ({ ...source, timezone: "America/Los_Angeles" })) } };
  await panel.getByRole("button", { name: "重新校验定位来源", exact: true }).click();
  await summary.getByText("存在不一致", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "将推荐填入草稿", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "系统时区", exact: true }).inputValue(), "America/Los_Angeles");
  assert.equal(state.settings.timezone, "America/New_York");
  assert.equal(state.saves.length, 0, "recommendation must not save or restart the environment");
  await panel.getByText(/存在未保存的配置草稿/).waitFor();
  await summary.getByText("已确认 95 / 100 分", { exact: true }).waitFor();
  if (output) {
    await page.locator(".settings-content").evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: `${output}/expanded.png` });
  }
  await page.getByRole("button", { name: "保存并重启", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "应用设置并重启环境？", exact: true });
  await confirm.waitFor();
  assert.equal(state.saves.length, 0, "saving must retain the existing confirmation");
  await confirm.getByRole("button", { name: "保存并重启", exact: true }).click();
  await page.getByRole("region", { name: "设置", exact: true }).waitFor({ state: "hidden" });
  assert.equal(state.settings.timezone, "America/Los_Angeles");
  assert.equal(state.settings.auto_timezone, false);

  // The same collapsed assessment is available in the network checklist.
  await page.getByTitle("网络与隔离检查", { exact: true }).click();
  const network = page.getByRole("dialog", { name: "网络与隔离检查", exact: true });
  const nested = network.getByRole("region", { name: "环境评估", exact: true });
  await nested.locator("details > summary").first().click();
  assert.equal(await nested.getByRole("button", { name: "将推荐填入草稿", exact: true }).count(), 0);
  await nested.getByRole("button", { name: "前往时区与语言配置", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS collapsed assessment, explicit probes, scores, fresh-readback failure, conflict preservation, recommendation draft and confirmed save");
} finally { await browser.close(); }
