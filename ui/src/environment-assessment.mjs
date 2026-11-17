import { sameLocationTimezone } from "./location-evidence.mjs";

export const assessmentPolicy = "environment-consistency/1";
export const assessmentLifetime = { safety: 24 * 60 * 60_000, location: 60 * 60_000, browser: 10 * 60_000 };

const groups = [
  { id: "network", title: "网络与隔离", weight: 50, checks: [
    ["egress_policy", "出口规则"], ["proxy_transport", "代理通道"], ["dns_transport", "DNS 通道"],
    ["filesystem_boundary", "文件共享边界"], ["management_boundary", "管理接口边界"],
    ["fail_closed", "代理故障关闭"], ["udp_policy", "UDP 规则"], ["ipv6_policy", "IPv6 规则"], ["exit_consistency", "实际出口一致性"],
  ] },
  { id: "settings", title: "系统与浏览器配置", weight: 25, checks: [["guest_settings", "客机配置读回"], ["browser_settings", "浏览器配置读回"]] },
  { id: "identity", title: "浏览器版本一致性", weight: 15, checks: [["browser-version", "页面 UA 与进程版本"], ["user-agent", "UA 与 Client Hints"]] },
  { id: "location", title: "定位与时区一致性", weight: 10, checks: [["location-country", "定位国家／地区"], ["location-timezone", "定位建议与已保存时区"]] },
];

const round = value => Math.round(value * 10) / 10;
const stateOf = state => ["passed", "failed"].includes(state) ? state : "unknown";
function fresh(value, lifetime, now) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 60_000 && now - time < lifetime;
}
function uniqueCheck(checks, id) {
  const found = (checks || []).filter(check => check.id === id);
  return found.length === 1 ? found[0] : null;
}
function validZone(zone) {
  if (typeof zone !== "string" || !zone) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; }
  catch { return false; }
}

