//go:build linux

package main

import (
	"embed"
	"fmt"
)

// iconFS holds the app icon, baked into the binary. Unlike macOS (.icns in the
// .app bundle) and Windows (resource in the .exe), Linux has no bundle format
// to carry an icon, so PortaSSH ships its own and hands it to GTK at runtime.
//
//go:embed assets/icon/icon-16.png assets/icon/icon-32.png assets/icon/icon-48.png
//go:embed assets/icon/icon-64.png assets/icon/icon-128.png assets/icon/icon-256.png
//go:embed assets/icon/icon-512.png assets/icon/icon.svg
var iconFS embed.FS

// iconSizes are the embedded PNG sizes, smallest first.
var iconSizes = []int{16, 32, 48, 64, 128, 256, 512}

// iconPNG returns the embedded PNG for one of iconSizes.
func iconPNG(size int) ([]byte, error) {
	return iconFS.ReadFile(fmt.Sprintf("assets/icon/icon-%d.png", size))
}

// iconSVG returns the embedded scalable icon.
func iconSVG() ([]byte, error) {
	return iconFS.ReadFile("assets/icon/icon.svg")
}
