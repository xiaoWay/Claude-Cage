import React, { useEffect, useState } from "react";
import { InlineSelect } from "./inline-select";
import { locationEvidenceLabel, locationTimezoneState, sameLocationTimezone } from "./location-evidence.mjs";
import "./location-evidence.css";

export function LocationEvidence({ location, timezone, busy, onChooseTimezone, onProbe, onConfigure, automaticTimezone, draftTimezone, checks = [] }) {
  const evidence = location?.evidence;
  const sources = evidence?.sources || [];
  const valid = sources.filter(source => !source.error && source.timezone);
  const zones = [...new Set([timezone, ...valid.map(source => source.timezone)].filter(Boolean))];
  const [choice, setChoice] = useState(draftTimezone || timezone || "");
  useEffect(() => { setChoice(draftTimezone || timezone || ""); }, [draftTimezone, timezone, location?.ip]);
  const mainland = location?.country_code === "CN" || valid.some(source => source.country_code === "CN");
  const conflict = evidence?.status === "conflict";
  const countryConflict = evidence?.country_status === "conflict";
  const mismatch = Boolean(timezone && evidence?.timezone_status === "consistent" && !sameLocationTimezone(timezone, location.timezone));
  const zoneConflict = evidence?.timezone_status === "conflict";
  const comparison = locationTimezoneState(location, timezone);
  const comparisonLabels = { passed: "时区设置一致", failed: "时区设置不一致", unknown: "时区待确认" };
  const readbacks = checks.filter(check => ["guest_settings", "browser_settings"].includes(check.id));
  const readbackLabel = readbacks.some(check => check.state === "failed") ? "未通过" : ["guest_settings", "browser_settings"].every(id => readbacks.some(check => check.id === id && check.state === "passed")) ? "通过" : "待确认";
  return <section className={`location-evidence ${conflict ? "location-conflict" : ""}`} aria-label="IP 定位来源校验">
    <details>
      <summary><span>时区与 IP 定位</span><strong data-state={comparison}>{comparisonLabels[comparison]}</strong><span className="location-source-summary">{locationEvidenceLabel(evidence)}</span><span className="location-source-summary">上次配置读回：{readbackLabel}</span></summary>
      <div className="location-evidence-content">
    <dl className="location-timezone-comparison">
      <dt>已保存时区</dt><dd>{timezone || "尚未设置"}</dd>
      <dt>IP 定位时区</dt><dd>{zoneConflict ? [...new Set(valid.map(source => source.timezone))].join("、") : location?.timezone || "尚未取得"}</dd>
      {draftTimezone && draftTimezone !== timezone && <><dt>未保存的草稿时区</dt><dd>{draftTimezone}</dd></>}
    </dl>
    <h4>{locationEvidenceLabel(evidence)}</h4>
    {location?.ip && <p className="field-help">定位记录对应采样出口：<code>{location.ip}</code></p>}
    {evidence && <p className="field-help">可用来源 {valid.length} / {sources.length} · 查询于 {new Date(evidence.checked_at).toLocaleString()}</p>}
    {mainland ? <p role="alert">定位来源报告中国大陆出口，外网保持关闭。时区选择不能覆盖出口规则。</p>
      : countryConflict ? <p role="alert">国家或地区来源冲突，外网保持关闭。手动选择时区不能覆盖出口规则。</p>
      : zoneConflict ? <p role="status">{automaticTimezone ? "同一出口的时区来源不同，自动时区保留当前值。请核对来源后人工选择。" : "当前使用手动时区，定位来源的时区分歧保留供参考。"}</p>
        : evidence?.timezone_status === "insufficient" ? <p role="status">可用来源不足两个，配置时区保留。可重新检测或人工选择。</p>
          : mismatch ? <p role="status">来源建议时区为 {location.timezone}，与已保存时区 {timezone} 不同。请核对后选择要使用的时区。</p>
            : conflict ? <p role="status">城市或地区数据存在差异；可用的国家和时区来源一致。城市位置仅作近似参考。</p>
            : !evidence ? <p>检测当前出口后，分别查看各定位来源。</p> : null}
    {sources.length > 0 && <div className="location-evidence-table"><table>
      <thead><tr><th>来源</th><th>国家／地区</th><th>城市／区域</th><th>时区或查询结果</th><th>与已保存时区比较</th></tr></thead>
      <tbody>{sources.map(source => <tr key={source.provider}>
        <th scope="row">{source.provider}</th><td>{source.country_code || "—"}</td>
        <td>{[source.city, source.region].filter(Boolean).join(" / ") || "—"}</td>
        <td>{source.error || source.timezone || "未取得结果"}</td>
        <td>{source.error || !source.timezone || !timezone ? "待确认" : sameLocationTimezone(timezone, source.timezone) ? "一致" : "不一致"}</td>
      </tr>)}</tbody>
    </table></div>}
    {readbacks.length > 0 && <div className="location-timezone-readbacks">
      <h4>最近一次环境配置读回</h4>
      <p className="field-help">以下是上次环境检查的记录；草稿和 IP 定位重检不会更新客机或浏览器的实际读回。</p>
      {readbacks.map(check => <p key={check.id}><strong>{check.id === "guest_settings" ? "客机系统" : "浏览器"} · {check.state === "passed" ? "通过" : check.state === "failed" ? "未通过" : "待确认"}</strong>{check.checked_at && <span className="field-help"> · {new Date(check.checked_at).toLocaleString()}</span>}<br />{check.evidence}</p>)}
    </div>}
    {onChooseTimezone && evidence && (evidence.timezone_status !== "consistent" || mismatch) && <div className="location-timezone-choice">
      <label>人工选择时区<InlineSelect editable aria-label="人工选择时区" value={choice} onValueChange={setChoice} disabled={busy || countryConflict || mainland}>
        {zones.map(zone => <option key={zone} value={zone} />)}
      </InlineSelect></label>
      <button disabled={busy || countryConflict || mainland || !choice} onClick={() => onChooseTimezone(choice)}>使用此时区（手动）</button>
      <p className="field-help">选择后填入草稿并关闭自动跟随；保存并应用后生效。系统与浏览器仍须通过配置读回检查。</p>
    </div>}
    <div className="project-recovery-actions">
      {onProbe && <button disabled={busy} onClick={onProbe}>重新校验定位来源</button>}
      {onConfigure && <button onClick={onConfigure}>查看并确认时区</button>}
    </div>
    <p className="field-help">各来源仅比较所示采样 IP，不能代表所有目标域名的出口。IP 定位是近似估算，多个服务也可能共用数据。来源一致不证明物理位置或 Claude 账户审核结果。启动和应用设置复用近期查询，手动重检会更新来源。</p>
      </div>
    </details>
  </section>;
}
