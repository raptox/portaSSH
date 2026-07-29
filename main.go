// PortaSSH — a portable, encrypted SSH connection manager you can carry on a
// USB stick.
//
// It stores your SSH credentials in a single AES-256-GCM encrypted vault file
// that lives next to the binary, serves a modern web UI on the loopback
// interface, and by default opens it in a native application window (an
// embedded WebView — no console, no browser). No installation, no background
// services, nothing written outside its own directory.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"portassh/internal/server"
	"portassh/internal/vault"
)

// version is stamped at build time via -ldflags "-X main.version=...".
// It defaults to "dev" for local builds.
var version = "dev"

func main() {
	// GUI toolkits require the main OS thread; pin it before anything migrates.
	runtime.LockOSThread()

	var (
		addr         = flag.String("addr", "127.0.0.1:0", "loopback address to bind (host:port; 0 = random port)")
		dir          = flag.String("dir", "", "data directory for the vault (default: next to the binary)")
		browser      = flag.Bool("browser", false, "open the UI in a browser window instead of a native app window")
		plainBrowser = flag.Bool("plain-browser", false, "open your default browser (implies --browser)")
		noWindow     = flag.Bool("no-window", false, "serve only; open no window (use the printed URL yourself)")
		noBrowse     = flag.Bool("no-browser", false, "alias of --no-window")
	)
	flag.Parse()

	dataDir, err := resolveDataDir(*dir)
	if err != nil {
		log.Fatalf("PortaSSH: %v", err)
	}
	vaultPath := filepath.Join(dataDir, "portassh.vault")
	hostKeysPath := filepath.Join(dataDir, "known_hosts")
	prefsPath := filepath.Join(dataDir, "portassh.prefs.json")

	v := vault.New(vaultPath)
	srv := server.New(v, hostKeysPath, prefsPath)

	// Bind explicitly so we can refuse anything but loopback.
	host, _, _ := net.SplitHostPort(*addr)
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		log.Fatalf("PortaSSH: refusing to bind to non-loopback address %q", *addr)
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("PortaSSH: cannot bind %s: %v", *addr, err)
	}

	url := fmt.Sprintf("http://%s/#%s", ln.Addr().String(), srv.Token())

	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	banner(vaultPath, ln.Addr().String(), url)

	go func() {
		if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("PortaSSH: server error: %v", err)
		}
	}()

	shutdown := func() {
		v.Lock()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}

	// Ctrl-C / SIGTERM: lock the vault and exit from any mode.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		fmt.Println("\nPortaSSH: locking vault and shutting down…")
		shutdown()
		os.Exit(0)
	}()

	useBrowser := *browser || *plainBrowser
	headless := *noWindow || *noBrowse

	switch {
	case headless:
		fmt.Println("  Serving only (--no-window). Press Ctrl-C to quit.")
		select {} // wait for the signal handler

	case useBrowser:
		openInBrowser(url, dataDir, *plainBrowser)
		select {}

	case hasNativeWindow():
		// Native app window on the main thread; returns when the user closes it.
		if err := openWindow("PortaSSH", url); err != nil {
			log.Printf("PortaSSH: %v — opening a browser instead.", err)
			openInBrowser(url, dataDir, false)
			select {}
		}
		shutdown()

	default:
		// Built with -tags nowindow: no native window available.
		openInBrowser(url, dataDir, *plainBrowser)
		select {}
	}
}

// openInBrowser opens the UI in a browser: an isolated, extension-free Chromium
// window by default, or the user's default browser when plain is set (or no
// Chromium-family browser is found).
func openInBrowser(url, dataDir string, plain bool) {
	profileDir := filepath.Join(dataDir, "browser-profile")
	time.AfterFunc(300*time.Millisecond, func() {
		if plain || !launchIsolatedApp(url, profileDir) {
			if !plain {
				log.Printf("PortaSSH: no Chromium-family browser found — opening your default browser. " +
					"Note: browser extensions could observe this page.")
			}
			openBrowser(url)
		}
	})
}

// resolveDataDir picks where the vault lives. Default is the directory holding
// the executable — so the vault travels with the binary on a USB stick. Falls
// back to the current working directory if the exe path can't be determined.
func resolveDataDir(override string) (string, error) {
	if override != "" {
		abs, err := filepath.Abs(override)
		if err != nil {
			return "", err
		}
		return abs, os.MkdirAll(abs, 0o700)
	}
	exe, err := os.Executable()
	if err == nil {
		if resolved, lerr := filepath.EvalSymlinks(exe); lerr == nil {
			exe = resolved
		}
		dir := filepath.Dir(exe)
		// Inside a macOS .app bundle the binary lives at
		// PortaSSH.app/Contents/MacOS/portassh — put the vault next to the .app
		// (e.g. on the USB stick) rather than hidden inside the bundle.
		if i := strings.Index(dir, ".app/Contents/MacOS"); i >= 0 {
			appDir := dir[:i+len(".app")] // …/PortaSSH.app
			return filepath.Dir(appDir), nil
		}
		return dir, nil
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return wd, nil
}

func banner(vaultPath, addr, url string) {
	line := "────────────────────────────────────────────────────────"
	fmt.Println()
	fmt.Printf("  ⌘  PortaSSH %s\n", version)
	fmt.Println(line)
	fmt.Printf("  Vault : %s\n", vaultPath)
	fmt.Printf("  Serve : http://%s  (loopback only)\n", addr)
	fmt.Println(line)
	fmt.Println("  Open this URL if your browser didn't launch:")
	fmt.Printf("  %s\n", url)
	fmt.Println(line)
	fmt.Println("  Press Ctrl-C to lock the vault and quit.")
	fmt.Println()
}

// openBrowser tries to open the default browser for the running OS.
func openBrowser(url string) {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd, args = "open", []string{url}
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default: // linux, bsd, …
		cmd, args = "xdg-open", []string{url}
	}
	if err := exec.Command(cmd, args...).Start(); err != nil {
		log.Printf("PortaSSH: could not open browser automatically (%v). Open the URL above manually.", err)
	}
}
