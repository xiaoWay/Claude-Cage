package workbench

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/sylvinus/agent-vm/internal/guestos"
	"golang.org/x/crypto/ssh"
)

func macMaintenanceKit(t *testing.T) string {
	t.Helper()
	kit := filepath.Join(t.TempDir(), "guest-os")
	for _, name := range []string{"Cage Guest Window.app/Contents/MacOS/CageGuestWindow", "Cage Guest Clipboard.app/Contents/MacOS/CageGuestClipboard", "project/cage-sshfs", "project/cage-macos-terminal", "native-browser/macos-native-browser.mjs", "native-browser/macos-browser-service.mjs", "native-browser/macos-browser-window.mjs", "register-macos-browser.sh", "native-browser/macos-phone-browser.mjs", "macos-cli.py", "cli_channel.py"} {
		filename := filepath.Join(kit, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, []byte("current"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return kit
}

func nativeMaintenanceRequest(s *Server, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, s.origin+path, strings.NewReader(body))
	r.Header.Set("Origin", s.origin)
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: s.session})
	r.AddCookie(&http.Cookie{Name: s.cookieName() + "-desktop", Value: trustedViewProof(s.token)})
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	return w
}

func TestNativeVersionsUsesBoundTransportAndActualManifest(t *testing.T) {
	var mu sync.Mutex
	var unavailable, malformed atomic.Bool
	var probes atomic.Int32
	snapshot := nativeComponentSnapshot{}
	guest := newMacWorkspaceGuest(t, func(channel ssh.Channel, command string) (uint32, bool) {
		if !strings.Contains(command, "cage-components.json") {
			return 0, false
		}
		if !strings.Contains(command, "cage-cli/bin/python3") || !strings.Contains(command, "hashlib.file_digest") {
			t.Error("version read omitted the bundled Python and actual file verification")
			return 1, true
		}
		probes.Add(1)
		if unavailable.Load() {
			return 255, true
		}
		if malformed.Load() {
			fmt.Fprint(channel, "invalid snapshot")
			return 0, true
		}
		mu.Lock()
		defer mu.Unlock()
		if err := json.NewEncoder(channel).Encode(snapshot); err != nil {
			return 1, true
		}
		return 0, true
	})
	s := guest.s
	kit := macMaintenanceKit(t)
	s.exe = filepath.Join(filepath.Dir(kit), "cage")
	required, err := guestos.RequiredNativeComponents(kit, guestos.MacOS)
	if err != nil {
		t.Fatal(err)
	}
	check := func(status string, installed bool) {
		t.Helper()
		response := nativeMaintenanceRequest(s, "GET", "/api/environment/versions", "")
		var result struct {
			Components  componentVersions `json:"components"`
			Installed   bool              `json:"installed"`
			Tools       map[string]toolVersion
			Maintenance struct{ Native bool }
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil {
			t.Fatal(response.Code, response.Body.String())
		}
		if result.Components.Status != status || result.Installed != installed || !result.Maintenance.Native {
			t.Fatal(response.Body.String())
		}
		if status == "current" && result.Tools["claude"].Current != "2.1.311 (Claude Code)" {
			t.Fatal("tool version was inferred from required version")
		}
		before := probes.Load()
		state := nativeMaintenanceRequest(s, "GET", "/api/status", "")
		if probes.Load() != before {
			t.Fatal("status polling probed the guest again")
		}
		var summary struct {
			UpdateRequired bool   `json:"environment_update_required"`
			Error          string `json:"environment_update_error"`
		}
		if state.Code != 200 || json.Unmarshal(state.Body.Bytes(), &summary) != nil {
			t.Fatal(state.Code, state.Body.String())
		}
		if summary.UpdateRequired != result.Components.UpdateRequired {
			t.Fatalf("status and environment.versions disagree: status=%t, versions=%t", summary.UpdateRequired, result.Components.UpdateRequired)
		}
		if status == "update_required" && !strings.Contains(summary.Error, "版本与组件") {
			t.Fatal("missing component update recovery", summary.Error)
		}
		if status == "current" && summary.Error != "" {
			t.Fatal("successful verification retained the old update error", summary.Error)
		}
	}
	check("update_required", false)
	mu.Lock()
	snapshot.Manifest = &required.GuestManifest
	snapshot.Installed = true
	snapshot.Tools = map[string]string{"claude": "2.1.311 (Claude Code)"}
	mu.Unlock()
	check("current", true)
	unavailable.Store(true)
	check("unknown", false)
	unavailable.Store(false)
	mu.Lock()
	old := required.GuestManifest
	old.Revision = "previous-components"
	old.AppVersion = "0.1.7-rc.1"
	snapshot.Manifest = &old
	mu.Unlock()
	check("update_required", true)
	unavailable.Store(true)
	check("unknown", false)
	unavailable.Store(false)
	malformed.Store(true)
	check("unknown", false)
	malformed.Store(false)
	mu.Lock()
	// Compatibility is determined by the component protocol/revision, not
	// the application's display version alone.
	compatible := required.GuestManifest
	compatible.AppVersion = "0.1.7-rc.1"
	snapshot.Manifest = &compatible
	mu.Unlock()
	check("current", true)
	mu.Lock()
	snapshot.Installed = false
	snapshot.Missing = []string{"/Applications/Cage Guest Clipboard.app/Contents/MacOS/CageGuestClipboard"}
	mu.Unlock()
	check("update_required", false)
	if err = os.Remove(filepath.Join(kit, "macos-cli.py")); err != nil {
		t.Fatal(err)
	}
	check("unknown", false)
}

func TestNativeVersionsCannotClearUpdateAcrossMaintenanceJob(t *testing.T) {
	var s *Server
	var snapshot nativeComponentSnapshot
	guest := newMacWorkspaceGuest(t, func(channel ssh.Channel, command string) (uint32, bool) {
		if !strings.Contains(command, "cage-components.json") {
			return 0, false
		}
		// Simulate maintenance starting and finishing while an old version
		// request is still reading its otherwise matching snapshot.
		s.setJobForTest(Job{ID: "new-maintenance", Kind: "environment-update"})
		if err := json.NewEncoder(channel).Encode(snapshot); err != nil {
			return 1, true
		}
		return 0, true
	})
	s = guest.s
	kit := macMaintenanceKit(t)
	s.exe = filepath.Join(filepath.Dir(kit), "cage")
	required, err := guestos.RequiredNativeComponents(kit, guestos.MacOS)
	if err != nil {
		t.Fatal(err)
	}
	snapshot = nativeComponentSnapshot{Manifest: &required.GuestManifest, Installed: true}
	s.guestUpdateRequired = true
	s.guestUpdateError = "component update failed; retry"
	response := nativeMaintenanceRequest(s, "GET", "/api/environment/versions", "")
	var result struct{ Components componentVersions }
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Components.Status != "unknown" || !result.Components.UpdateRequired {
		t.Fatal("stale version result superseded maintenance", response.Code, response.Body.String())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.guestUpdateRequired || s.guestUpdateError != "component update failed; retry" {
		t.Fatal("stale version result cleared maintenance failure")
	}
}

func TestNativeMaintenanceTransfersToExistingMacIdentity(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS maintenance executes the host OpenSSH and BSD tar")
	}
	var calls atomic.Int32
	var fail atomic.Bool
	var mu sync.Mutex
	files := map[string][]byte{}
	guest := newMacWorkspaceGuest(t, func(channel ssh.Channel, command string) (uint32, bool) {
		calls.Add(1)
		switch {
		case strings.Contains(command, "mktemp -d /private/var/tmp/cage-components."):
			if !strings.Contains(command, "cage") {
				t.Error("missing provisioning identity")
			}
			fmt.Fprintln(channel, "/private/var/tmp/cage-components.ABCDEFGH")
		case strings.Contains(command, "/usr/bin/tar -xf -"):
			archive := tar.NewReader(channel)
			for {
				header, err := archive.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Error(err)
					return 1, true
				}
				if header.Typeflag == tar.TypeReg {
					contents, err := io.ReadAll(archive)
					if err != nil {
						t.Error(err)
						return 1, true
					}
					mu.Lock()
					files[strings.TrimPrefix(header.Name, "./")] = contents
					mu.Unlock()
				}
			}
			io.Copy(io.Discard, channel)
		case strings.Contains(command, "maintain-macos-workbench.sh"):
			if !strings.Contains(command, "cageuser components") || !strings.Contains(command, "/Users/cage/password") {
				t.Errorf("maintenance did not retain old provisioning/user identities: %s", command)
			}
			if fail.Load() {
				return 1, true
			}
		case strings.Contains(command, "/usr/sbin/chown -R root:wheel /private/var/tmp/cage-components.ABCDEFGH"),
			strings.Contains(command, "/bin/rm -rf /private/var/tmp/cage-components.ABCDEFGH"):
		default:
			t.Errorf("unexpected operation: %s", command)
			return 1, true
		}
		return 0, true
	})
	s := guest.s
	identifier := []byte("existing-mac-identity")
	if err := os.WriteFile(filepath.Join(s.instanceDir(), "vz-identifier"), identifier, 0600); err != nil {
		t.Fatal(err)
	}
	binding := guestos.MacOSProfile{Version: 1, Instance: "mac", User: "cageuser", MachineID: fmt.Sprintf("%x", sha256.Sum256(identifier))}
	if err := writePrivate(filepath.Join(s.profile, "macos-guest.json"), binding); err != nil {
		t.Fatal(err)
	}
	kit := macMaintenanceKit(t)
	manifest, err := guestos.RequiredNativeComponents(kit, guestos.MacOS)
	if err != nil {
		t.Fatal(err)
	}
	manifestFile := filepath.Join(t.TempDir(), "manifest.json")
	if err = guestos.WriteNativeComponentManifest(manifestFile, manifest); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	for _, shouldFail := range []bool{true, false, false} {
		fail.Store(shouldFail)
		err = guestos.MaintainMacOSComponents(t.Context(), s.profile, kit, manifestFile, false, &log, &log)
		if (err != nil) != shouldFail {
			t.Fatal(err, log.String())
		}
	}
	mu.Lock()
	var transferred guestos.NativeComponentManifest
	err = json.Unmarshal(files["native-components.json"], &transferred)
	phone := string(files["native-browser/macos-phone-browser.mjs"])
	mu.Unlock()
	if err != nil || transferred.Revision != manifest.Revision || phone != "current" {
		t.Fatal("new capability or manifest missing from native transfer", err)
	}
	before := calls.Load()
	if err = os.WriteFile(filepath.Join(kit, "macos-cli.py"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if guestos.MaintainMacOSComponents(t.Context(), s.profile, kit, manifestFile, false, &log, &log) == nil || calls.Load() != before {
		t.Fatal("changed source was transferred after manifest selection")
	}
}

func TestNativeMaintenanceRejectsLiveTerminalsBeforeJob(t *testing.T) {
	for _, system := range []string{guestos.MacOS, guestos.Windows11} {
		t.Run(system, func(t *testing.T) {
			s := testServer(t)
			if system == guestos.MacOS {
				s.macosGuest = &guestos.MacOSProfile{Instance: "mac", User: "cage"}
			} else {
				s.windowsGuest = &guestos.WindowsProfile{}
			}
			s.terminals.sessions = map[string]*terminalSession{"active": {}}
			for _, route := range []string{"/api/environment/update", "/api/environment/tools"} {
				response := nativeMaintenanceRequest(s, "POST", route, "{}")
				if response.Code != 409 || !strings.Contains(response.Body.String(), "结束正在运行的终端") || s.jobs.snapshot().Running {
					t.Fatal(response.Code, response.Body.String())
				}
			}
			s.terminals.sessions = nil
			response := nativeMaintenanceRequest(s, "POST", "/api/environment/update", "{}")
			if response.Code != 409 || !strings.Contains(response.Body.String(), "启动并登录客机") {
				t.Fatal(response.Code, response.Body.String())
			}
		})
	}
}
