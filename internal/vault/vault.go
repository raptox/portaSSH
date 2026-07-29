// Package vault implements PortaSSH's encrypted credential store.
//
// The vault file is a single self-contained blob that lives next to the
// binary (e.g. on a USB stick). It is encrypted with AES-256-GCM using a key
// derived from the user's master password via Argon2id. The plaintext — and
// the derived key — only ever exist in memory while the vault is unlocked, and
// are zeroed on lock.
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

// magic identifies a PortaSSH vault file and encodes the format version.
var magic = [8]byte{'P', 'O', 'R', 'T', 'A', 'S', 'S', 'H'}

const formatVersion uint16 = 1

// Argon2id parameters. These are deliberately on the strong side; a USB-borne
// vault may be attacked offline if the stick is lost, so we spend real work.
const (
	argonTime    = 3         // iterations
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32 // AES-256
	saltLen      = 16
)

// ErrLocked is returned when an operation requires an unlocked vault.
var ErrLocked = errors.New("vault is locked")

// ErrBadPassword is returned when the master password fails to decrypt.
var ErrBadPassword = errors.New("incorrect master password")

// AuthMethod distinguishes how a credential authenticates.
type AuthMethod string

const (
	AuthPassword AuthMethod = "password"
	AuthKey      AuthMethod = "key"
	AuthAgent    AuthMethod = "agent"
)