// This is a transparent evidence summary, not an authorization decision.
// Unknown points remain unearned and are shown separately from failed points.
export function assessEnvironment({ status = {}, settings = {}, location = status.location, browserReport, now = Date.now() } = {}) {
  const gate = status.safety?.gate || {}, report = status.safety?.report;
  const running = Boolean(status.vm_running), changing = Boolean(status.job?.running);
  const sameEnvironment = value => Boolean(running && !changing && gate.run_id && gate.configuration &&
    value?.run_id === gate.run_id && value?.configuration === gate.configuration);
  const safetyCurrent = sameEnvironment(report) && report.policy === "cage-safety/3" && gate.policy === report.policy &&
    Boolean(report.id && report.check_id) && fresh(report.created_at, assessmentLifetime.safety, now);
  const networkOpen = gate.mode === "open" && gate.policy_verified === true && !gate.fault && Date.parse(gate.until) > now &&
    Boolean(gate.report?.id && gate.report.id === report?.id);
  const browserCurrent = sameEnvironment(browserReport) && browserReport?.target === "browser" &&
    fresh(browserReport.checked_at, assessmentLifetime.browser, now) &&
    browserReport.expected_timezone === settings.timezone && browserReport.expected_language === settings.browser_language;
  const evidence = location?.evidence;
  const locationCurrent = Boolean(running && !changing && location?.ip && location.ip === status.safety?.exit_ip &&
    fresh(evidence?.checked_at, assessmentLifetime.location, now));
  const sources = (evidence?.sources || []).filter(source => source.provider && !source.error && /^[A-Z]{2}$/.test(source.country_code || ""));
  const providers = new Set(sources.map(source => source.provider));
  const countryConflict = sources.some(source => source.country_code === "CN") || evidence?.country_status === "conflict" ||
    new Set(sources.map(source => source.country_code)).size > 1;
  const countryConfirmed = locationCurrent && !countryConflict && providers.size >= 2 &&
    evidence?.country_status === "consistent" && sources.every(source => source.country_code === location.country_code);
  const zoneSources = sources.filter(source => validZone(source.timezone));
  const zoneConfirmed = countryConfirmed && evidence?.timezone_status === "consistent" && validZone(location.timezone) &&
    new Set(zoneSources.map(source => source.provider)).size >= 2 && zoneSources.every(source => sameLocationTimezone(source.timezone, location.timezone));
  const locationChecks = {
    "location-country": {
      state: !locationCurrent ? "unknown" : countryConflict ? "failed" : countryConfirmed ? "passed" : "unknown",
      evidence: !locationCurrent ? "定位记录缺失、已超过一小时或不属于当前采样出口。" : countryConflict ? "定位国家／地区冲突或包含不符合现有出口规则的结果，需先核对。" : countryConfirmed ? "至少两个不同来源的国家／地区一致。" : "可用来源不足或尚未交叉确认国家／地区。",
    },
    "location-timezone": {
      state: zoneConfirmed && validZone(settings.timezone) ? sameLocationTimezone(location.timezone, settings.timezone) ? "passed" : "failed" : "unknown",
      evidence: zoneConfirmed ? `已保存 ${settings.timezone || "未设置"}；来源建议 ${location.timezone}。` : "时区来源分歧、证据不足或记录不属于当前出口，保留已保存设置。",
    },
  };

  const categories = groups.map(group => {
    const rows = group.checks.map(([id, title]) => {
      let check, current, checkedAt, source;
      if (group.id === "location") {
        check = locationChecks[id]; current = locationCurrent; checkedAt = evidence?.checked_at; source = "同一出口的多来源 IP 定位";
      } else if (group.id === "identity") {
        check = uniqueCheck(browserReport?.checks, id); current = browserCurrent; checkedAt = browserReport?.checked_at; source = "客机浏览器私有控制通道与实际页面";
      } else {
        check = uniqueCheck(report?.checks, id); checkedAt = check?.checked_at; source = "当前环境的关键检查报告";
        current = safetyCurrent && check?.critical === true && fresh(checkedAt, assessmentLifetime.safety, now) && Date.parse(checkedAt) >= Date.parse(report.created_at);
        // A former successful sample is not evidence of live networking after
        // a pause, expired lease or loss of policy verification.
        if (group.id === "network" && check?.state === "passed" && !networkOpen) current = false;
        if (id === "browser_settings" && browserCurrent) {
          const timezone = browserReport.browser_timezone, language = browserReport.browser_language, platform = browserReport.browser_platform;
          const system = status.guest_system || "";
          const platformMismatch = Boolean(platform && (/^macos/.test(system) ? !platform.startsWith("Mac") : /^windows/.test(system) ? !platform.startsWith("Win") : /^(debian|ubuntu|linux)/.test(system) && !platform.startsWith("Linux")));
          const prior = current ? stateOf(check?.state) : "unknown";
          const mismatch = timezone && language && (!sameLocationTimezone(timezone, settings.timezone) || language !== settings.browser_language) || platformMismatch;
          // The optional device probe can reveal a new mismatch. It cannot
          // clear a failure or replace the full mandatory browser check.
          check = { state: prior === "failed" || mismatch ? "failed" : !timezone || !language ? "unknown" : prior,
            evidence: `页面读回时区 ${timezone || "未取得"}、语言 ${language || "未取得"}、平台 ${platform || "未取得"}；已保存时区 ${settings.timezone}、语言 ${settings.browser_language}。` + (prior === "failed" ? ` 完整关键检查仍未通过：${check.evidence}` : "") };
          current = true; checkedAt = browserReport.checked_at; source = "最近页面读回与完整关键检查共同核对";
        }
      }
      const state = current ? stateOf(check?.state) : "unknown";
      return { id, title, state, source, checkedAt, evidence: current && check?.evidence ? check.evidence : "尚无当前有效证据；可能未检测、已过期、环境已变化或正在执行操作。", critical: ["network", "settings"].includes(group.id) };
    });
    const passed = rows.filter(row => row.state === "passed").length;
    const known = rows.filter(row => row.state !== "unknown").length;
    return { ...group, rows, earned: group.weight * passed / rows.length, covered: group.weight * known / rows.length };
  });
  const rows = categories.flatMap(category => category.rows);
  const earned = round(categories.reduce((sum, category) => sum + category.earned, 0));
  const coverage = round(categories.reduce((sum, category) => sum + category.covered, 0));
  const criticalFailed = rows.some(row => row.critical && row.state === "failed");
  const criticalUnknown = rows.some(row => row.critical && row.state === "unknown");
  const failed = rows.some(row => row.state === "failed");
  const deviceFailures = browserCurrent ? (browserReport.checks || []).filter(check => check.state === "failed" && !["browser-version", "user-agent"].includes(check.id)).length : 0;
  const label = !running ? "环境未启动" : changing ? "环境操作中，等待复核" : criticalFailed ? "关键检查未通过" : criticalUnknown ? "关键证据待确认" : failed ? "存在不一致" : deviceFailures ? "存在设备配置异常" : coverage < 100 ? "部分证据待确认" : "已核验项目一致";

  const recommendations = [], patch = {};
  if (zoneConfirmed) {
    recommendations.push({ title: "系统与浏览器时区", value: location.timezone, reason: "当前采样出口的至少两个来源一致；保存后仍需核对系统与浏览器实际读回。" });
    if (!sameLocationTimezone(settings.timezone, location.timezone)) Object.assign(patch, { timezone: location.timezone, auto_timezone: false });
  } else {
    recommendations.push({ title: "系统与浏览器时区", value: settings.timezone || "先检测当前出口", reason: "证据不足或来源分歧，当前没有可自动确定的最佳时区；保留设置并人工核对来源。" });
  }
  const suggestedLanguage = countryConfirmed && settings.auto_language &&
    /^[a-z]{2,3}_[A-Z]{2,3}\.UTF-8$/.test(location.suggested_locale || "") &&
    /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(location.suggested_browser_language || "");
  const locale = suggestedLanguage ? location.suggested_locale : settings.locale;
  const language = suggestedLanguage ? location.suggested_browser_language : settings.browser_language;
  recommendations.push({ title: "系统与浏览器语言", value: [locale, language].filter(Boolean).join(" / ") || "尚未设置", reason: suggestedLanguage ? "沿用已启用的自动语言规则，按已确认出口国家／地区提供建议。" : "保留已选语言偏好，按已保存配置核对实际读回；国家定位不唯一决定用户语言。" });
  if (suggestedLanguage && (locale !== settings.locale || language !== settings.browser_language)) Object.assign(patch, { locale, browser_language: language, auto_language: false });
  recommendations.push({ title: "浏览器身份与图形", value: "使用受支持的原生浏览器身份与图形后端", reason: "以进程版本、UA 和 Client Hints 实际读回核对；软件或虚拟 GPU 类型本身不扣分，渲染异常在设备检测中单独显示。" });
  recommendations.push({ title: "网络与出口规则", value: "保留既有出口规则，先处理关键检查中的失败项", reason: "实际出口、DNS 和隔离边界优先；定位与社区评分不用于放宽网络规则。" });
  return { policy: assessmentPolicy, score: coverage ? earned : null, coverage, unknown: round(100 - coverage), failedPoints: round(coverage - earned), label, criticalFailed, deviceFailures, categories, recommendations, patch, locationCurrent, browserCurrent };
}
