// Package server exposes PortaSSH's local HTTP + WebSocket API and serves the
// embedded web UI. It binds only to the loopback interface and gates every
// request behind a per-launch session token, so nothing else on the machine
// (or network) can reach the vault.
package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/gorilla/websocket"

	"portassh/internal/sshx"
	"portassh/internal/vault"
)

// Server holds shared state for the running app.
type Server struct {
	vault     *vault.Vault
	hostKeys  *sshx.HostKeyStore
	token     string
	mux       *http.ServeMux
	upgrader  websocket.Upgrader
	loopbacks map[string]bool

	prefsPath string     // UI preferences file (non-secret) beside the vault
	prefsMu   sync.Mutex // guards prefs file writes
}

// New constructs a Server. token gates all requests; hostKeysPath stores TOFU
// keys; prefsPath persists non-secret UI preferences (theme, font, colors).
func New(v *vault.Vault, hostKeysPath, prefsPath string) *Server {
	s := &Server{
		vault:     v,
		hostKeys:  sshx.NewHostKeyStore(hostKeysPath),
		prefsPath: prefsPath,
		token:     newToken(),
		mux:       http.NewServeMux(),
		upgrader: websocket.Upgrader{
			// Only same-origin (our own loopback page) may open sockets.
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				if origin == "" {
					return true // non-browser client
				}
				return strings.Contains(origin, "127.0.0.1") || strings.Contains(origin, "localhost")
			},
		},
	}
	s.routes()
	return s
}

// Token returns the per-launch session token.
func (s *Server) Token() string { return s.token }

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	// Static UI (embedded). The SPA reads the token from the URL fragment.
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("embed web: %v", err)
	}
	s.mux.Handle("/", http.FileServer(http.FS(sub)))

	// API — all gated behind the token.
	s.mux.HandleFunc("/api/vault/status", s.auth(s.handleStatus))
	s.mux.HandleFunc("/api/vault/create", s.auth(s.handleCreate))
	s.mux.HandleFunc("/api/vault/unlock", s.auth(s.handleUnlock))
	s.mux.HandleFunc("/api/vault/lock", s.auth(s.handleLock))
	s.mux.HandleFunc("/api/vault/password", s.auth(s.handleChangePassword))
	s.mux.HandleFunc("/api/prefs", s.auth(s.handlePrefs))
	s.mux.HandleFunc("/api/creds", s.auth(s.handleCreds))
	s.mux.HandleFunc("/api/creds/", s.auth(s.handleCredByID))
	s.mux.HandleFunc("/api/ws", s.auth(s.handleWS))
}

// auth wraps a handler, requiring a valid token via header or query param, and
// enforces that the request came from loopback.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLoopback(r.RemoteAddr) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		tok := r.Header.Get("X-PortaSSH-Token")
		if tok == "" {
			tok = r.URL.Query().Get("token")
		}
		if subtle.ConstantTimeCompare([]byte(tok), []byte(s.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// --- vault handlers ---

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"exists":   s.vault.Exists(),
		"unlocked": s.vault.IsUnlocked(),
		"path":     s.vault.Path(),
	})
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var body struct{ Password string `json:"password"` }
	if !decode(w, r, &body) {
		return
	}
	if err := s.vault.Create(body.Password); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"unlocked": true})
}

func (s *Server) handleUnlock(w http.ResponseWriter, r *http.Request) {
	var body struct{ Password string `json:"password"` }
	if !decode(w, r, &body) {
		return
	}
	if err := s.vault.Unlock(body.Password); err != nil {
		writeErr(w, http.StatusUnauthorized, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"unlocked": true})
}

func (s *Server) handleLock(w http.ResponseWriter, r *http.Request) {
	s.vault.Lock()
	writeJSON(w, http.StatusOK, map[string]any{"unlocked": false})
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Current string `json:"current"`
		Next    string `json:"next"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.vault.ChangePassword(body.Current, body.Next); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

var errInvalidJSON = errors.New("invalid JSON")

// --- preferences (non-secret UI settings, persisted beside the vault) ---

// handlePrefs reads or writes the UI preferences blob. Prefs are not secret
// (theme, font, terminal colors), so they live in a plaintext JSON file that
// travels with the vault — surviving restarts regardless of the random port.
func (s *Server) handlePrefs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		data, err := os.ReadFile(s.prefsPath)
		if err != nil || len(data) == 0 || !json.Valid(data) {
			data = []byte("{}")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	case http.MethodPut:
		body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		if !json.Valid(body) {
			writeErr(w, http.StatusBadRequest, errInvalidJSON)
			return
		}
		s.prefsMu.Lock()
		defer s.prefsMu.Unlock()
		if dir := filepath.Dir(s.prefsPath); dir != "" {
			_ = os.MkdirAll(dir, 0o700)
		}
		tmp := s.prefsPath + ".tmp"
		if err := os.WriteFile(tmp, body, 0o600); err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		if err := os.Rename(tmp, s.prefsPath); err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// --- credential handlers ---

func (s *Server) handleCreds(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list, err := s.vault.List()
		if err != nil {
			writeErr(w, http.StatusForbidden, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	case http.MethodPost:
		var c vault.Credential
		if !decode(w, r, &c) {
			return
		}
		saved, err := s.vault.Upsert(c)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, saved)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleCredByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/creds/")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := s.vault.Delete(id); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// --- websocket SSH handler ---

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))

	cred, err := s.vault.Get(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	// From here on, errors are reported over the socket.
	client, err := sshx.Dial(cred, s.hostKeys.Callback())
	if err != nil {
		sendWSError(conn, err.Error())
		conn.Close()
		return
	}
	sess, err := sshx.NewSession(client, conn, cols, rows)
	if err != nil {
		sendWSError(conn, err.Error())
		client.Close()
		conn.Close()
		return
	}
	sess.Run()
}

func sendWSError(conn *websocket.Conn, msg string) {
	b, _ := json.Marshal(sshx.Message{Type: "error", Data: msg})
	_ = conn.WriteMessage(websocket.TextMessage, b)
}

// --- helpers ---

func newToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}