// Credential is a single stored SSH target.
type Credential struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Host       string     `json:"host"`
	Port       int        `json:"port"`
	User       string     `json:"user"`
	Auth       AuthMethod `json:"auth"`
	Password   string     `json:"password,omitempty"`   // used when Auth == password
	PrivateKey string     `json:"privateKey,omitempty"` // PEM, used when Auth == key
	Passphrase string     `json:"passphrase,omitempty"` // for encrypted PrivateKey
	Tags       []string   `json:"tags,omitempty"`
	Color      string     `json:"color,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// data is the JSON document that gets encrypted.
type data struct {
	Credentials []Credential `json:"credentials"`
}

// Vault is a thread-safe encrypted credential store backed by a file.
type Vault struct {
	path string

	mu   sync.RWMutex
	key  []byte // derived Argon2id key; nil when locked
	salt []byte // KDF salt (persisted, not secret)
	data data   // decrypted contents; empty when locked
}

// New returns a Vault bound to the given file path. The file need not exist yet.
func New(path string) *Vault {
	return &Vault{path: path}
}

// Path returns the vault file location.
func (v *Vault) Path() string { return v.path }

// Exists reports whether the vault file is present on disk.
func (v *Vault) Exists() bool {
	_, err := os.Stat(v.path)
	return err == nil
}

// IsUnlocked reports whether the vault currently holds a key in memory.
func (v *Vault) IsUnlocked() bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return v.key != nil
}

// Create initialises a brand new vault with the given master password.
// It fails if the vault file already exists.
func (v *Vault) Create(password string) error {
	if v.Exists() {
		return errors.New("vault already exists")
	}
	if len(password) < 1 {
		return errors.New("master password must not be empty")
	}
	v.mu.Lock()
	defer v.mu.Unlock()

	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	v.salt = salt
	v.key = argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	v.data = data{Credentials: []Credential{}}
	return v.persistLocked()
}

// Unlock decrypts the vault file using the master password.
func (v *Vault) Unlock(password string) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	raw, err := os.ReadFile(v.path)
	if err != nil {
		return err
	}
	salt, ciphertext, err := parseFile(raw)
	if err != nil {
		return err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	plain, err := decrypt(key, ciphertext)
	if err != nil {
		wipe(key)
		return ErrBadPassword
	}
	var d data
	if err := json.Unmarshal(plain, &d); err != nil {
		wipe(key)
		wipe(plain)
		return fmt.Errorf("corrupt vault: %w", err)
	}
	wipe(plain)

	v.salt = salt
	v.key = key
	v.data = d
	return nil
}

// Lock wipes the in-memory key and decrypted data.
func (v *Vault) Lock() {
	v.mu.Lock()
	defer v.mu.Unlock()
	wipe(v.key)
	v.key = nil
	for i := range v.data.Credentials {
		wipeString(&v.data.Credentials[i].Password)
		wipeString(&v.data.Credentials[i].PrivateKey)
		wipeString(&v.data.Credentials[i].Passphrase)
	}
	v.data = data{}
}

// ChangePassword re-derives the key from a new password and rewrites the file.
func (v *Vault) ChangePassword(current, next string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.key == nil {
		return ErrLocked
	}
	// Verify current password by re-deriving against stored salt.
	check := argon2.IDKey([]byte(current), v.salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if subtle.ConstantTimeCompare(check, v.key) != 1 {
		wipe(check)
		return ErrBadPassword
	}
	wipe(check)

	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	newKey := argon2.IDKey([]byte(next), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	wipe(v.key)
	v.key = newKey
	v.salt = salt
	return v.persistLocked()
}

// List returns a copy of all stored credentials with secrets stripped, safe to
// send to the UI. Secrets are only ever transmitted at connect time server-side.
func (v *Vault) List() ([]Credential, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if v.key == nil {
		return nil, ErrLocked
	}
	out := make([]Credential, len(v.data.Credentials))
	for i, c := range v.data.Credentials {
		// Signal to the UI whether secrets exist without revealing them.
		c.Password = ""
		c.PrivateKey = ""
		c.Passphrase = ""
		out[i] = c
	}
	return out, nil
}

// Get returns the full credential including secrets. Used server-side to connect.
func (v *Vault) Get(id string) (Credential, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if v.key == nil {
		return Credential{}, ErrLocked
	}
	for _, c := range v.data.Credentials {
		if c.ID == id {
			return c, nil
		}
	}
	return Credential{}, errors.New("credential not found")
}

// Upsert adds or updates a credential and persists the vault.
func (v *Vault) Upsert(c Credential) (Credential, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.key == nil {
		return Credential{}, ErrLocked
	}
	now := time.Now().UTC()
	if c.Port == 0 {
		c.Port = 22
	}
	if c.ID == "" {
		c.ID = newID()
		c.CreatedAt = now
		c.UpdatedAt = now
		v.data.Credentials = append(v.data.Credentials, c)
	} else {
		found := false
		for i, existing := range v.data.Credentials {
			if existing.ID == c.ID {
				c.CreatedAt = existing.CreatedAt
				c.UpdatedAt = now
				// Preserve secrets if the caller left them blank (UI never
				// receives them, so a blank field means "unchanged").
				if c.Password == "" {
					c.Password = existing.Password
				}
				if c.PrivateKey == "" {
					c.PrivateKey = existing.PrivateKey
				}
				if c.Passphrase == "" {
					c.Passphrase = existing.Passphrase
				}
				v.data.Credentials[i] = c
				found = true
				break
			}
		}
		if !found {
			return Credential{}, errors.New("credential not found")
		}
	}
	if err := v.persistLocked(); err != nil {
		return Credential{}, err
	}
	// Return a secret-stripped copy.
	c.Password, c.PrivateKey, c.Passphrase = "", "", ""
	return c, nil
}

// Delete removes a credential by ID and persists.
func (v *Vault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.key == nil {
		return ErrLocked
	}
	for i, c := range v.data.Credentials {
		if c.ID == id {
			v.data.Credentials = append(v.data.Credentials[:i], v.data.Credentials[i+1:]...)
			return v.persistLocked()
		}
	}
	return errors.New("credential not found")
}

// Reorder rearranges the stored credentials to match the given ID order and
// persists the vault. IDs not present are ignored; any existing credentials
// missing from the list keep their relative order and are placed at the end.
func (v *Vault) Reorder(ids []string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.key == nil {
		return ErrLocked
	}
	pos := make(map[string]int, len(ids))
	for i, id := range ids {
		pos[id] = i
	}
	sort.SliceStable(v.data.Credentials, func(a, b int) bool {
		pa, oka := pos[v.data.Credentials[a].ID]
		pb, okb := pos[v.data.Credentials[b].ID]
		if oka && okb {
			return pa < pb
		}
		return oka && !okb // known ids sort before unknown ones
	})
	return v.persistLocked()
}

// --- internal helpers ---

// persistLocked encrypts and atomically writes the vault. Caller holds v.mu.
func (v *Vault) persistLocked() error {
	if v.key == nil {
		return ErrLocked
	}
	plain, err := json.Marshal(v.data)
	if err != nil {
		return err
	}
	defer wipe(plain)

	ciphertext, err := encrypt(v.key, plain)
	if err != nil {
		return err
	}
	blob := buildFile(v.salt, ciphertext)

	if dir := filepath.Dir(v.path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	tmp := v.path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, v.path)
}

// File layout:
//   magic[8] | version[2] | saltLen[2] | salt[saltLen] | ciphertext[...]
func buildFile(salt, ciphertext []byte) []byte {
	buf := make([]byte, 0, 12+len(salt)+len(ciphertext))
	buf = append(buf, magic[:]...)
	buf = binary.BigEndian.AppendUint16(buf, formatVersion)
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(salt)))
	buf = append(buf, salt...)
	buf = append(buf, ciphertext...)
	return buf
}

func parseFile(raw []byte) (salt, ciphertext []byte, err error) {
	if len(raw) < 12 {
		return nil, nil, errors.New("file too short to be a vault")
	}
	if [8]byte(raw[0:8]) != magic {
		return nil, nil, errors.New("not a PortaSSH vault file")
	}
	ver := binary.BigEndian.Uint16(raw[8:10])
	if ver != formatVersion {
		return nil, nil, fmt.Errorf("unsupported vault version %d", ver)
	}
	sl := int(binary.BigEndian.Uint16(raw[10:12]))
	if len(raw) < 12+sl {
		return nil, nil, errors.New("corrupt vault header")
	}
	salt = raw[12 : 12+sl]
	ciphertext = raw[12+sl:]
	return salt, ciphertext, nil
}

func encrypt(key, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	// Output: nonce || sealed
	return gcm.Seal(nonce, nonce, plain, magic[:]), nil
}

func decrypt(key, blob []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(blob) < ns {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ct := blob[:ns], blob[ns:]
	return gcm.Open(nil, nonce, ct, magic[:])
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	const hexdigits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hexdigits[c>>4]
		out[i*2+1] = hexdigits[c&0x0f]
	}
	return string(out)
}

func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func wipeString(s *string) {
	// Go strings are immutable; we can't zero the backing array safely, but we
	// can drop the reference so the GC can reclaim it.
	*s = ""
}
