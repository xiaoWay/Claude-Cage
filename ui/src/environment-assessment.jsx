import React, { useEffect, useRef } from "react";
import { assessEnvironment } from "./environment-assessment.mjs";
import { LocationEvidence } from "./location-evidence.jsx";
import { DeviceChecks } from "./device-checks";
import { SafetyMessage } from "./safety-message";
import "./environment-assessment.css";

const states = { passed: "通过", failed: "不一致", unknown: "待确认" };
const timeLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "尚未采样";

export function EnvironmentAssessment({ status, settings, draft, location = status.location, browserReport, onBrowserReport, busy, onProbe, onChooseTimezone, onConfigure, onApplyRecommendation }) {
  const context = JSON.stringify([status.vm_running, status.safety?.gate?.run_id, status.safety?.gate?.configuration, settings.timezone, settings.locale, settings.browser_language]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const assessment = assessEnvironment({ status, settings, location, browserReport });
  const disabled = busy || !status.vm_running || Boolean(status.job?.running);
  const draftChanged = draft && ["timezone", "locale", "browser_language", "auto_timezone", "auto_language", "exit_policy"].some(key => JSON.stringify(draft[key]) !== JSON.stringify(settings[key]));
  return <section className="environment-assessment" aria-label="环境评估">
    <details>
      <summary>
        <strong>环境一致性详情</strong>
        <span className="assessment-score">{assessment.score === null ? "待评估" : `已确认 ${assessment.score} / 100 分`}</span>
        <span data-state={assessment.criticalFailed || assessment.deviceFailures ? "failed" : assessment.coverage < 100 || assessment.failedPoints ? "unknown" : "passed"}>{assessment.label}</span>
        <span>证据覆盖率 {assessment.coverage}%</span>
      </summary>
      <div className="assessment-content">
        <p>此评分按已保存设置核对当前可验证的一致性与隔离证据。得分不用于网络放行，也不是账户封禁概率。</p>
        <p>待确认 {assessment.unknown} 分 · 已确认不一致 {assessment.failedPoints} 分。缺失、过期和其他环境的证据不计为通过。</p>
        {assessment.deviceFailures > 0 && <p role="alert">另有 {assessment.deviceFailures} 项设备配置异常，不在上述评分范围；请查看下方设备检测，修复后重测。</p>}
        {draftChanged && <p role="status">存在未保存的配置草稿，当前评分仍按已保存设置计算；保存并应用后需要重新核验。</p>}
        <h4>当前证据支持的配置建议</h4>
        <p className="field-help">推荐适用于本次已确认的出口与用途；分歧时保留原设置并等待人工确认。</p>
        <dl className="assessment-recommendations">{assessment.recommendations.map(item => <React.Fragment key={item.title}>
          <dt>{item.title}</dt><dd><strong>{item.value}</strong><p>{item.reason}</p></dd>
        </React.Fragment>)}</dl>
        {onApplyRecommendation && <button disabled={busy || !Object.keys(assessment.patch).length} onClick={() => onApplyRecommendation(assessment.patch)}>将推荐填入草稿</button>}
        {onConfigure && <button onClick={onConfigure}>前往时区与语言配置</button>}
        {onApplyRecommendation && <p className="field-help">填入的项目转为手动配置，通过页面底部的保存按钮确认应用后生效。草稿不会改变当前评分。</p>}
        <h4>分项评分与证据</h4>
        {assessment.categories.map(category => <details className="assessment-category" key={category.id}>
          <summary>{category.title} · {Math.round(category.earned * 10) / 10} / {category.weight} 分</summary>
          <ul>{category.rows.map(row => <li key={row.id} data-state={row.state}>
            <strong>{row.title} · {states[row.state]}</strong>
            <p><SafetyMessage message={row.evidence} /></p>
            <small>来源：{row.source} · {timeLabel(row.checkedAt)}</small>
          </li>)}</ul>
        </details>)}
        <LocationEvidence location={location} timezone={settings.timezone} draftTimezone={draft?.timezone}
          automaticTimezone={settings.auto_timezone} checks={status.safety?.report?.checks} busy={busy}
          onChooseTimezone={onChooseTimezone} onProbe={onProbe} />
        {!assessment.locationCurrent && location?.evidence && <p role="status">以上定位记录尚未计入当前评分，请核对采样时间与当前出口。</p>}
        <DeviceChecks key={context} disabled={disabled} initialReport={assessment.browserCurrent ? browserReport : null} onReport={(next, target) => {
          if (target === "browser" && mounted.current && currentContext.current === context) onBrowserReport?.(next);
        }} />
        <p className="field-help">版本评分使用最近一次浏览器检测。桌面应用的检测结果单独展示。重新检测由按钮发起，展开页面不会自动运行设备检测或定位查询。</p>
        <details className="assessment-method"><summary>评分方法与有效期</summary>
          <p>{assessment.policy}：网络与隔离 50 分、配置读回 25 分、浏览器版本一致性 15 分、定位与时区一致性 10 分；各组内项目等权。只有当前有效的“通过”项得分，未知项保留为待确认，关键检查失败优先显示。</p>
          <p>关键报告沿用 24 小时有效期，网络通过项还要求当前有效联网许可；定位证据一小时、浏览器设备观测十分钟内有效。报告须与当前环境及配置匹配。软件渲染、虚拟 GPU、音频权限缺失与第三方启发式版本估计本身不扣分。</p>
        </details>
      </div>
    </details>
  </section>;
}
