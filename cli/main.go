// Command nanana is the CLI for the nanana.lat webhook inspector and tunnel.
package main

import (
	"os"

	"github.com/erostalevi/nanana/cli/internal/cli"
)

// version is set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

func main() {
	os.Exit(cli.Execute(version, os.Args[1:]))
}
