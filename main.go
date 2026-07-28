// PortaSSH — a portable, encrypted SSH client you can carry on a USB stick.
//
// It stores your SSH credentials in a single AES-256-GCM encrypted vault file
// that lives next to the binary, and serves a modern web-based terminal UI on
// the loopback interface. No installation, no background services, nothing
// written outside its own directory.
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
	"syscall"
	"time"

	"portassh/internal/server"
	"portassh/internal/vault"
)

func main() {
	var (
		addr     = flag.String("addr", "127.0.0.1:0", "loopback address to bind (host:port; 0 = random port)")
		dir      = flag.String("dir", "", "data directory for the vault (default: next to the binary)")
		noBrowse     = flag.Bool("no-browser", false, "do not auto-open the browser")
		plainBrowser = flag.Bool("plain-browser", false, "open your default browser instead of an isolated extension-free window")
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

	if !*noBrowse {
		profileDir := filepath.Join(dataDir, "browser-profile")
		// Give the listener a beat, then open the tokenized URL — preferring an
		// isolated, extension-free Chromium window; falling back to the default
		// browser (where extensions may be active) only if none is found.
		time.AfterFunc(300*time.Millisecond, func() {
			if *plainBrowser || !launchIsolatedApp(url, profileDir) {
				if !*plainBrowser {
					log.Printf("PortaSSH: no Chromium-family browser found — opening your default browser. " +
						"Note: browser extensions could observe this page. Consider installing Chrome/Edge/Chromium for an isolated window.")
				}
				openBrowser(url)
			}
		})
	}

	// Graceful shutdown on Ctrl-C / SIGTERM; lock the vault on the way out.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	fmt.Println("\nPortaSSH: locking vault and shutting down…")
	v.Lock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
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
		return filepath.Dir(exe), nil
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
	fmt.Println("  ⌘  PortaSSH")
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
