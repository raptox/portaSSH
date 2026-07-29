//go:build linux

package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// appID is the short name PortaSSH identifies itself with on Linux: the Wayland
// app_id / X11 WM_CLASS, the .desktop file's basename, and the icon name. All
// three must agree for a desktop shell to find the icon.
const appID = "portassh"

var (
	installEntry = flag.Bool("install-desktop-entry", false,
		"Linux: install a desktop entry + icons under ~/.local/share (needed for the app icon on Wayland)")
	removeEntry = flag.Bool("remove-desktop-entry", false,
		"Linux: remove what --install-desktop-entry created")
)

// handleDesktopEntryFlags runs the desktop-entry flags, if any were given, and
// reports whether PortaSSH should exit instead of starting up.
func handleDesktopEntryFlags() bool {
	switch {
	case *installEntry:
		if err := installDesktopEntry(); err != nil {
			fmt.Fprintf(os.Stderr, "PortaSSH: %v\n", err)
			os.Exit(1)
		}
		return true
	case *removeEntry:
		if err := removeDesktopEntry(); err != nil {
			fmt.Fprintf(os.Stderr, "PortaSSH: %v\n", err)
			os.Exit(1)
		}
		return true
	}
	return false
}

// installDesktopEntry writes a .desktop file and the icon theme files that
// GNOME/KDE/COSMIC and friends need to show PortaSSH's icon and name — under
// Wayland this is the only channel an app has to publish its icon.
//
// This is the one thing PortaSSH ever writes outside its own directory, which
// is why it only happens when explicitly asked for; --remove-desktop-entry
// takes it all back out.
func installDesktopEntry() error {
	exe, err := exePath()
	if err != nil {
		return err
	}
	dataHome, err := xdgDataHome()
	if err != nil {
		return err
	}

	var written []string
	for _, size := range iconSizes {
		png, err := iconPNG(size)
		if err != nil {
			return err
		}
		path := iconPath(dataHome, fmt.Sprintf("%dx%d", size, size), "png")
		if err := writeFile(path, png); err != nil {
			return err
		}
		written = append(written, path)
	}
	if svg, err := iconSVG(); err == nil {
		path := iconPath(dataHome, "scalable", "svg")
		if err := writeFile(path, svg); err != nil {
			return err
		}
		written = append(written, path)
	}

	entry := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=PortaSSH
GenericName=SSH Connection Manager
Comment=Portable, encrypted SSH connection manager
Exec=%s
Icon=%s
StartupWMClass=%s
Terminal=false
Categories=Network;RemoteAccess;
Keywords=SSH;Terminal;Remote;Vault;
`, execQuote(exe), appID, appID)

	desktopPath := filepath.Join(dataHome, "applications", appID+".desktop")
	if err := writeFile(desktopPath, []byte(entry)); err != nil {
		return err
	}
	written = append(written, desktopPath)

	refreshDesktopCaches(dataHome)

	fmt.Println("PortaSSH: installed desktop entry and icons —")
	for _, p := range written {
		fmt.Printf("  %s\n", p)
	}
	fmt.Printf("\n  Launching %s\n", exe)
	fmt.Println("  Remove it again with:  --remove-desktop-entry")
	fmt.Println("  (If the icon doesn't appear at once, log out and back in.)")
	return nil
}

// removeDesktopEntry deletes everything installDesktopEntry wrote.
func removeDesktopEntry() error {
	dataHome, err := xdgDataHome()
	if err != nil {
		return err
	}
	paths := []string{filepath.Join(dataHome, "applications", appID+".desktop"), iconPath(dataHome, "scalable", "svg")}
	for _, size := range iconSizes {
		paths = append(paths, iconPath(dataHome, fmt.Sprintf("%dx%d", size, size), "png"))
	}

	removed := 0
	for _, p := range paths {
		switch err := os.Remove(p); {
		case err == nil:
			removed++
		case !os.IsNotExist(err):
			return fmt.Errorf("removing %s: %w", p, err)
		}
	}
	refreshDesktopCaches(dataHome)
	fmt.Printf("PortaSSH: removed %d installed file(s) under %s\n", removed, dataHome)
	return nil
}

// iconPath is where an icon of the given theme directory ("48x48", "scalable")
// belongs in the user's hicolor icon theme.
func iconPath(dataHome, dir, ext string) string {
	return filepath.Join(dataHome, "icons", "hicolor", dir, "apps", appID+"."+ext)
}

// xdgDataHome resolves $XDG_DATA_HOME, defaulting to ~/.local/share.
func xdgDataHome() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); filepath.IsAbs(d) {
		return d, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot locate your home directory: %w", err)
	}
	return filepath.Join(home, ".local", "share"), nil
}

// exePath is the absolute, symlink-resolved path of the running binary — what
// the desktop entry has to launch.
func exePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot locate the PortaSSH binary: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe, nil
}

func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// execQuote renders a path for a desktop entry's Exec= key, which needs quoting
// as soon as the path contains spaces (a USB stick mount point easily does).
func execQuote(path string) string {
	if !strings.ContainsAny(path, ` "'\`+"`$") {
		return path
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", `$`, `\$`)
	return `"` + r.Replace(path) + `"`
}

// refreshDesktopCaches nudges the desktop's caches so the entry shows up now
// rather than at next login. Both tools are optional; failure is harmless.
func refreshDesktopCaches(dataHome string) {
	_ = exec.Command("update-desktop-database", filepath.Join(dataHome, "applications")).Run()
	_ = exec.Command("gtk-update-icon-cache", "-f", "-t", filepath.Join(dataHome, "icons", "hicolor")).Run()
}
