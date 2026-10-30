//go:build js

package main

import "syscall/js"

func init() {
	chaosReplaySpeed = func() int {
		bridge := js.Global().Get("chaosReplay")
		if bridge.IsUndefined() || bridge.IsNull() { return 1 }
		speed := bridge.Call("speed").Float()
		if speed > 1 { return 8 }
		return 1
	}
}
