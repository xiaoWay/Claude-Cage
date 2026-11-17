package workbench

import (
	"bufio"
	"encoding/json"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/guestprofile"
	"golang.org/x/crypto/ssh"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeviceReportBindsObservedSettingsToEnvironment(t *testing.T) {
	var observation browserObservation
	guest := newMacWorkspaceGuest(t, func(channel ssh.Channel, command string) (uint32, bool) {
		if !strings.Contains(command, "macos-native-browser.mjs") {
			return 0, false
		}
		scanner := bufio.NewScanner(channel)
		for scanner.Scan() {
			if err := json.NewEncoder(channel).Encode(observation); err != nil {
				return 1, true
			}
		}
		return 0, true
	})
	s := guest.s
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		t.Fatal(err)
	}
	s.safety.Gate = &cage.GateStatus{RunID: "fixture-run", Configuration: cfg.Fingerprint()}
	observation = browserObservation{Timezone: cfg.Timezone, Language: cfg.BrowserLanguage, Platform: "Linux x86_64", Device: sampleDevice()}
	observation.Device.BrowserProduct = "Chrome/142.0.0.0"
	read := func() deviceCheckReport {
		t.Helper()
		w := nativeMaintenanceRequest(s, "POST", "/api/environment/device-check", `{"target":"browser"}`)
		var report deviceCheckReport
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &report) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		if report.RunID != "fixture-run" || report.Configuration != cfg.Fingerprint() || report.ExpectedTimezone != cfg.Timezone || report.ExpectedLanguage != cfg.BrowserLanguage {
			t.Fatal("device report did not bind its request to the current configuration")
		}
		if report.BrowserTimezone != observation.Timezone || report.BrowserLanguage != observation.Language || report.BrowserPlatform != observation.Platform || report.Browser == nil {
			t.Fatal("device report omitted the actual page settings")
		}
		return report
	}
	before := read()
	cfg.Timezone = "America/New_York"
	if err = writePrivate(s.configPath, cfg); err != nil {
		t.Fatal(err)
	}
	after := read()
	if before.Configuration == after.Configuration || after.BrowserTimezone == after.ExpectedTimezone {
		t.Fatal("saved settings replaced actual page observations")
	}
}

func sampleDevice() *deviceObservation {
	v := &deviceObservation{UserAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36", Platform: "Linux x86_64"}
	v.Canvas.State = "passed"
	v.Canvas.Checksum = "1234abcd"
	v.WebGL.State = "passed"
	v.WebGL.Renderer = "ANGLE (Intel, Intel UHD Graphics, OpenGL)"
	v.WebGL.Version = "WebGL 2.0"
	v.Audio.State = "permission_required"
	return v
}
func checkState(items []deviceCheckItem, id string) string {
	for _, item := range items {
		if item.ID == id {
			return item.State
		}
	}
	return "missing"
}

func TestGraphicsEvidenceDistinguishesFallback(t *testing.T) {
	p, err := guestprofile.New(guestprofile.Options{GraphicsBackend: "opengl"})
	if err != nil {
		t.Fatal(err)
	}
	v := sampleDevice()
	items, class := evaluateDevice(p, v)
	if class != "driver-reported" || checkState(items, "webgl-render") != "passed" {
		t.Fatal("valid render sample rejected")
	}
	v.WebGL.Renderer = "ANGLE (Intel, Intel UHD Graphics, Direct3D11)"
	v.WebGL.Version = "WebGL 2.0 (OpenGL ES 3.0 Chromium)"
	items, _ = evaluateDevice(p, v)
	if checkState(items, "graphics-backend") == "passed" {
		t.Fatal("WebGL API version cannot confirm the native OpenGL backend")
	}
	v.WebGL.Renderer = "llvmpipe (LLVM 18)"
	items, class = evaluateDevice(p, v)
	if class != "software" || checkState(items, "graphics-backend") != "failed" {
		t.Fatal("software fallback accepted as requested hardware")
	}
	p.GraphicsBackend = "auto"
	items, _ = evaluateDevice(p, v)
	if checkState(items, "graphics-backend") != "warning" {
		t.Fatal("automatic fallback was hidden")
	}
	v.WebGL.Renderer = "Apple Paravirtual device"
	items, class = evaluateDevice(p, v)
	if class != "virtual-gpu" || checkState(items, "webgl-render") != "passed" {
		t.Fatal("virtual device was not classified truthfully")
	}
	v.WebGL.State = "failed"
	items, _ = evaluateDevice(p, v)
	if checkState(items, "webgl-render") != "failed" {
		t.Fatal("incorrect pixels passed")
	}
	items, class = evaluateDevice(p, nil)
	if class != "unobserved" || checkState(items, "browser-evidence") != "unknown" {
		t.Fatal("missing browser evidence passed")
	}
}

func TestPermissionAndMalformedEvidenceNeverPass(t *testing.T) {
	v := sampleDevice()
	items, _ := evaluateDevice(nil, v)
	if checkState(items, "browser-audio") != "unknown" || checkState(items, "user-agent") != "unknown" {
		t.Fatal("unavailable audio/UA evidence passed")
	}
	v.WebGL.Renderer = strings.Repeat("x", 513)
	items, _ = evaluateDevice(nil, v)
	if checkState(items, "browser-evidence") != "unknown" {
		t.Fatal("oversize untrusted evidence accepted")
	}
	s := &Server{profile: t.TempDir()}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "http://localhost/api/environment/device-check", strings.NewReader(`{"target":"browser"}`))
	s.deviceCheck(w, r)
	if w.Code != 403 {
		t.Fatal("untrusted window collected guest device evidence")
	}
}

