package workbench

import (
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/exitpolicy"
)

// Geolocation disagreements are advisory to timezone selection. Mandatory
// country and saved exit rules are evaluated separately and cannot be waived.
func locationConsistencyCheck(location *Location, timezone string, automatic bool) cage.SafetyCheck {
	check := cage.SafetyCheck{ID: "location_consistency", Title: "时区设置与 IP 定位", State: cage.CheckUnknown, CheckedAt: time.Now(), Evidence: "尚无多来源定位证据；系统和浏览器配置读回单独检查", Remedy: "在时区与语言设置中查看定位来源，必要时手动确认时区"}
	if location == nil || location.Evidence == nil {
		return check
	}
	evidence := location.Evidence
	switch {
	case location.exitLocation().CountryCode == "CN":
		check.Evidence = "定位来源报告中国大陆出口；时区选择不能覆盖出口规则"
	case evidence.CountryStatus == exitpolicy.LocationConflict:
		check.Evidence = "定位结果不一致：国家或地区来源冲突；时区选择不能覆盖出口规则"
	case evidence.CountryStatus != exitpolicy.LocationConsistent || location.CountryCode == "":
		check.Evidence = "定位证据不足：无法交叉确认出口国家或地区；时区比较待确认"
	case evidence.TimezoneStatus == exitpolicy.LocationConflict:
		check.Evidence = "定位结果不一致：同一出口的时区来源冲突；当前采用手动时区，来源差异保留供参考"
		if automatic {
			check.Evidence = "定位结果不一致：同一出口的时区来源冲突；自动时区保留当前值，等待人工选择"
		}
	case evidence.TimezoneStatus == exitpolicy.LocationConsistent && evidence.CountryStatus == exitpolicy.LocationConsistent && !exitpolicy.SameLocationTimezone(location.Timezone, timezone):
		check.State = cage.CheckFailed
		check.Evidence = "定位来源的时区建议与已应用时区不同；当前使用手动设置，系统和浏览器仍按已保存配置核对"
		if automatic {
			check.Evidence = "定位来源的时区建议与已应用时区不同；系统和浏览器配置读回单独检查，请在设置中人工核对"
		}
	case evidence.TimezoneStatus == exitpolicy.LocationConsistent && evidence.CountryStatus == exitpolicy.LocationConsistent:
		check.State = cage.CheckPassed
		check.Evidence = "时区设置与 IP 定位一致：至少两个可用来源的国家和时区一致；不代表物理位置或账户审核结论"
		if evidence.Status == exitpolicy.LocationConflict {
			check.Evidence += "；城市或地区来源存在分歧，城市位置仅供参考"
		}
	default:
		check.Evidence = "定位证据不足：可用来源少于两个；配置时区保留，可查看来源后手动确认"
	}
	return check
}
