package cli

import (
	"time"

	"github.com/erostalevi/nanana/cli/internal/tunnel"
)

func tunnelEvent(t time.Time, method, path string, status int, lat time.Duration, replay bool, errCode string) tunnel.Event {
	return tunnel.Event{Time: t, Method: method, Path: path, Status: status, Latency: lat, Replay: replay, ErrCode: errCode, ErrMsg: errCode}
}
