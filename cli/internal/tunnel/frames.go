// Package tunnel implements the nanana tunnel client protocol (docs/API.md "Tunnel").
package tunnel

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ChunkSize is the maximum body bytes per binary frame.
const ChunkSize = 64 * 1024

// MaxResponseBody is the largest response relayed through the tunnel.
const MaxResponseBody = 10 * 1024 * 1024

// Headers carries HTTP headers where each value is a string or an array.
type Headers map[string][]string

func (h *Headers) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	out := make(Headers, len(raw))
	for k, v := range raw {
		var s string
		if json.Unmarshal(v, &s) == nil {
			out[k] = []string{s}
			continue
		}
		var arr []string
		if err := json.Unmarshal(v, &arr); err != nil {
			return fmt.Errorf("header %q: want string or string array", k)
		}
		out[k] = arr
	}
	*h = out
	return nil
}

func (h Headers) MarshalJSON() ([]byte, error) {
	out := make(map[string]interface{}, len(h))
	for k, v := range h {
		if len(v) == 1 {
			out[k] = v[0]
		} else {
			out[k] = v
		}
	}
	return json.Marshal(out)
}

// Get returns the first value of a header (case-insensitive).
func (h Headers) Get(name string) string {
	for k, v := range h {
		if strings.EqualFold(k, name) && len(v) > 0 {
			return v[0]
		}
	}
	return ""
}

// Message is any JSON text frame (union of all fields).
type Message struct {
	T string `json:"t"`

	// hello
	Protocol   int    `json:"protocol,omitempty"`
	Sub        string `json:"sub,omitempty"`
	URL        string `json:"url,omitempty"`
	Dashboard  string `json:"dashboard,omitempty"`
	ServerTime string `json:"serverTime,omitempty"`

	// req / res / err
	ID      string  `json:"id,omitempty"`
	Method  string  `json:"method,omitempty"`
	Path    string  `json:"path,omitempty"`
	Headers Headers `json:"headers,omitempty"`
	BodyLen int     `json:"bodyLen"`
	Replay  bool    `json:"replay,omitempty"`
	Status  int     `json:"status,omitempty"`

	// err
	Code string `json:"code,omitempty"`
	Msg  string `json:"msg,omitempty"`

	// bye
	Reason string `json:"reason,omitempty"`
}

// ParseUUID converts a canonical UUID string to its 16 raw bytes.
func ParseUUID(s string) ([16]byte, error) {
	var id [16]byte
	h := strings.ReplaceAll(s, "-", "")
	if len(h) != 32 {
		return id, errors.New("invalid uuid: " + s)
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return id, err
	}
	copy(id[:], b)
	return id, nil
}

// FormatUUID renders 16 bytes as a canonical lowercase UUID.
func FormatUUID(id [16]byte) string {
	h := hex.EncodeToString(id[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// EncodeBinary builds a binary frame: 16 id bytes followed by the chunk.
func EncodeBinary(id [16]byte, chunk []byte) []byte {
	b := make([]byte, 16+len(chunk))
	copy(b, id[:])
	copy(b[16:], chunk)
	return b
}

// DecodeBinary splits a binary frame into id and chunk.
func DecodeBinary(b []byte) (id [16]byte, chunk []byte, err error) {
	if len(b) < 16 {
		return id, nil, errors.New("binary frame shorter than 16 bytes")
	}
	copy(id[:], b[:16])
	return id, b[16:], nil
}
