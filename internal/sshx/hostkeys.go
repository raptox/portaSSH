package sshx

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// HostKeyStore implements trust-on-first-use (TOFU) host-key verification,
// persisting accepted keys to a known_hosts file that travels with the vault.
//
// On first contact with a host we record its key and accept it. On subsequent
// connections a mismatch is treated as a hard error (possible MITM), matching
// OpenSSH's StrictHostKeyChecking behaviour.
type HostKeyStore struct {
	path string
	mu   sync.Mutex
}

// NewHostKeyStore returns a store backed by the given known_hosts file path.
func NewHostKeyStore(path string) *HostKeyStore {
	return &HostKeyStore{path: path}
}

// Callback returns an ssh.HostKeyCallback implementing TOFU semantics.
func (h *HostKeyStore) Callback() ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		h.mu.Lock()
		defer h.mu.Unlock()

		// Ensure file exists so knownhosts.New doesn't fail.
		if _, err := os.Stat(h.path); os.IsNotExist(err) {
			if dir := filepath.Dir(h.path); dir != "" {
				_ = os.MkdirAll(dir, 0o700)
			}
			if f, err := os.OpenFile(h.path, os.O_CREATE, 0o600); err == nil {
				_ = f.Close()
			}
		}

		verify, err := knownhosts.New(h.path)
		if err != nil {
			return fmt.Errorf("load known_hosts: %w", err)
		}

		err = verify(hostname, remote, key)
		if err == nil {
			return nil // known and matching
		}

		var keyErr *knownhosts.KeyError
		if ok := asKeyError(err, &keyErr); ok {
			if len(keyErr.Want) > 0 {
				// We have a stored key that does NOT match — refuse.
				return fmt.Errorf("host key mismatch for %s: possible man-in-the-middle attack", hostname)
			}
			// Unknown host — trust on first use and record it.
			return h.add(hostname, remote, key)
		}
		return err
	}
}

// add appends a host key to the known_hosts file.
func (h *HostKeyStore) add(hostname string, remote net.Addr, key ssh.PublicKey) error {
	f, err := os.OpenFile(h.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	addresses := []string{knownhosts.Normalize(hostname)}
	if remote != nil {
		if norm := knownhosts.Normalize(remote.String()); norm != addresses[0] {
			addresses = append(addresses, norm)
		}
	}
	line := knownhosts.Line(addresses, key)
	if _, err := f.WriteString(line + "\n"); err != nil {
		return err
	}
	return nil
}

func asKeyError(err error, target **knownhosts.KeyError) bool {
	if ke, ok := err.(*knownhosts.KeyError); ok {
		*target = ke
		return true
	}
	return false
}
