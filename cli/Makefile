VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
export CGO_ENABLED=0

PLATFORMS := darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64

.PHONY: build test build-all clean

build:
	go build -trimpath -ldflags "$(LDFLAGS)" -o dist/nanana .

test:
	CGO_ENABLED=1 go test -race ./...

# Cross-compile every release target with plain `go build` (no goreleaser needed).
build-all:
	@mkdir -p dist
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; ext=""; [ $$os = windows ] && ext=".exe"; \
		out=dist/nanana_$${os}_$${arch}$$ext; \
		echo "building $$out"; \
		GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o $$out . || exit 1; \
	done

clean:
	go clean
	rm -f dist/nanana dist/nanana_*