func TestDeviceChecksSavedOptionsAndIdentityConsistency(t *testing.T) {
	p, err := guestprofile.New(guestprofile.Options{WebGL: "disabled", Canvas: "blocked"})
	if err != nil {
		t.Fatal(err)
	}
	v := sampleDevice()
	if err = json.Unmarshal([]byte(`{"brands":[{"brand":"Chromium","version":"142"}],"platform":"Linux"}`), &v.ClientHints); err != nil {
		t.Fatal(err)
	}
	items, _ := evaluateDevice(p, v)
	if checkState(items, "user-agent") != "passed" || checkState(items, "webgl-render") != "failed" || checkState(items, "canvas-render") != "failed" {
		t.Fatal("saved privacy settings were not checked against actual capability")
	}
	v.WebGL.State = "unavailable"
	v.WebGL.Renderer = ""
	v.Canvas.State = "blocked"
	v.Canvas.Checksum = ""
	items, _ = evaluateDevice(p, v)
	if checkState(items, "webgl-render") != "passed" || checkState(items, "canvas-render") != "passed" {
		t.Fatal("matching privacy settings rejected")
	}
	v.ClientHints.Platform = "Windows"
	items, _ = evaluateDevice(p, v)
	if checkState(items, "user-agent") != "failed" {
		t.Fatal("inconsistent browser OS passed")
	}
	v.ClientHints.Platform = "Linux"
	v.ClientHints.Brands[0].Version = "141"
	items, _ = evaluateDevice(p, v)
	if checkState(items, "user-agent") != "failed" {
		t.Fatal("inconsistent browser version passed")
	}
}

func TestDeviceBrowserVersionUsesProcessEvidence(t *testing.T) {
	for _, tc := range []struct{ name, product, ua, want string }{
		{"reduced UA", "Chrome/156.0.8078.79", "Chrome/156.0.0.0", "passed"},
		{"headless", "HeadlessChrome/156.0.8078.79", "HeadlessChrome/156.0.0.0", "passed"},
		{"Chromium", "Chromium/156.0.8078.79", "Chrome/156.0.0.0", "passed"},
		{"real mismatch", "Chrome/151.0.7777.1", "Chrome/156.0.0.0", "failed"},
		{"one major mismatch", "Chrome/155.0.7777.1", "Chrome/156.0.0.0", "failed"},
		{"older component", "", "Chrome/156.0.0.0", "unknown"},
		{"missing page UA", "Chrome/156.0.8078.79", "", "unknown"},
		{"invalid product", "feature estimate 149-151", "Chrome/156.0.0.0", "unknown"},
		{"invalid version", "Chrome/not-a-version", "Chrome/156.0.0.0", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := sampleDevice()
			v.UserAgent, v.BrowserProduct = tc.ua, tc.product
			items, _ := evaluateDevice(nil, v)
			if got := checkState(items, "browser-version"); got != tc.want {
				t.Fatalf("version state = %s; want %s", got, tc.want)
			}
		})
	}
}

func TestDeviceProcessVersionDoesNotMaskConflictingClientHints(t *testing.T) {
	v := sampleDevice()
	v.BrowserProduct = "Chrome/142.0.1234.5"
	if err := json.Unmarshal([]byte(`{"brands":[{"brand":"Chromium","version":"141"}],"platform":"Linux"}`), &v.ClientHints); err != nil {
		t.Fatal(err)
	}
	items, _ := evaluateDevice(nil, v)
	if checkState(items, "browser-version") != "passed" || checkState(items, "user-agent") != "failed" {
		t.Fatal("process agreement concealed contradictory Client Hints")
	}
	v.BrowserProduct = "Chrome/142.0.1234.5\nprivate text"
	items, _ = evaluateDevice(nil, v)
	if checkState(items, "browser-evidence") != "unknown" {
		t.Fatal("malformed process metadata was displayed")
	}
}
