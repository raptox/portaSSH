package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// launchIsolatedApp opens the PortaSSH UI in a Chromium-family browser running
// in "app mode" with a dedicated, extension-free profile stored on the same
// medium as the vault (e.g. the USB stick).
//
// Why this matters: a normal browser tab is exposed to every extension that has
// been granted access to localhost/all-sites, and such an extension can read
// keystrokes (including the master password) and terminal output straight out
// of the page. A fresh --user-data-dir profile has NO extensions, and
// --disable-extensions enforces that even if the profile dir is later polluted.
// The result is a frameless window, isolated from the user's daily browser.
//
// Returns true if a browser was launched; false if no Chromium-family browser
// was found (caller should fall back to the default system browser).
func launchIsolatedApp(url, profileDir string) bool {
	bin := findChromium()
	if bin == "" {
		return false
	}
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		log.Printf("PortaSSH: could not create isolated profile dir: %v", err)
		return false
	}

	args := []string{
		"--app=" + url, // chromeless, single-purpose window
		"--user-data-dir=" + profileDir, // isolated profile => no user extensions
		"--disable-extensions",          // belt-and-suspenders: force all extensions off
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-sync",
		"--disable-features=Translate,MediaRouter",
		"--window-size=1200,820",
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		// On macOS, exec'ing the Chrome binary directly while Chrome is already
		// running makes LaunchServices reuse the *existing* instance — it opens a
		// window in the user's default profile (breaking isolation) and later
		// dock clicks spawn blank windows instead of returning to PortaSSH.
		// `open -n` forces a brand-new, separate instance bound to our profile.
		if bundle := macAppBundle(bin); bundle != "" {
			cmd = exec.Command("open", append([]string{"-n", "-a", bundle, "--args"}, args...)...)
		} else {
			cmd = exec.Command(bin, args...)
		}
	} else {
		cmd = exec.Command(bin, args...)
	}

	if err := cmd.Start(); err != nil {
		log.Printf("PortaSSH: failed to launch isolated browser %q: %v", bin, err)
		return false
	}
	log.Printf("PortaSSH: opened isolated (extension-free) window via %s", filepath.Base(bin))
	return true
}

// macAppBundle derives the .app bundle path from a Chrome binary path, e.g.
// "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" -> the .app.
func macAppBundle(bin string) string {
	if i := strings.Index(bin, ".app/"); i >= 0 {
		return bin[:i+len(".app")]
	}
	return ""
}

// findChromium returns the path to the first available Chromium-family browser,
// or "" if none is found.
func findChromium() string {
	for _, c := range chromiumCandidates() {
		if isExecutable(c) {
			return c
		}
	}
	// Fall back to anything on PATH.
	for _, name := range []string{
		"google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
		"microsoft-edge", "microsoft-edge-stable", "brave-browser", "vivaldi",
	} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

// chromiumCandidates lists well-known install locations per OS, in preference order.
func chromiumCandidates() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
		}
	case "windows":
		var out []string
		for _, base := range []string{
			os.Getenv("ProgramFiles"),
			os.Getenv("ProgramFiles(x86)"),
			os.Getenv("LocalAppData"),
		} {
			if base == "" {
				continue
			}
			out = append(out,
				filepath.Join(base, `Google\Chrome\Application\chrome.exe`),
				filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(base, `Chromium\Application\chrome.exe`),
				filepath.Join(base, `BraveSoftware\Brave-Browser\Application\brave.exe`),
			)
		}
		return out
	default: // linux, bsd
		return []string{
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge",
			"/usr/bin/brave-browser",
			"/snap/bin/chromium",
		}
	}
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return true
}
