import assert from "node:assert/strict";
import { createWorkbench, chooseInline } from "./workbench-fixture.mjs";

const sample = (kind = "timezone") => ({
  ip: "192.0.2.10", country: "United States", country_code: "US", region: "sample-region", city: "sample-city", timezone: "America/Los_Angeles", checked_at: new Date().toISOString(),
  suggested_locale: "en_US.UTF-8", suggested_browser_language: "en-US",
  evidence: { status: "conflict", country_status: kind === "country" ? "conflict" : "consistent", timezone_status: kind === "city" ? "consistent" : "conflict", checked_at: new Date().toISOString(), sources: [
    { provider: "source-a", country_code: "US", city: "sample-city", timezone: "America/Los_Angeles" },
    { provider: "source-b", country_code: kind === "country" ? "CA" : "US", city: "other-city", timezone: kind === "city" ? "America/Los_Angeles" : "America/New_York" },
    { provider: "source-c", error: "连接失败或超时" },
  ] },
});
let result = sample();
const { page, browser, state, errors } = await createWorkbench({
  beforeNavigate: async (page, state) => {
    state.settings.auto_timezone = true;
    state.settings.timezone = "America/New_York";
    state.status.location = result;
    state.status.safety = { exit_ip: result.ip, report: { checks: [
      { id: "guest_settings", state: "passed", evidence: "客机读回 America/New_York", checked_at: new Date().toISOString() },
      { id: "browser_settings", state: "failed", evidence: "浏览器实际配置未符合已保存值", checked_at: new Date().toISOString() },
    ] } };
    await page.route("**/api/settings/probe", route => route.fulfill({ json: result }));
  },
});
page.setDefaultTimeout(12000);
try {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: "时区与语言", exact: true }).click();
  const assessment = page.getByRole("region", { name: "环境评估", exact: true });
  const assessmentSummary = assessment.locator("details > summary").first();
  const evidence = page.getByRole("region", { name: "IP 定位来源校验", exact: true });
  const summary = evidence.locator(".location-comparison-summary");
  assert.equal(await evidence.getByRole("table").isVisible(), false, "assessment should start collapsed");
  await assessmentSummary.click();
  await summary.getByText("时区待确认", { exact: true }).waitFor();
  await summary.getByText("上次配置读回：未通过", { exact: true }).waitFor();
  await evidence.getByRole("heading", { name: "定位结果不一致", exact: true }).waitFor();
  assert.equal(await evidence.getByRole("row").count(), 4);
  if (process.env.CAGE_LOCATION_EVIDENCE) await page.screenshot({ path: process.env.CAGE_LOCATION_EVIDENCE, fullPage: true });
  await evidence.getByRole("button", { name: "重新校验定位来源", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "将应用的时区", exact: true }).inputValue(), "America/New_York", "provider conflict silently changed the timezone");
  await chooseInline(evidence.getByRole("combobox", { name: "人工选择时区", exact: true }), "America/Los_Angeles");
  await evidence.getByRole("button", { name: "使用此时区（手动）", exact: true }).click();
  const automatic = page.getByRole("switch", { name: /跟随出口 IP 的时区/ });
  assert.equal(await automatic.isChecked(), false);
  assert.equal(await page.getByRole("combobox", { name: "系统时区", exact: true }).inputValue(), "America/Los_Angeles");
  assert.equal(state.requests.filter(r => r.path === "/settings" && r.method === "POST").length, 0, "selection saved or restarted without an explicit save");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  for (let i = 0; state.settings.auto_timezone && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(state.settings.auto_timezone, false);
  assert.equal(state.settings.timezone, "America/Los_Angeles");

  await page.getByRole("region", { name: "设置", exact: true }).waitFor({ state: "hidden" });

  // Country disagreements remain separate from a manual timezone choice.
  result = sample("country"); state.status.location = result;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: "时区与语言", exact: true }).click();
  await assessmentSummary.click();
  await evidence.getByText(/国家或地区来源冲突/).waitFor();
  assert.equal(await evidence.getByRole("button", { name: "使用此时区（手动）", exact: true }).isDisabled(), true);
  // A city-only disagreement still permits an explicit timezone comparison.
  result = sample("city"); state.status.location = result;
  await evidence.getByRole("button", { name: "重新校验定位来源", exact: true }).click();
  await summary.getByText("时区设置一致", { exact: true }).waitFor();
  // A new unanimous estimate can disagree with the saved timezone. Merely
  // filling a draft must not present it as the applied or saved setting.
  result = { ...result, timezone: "America/New_York", evidence: { ...result.evidence, sources: result.evidence.sources.map(source => source.error ? source : { ...source, timezone: "America/New_York" }) } };
  await evidence.getByRole("button", { name: "重新校验定位来源", exact: true }).click();
  await summary.getByText("时区设置不一致", { exact: true }).waitFor();
  await chooseInline(evidence.getByRole("combobox", { name: "人工选择时区", exact: true }), "America/New_York");
  await evidence.getByRole("button", { name: "使用此时区（手动）", exact: true }).click();
  await evidence.getByText("未保存的草稿时区", { exact: true }).waitFor();
  await summary.getByText("时区设置不一致", { exact: true }).waitFor();
  await assessmentSummary.click();
  assert.equal(await evidence.getByRole("table").isVisible(), false);
  assert.deepEqual(errors, []);
  console.log("PASS collapsed timezone comparison, uncertainty, manual draft/save, saved-value comparison and country-conflict boundary");
} finally { await browser.close(); }
