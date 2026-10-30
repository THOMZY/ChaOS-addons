//go:build js

package main

import (
	"encoding/json"
	lua "github.com/yuin/gopher-lua"
	"strings"
	"syscall/js"
	"time"
)

var chaosPresentationPending bool
var chaosResidentChars = map[int]string{}

type chaosResidentChar struct {
	char *Char
	info CharGlobalInfo
}

var chaosCharCache = map[int]map[string]chaosResidentChar{}

func chaosRestoreChar(pn int, def string) {
	b := chaosSessionBridge()
	if b.IsUndefined() || b.IsNull() {
		return
	}
	if len(sys.chars[pn]) > 0 && sys.cgi[pn].def == def && sys.cgi[pn].states != nil {
		return
	}
	if cached, ok := chaosCharCache[pn][def]; ok {
		sys.cgi[pn] = cached.info
		sys.chars[pn] = []*Char{cached.char}
		chaosResidentChars[pn] = def
	}
}

// A Go goroutine is not another browser thread: decoding the entire track for
// the desktop RAM swap freezes presentation. Stream small audio chunks instead.
func chaosAllowBgmPredecode() bool { return false }

// Quick-match params reset their "existed" flag between launches. Only reuse
// a slot that finished loading in this resident session, never a partial load.
func chaosCanReuseChar(pn int, def string) bool {
	b := chaosSessionBridge()
	return !b.IsUndefined() && !b.IsNull() && chaosResidentChars[pn] == def && sys.cgi[pn].states != nil
}
func chaosRememberChar(pn int) {
	b := chaosSessionBridge()
	if !b.IsUndefined() && !b.IsNull() {
		chaosResidentChars[pn] = sys.cgi[pn].def
		if chaosCharCache[pn] == nil {
			chaosCharCache[pn] = map[string]chaosResidentChar{}
		}
		if _, exists := chaosCharCache[pn][sys.cgi[pn].def]; !exists {
			chaosCharCache[pn][sys.cgi[pn].def] = chaosResidentChar{sys.chars[pn][0], sys.cgi[pn]}
		}
	}
}

func chaosSessionBridge() js.Value { return js.Global().Get("chaosSession") }

func chaosPollSession() {
	b := chaosSessionBridge()
	if b.IsUndefined() || b.IsNull() {
		return
	}
	if b.Get("stop").Bool() {
		sys.esc = true
		sys.endMatch = true
	}
	b.Set("polls", b.Get("polls").Int()+1)
	b.Set("ticks", sys.matchTime)
}

func chaosRegisterSession(l *lua.LState) {
	luaRegister(l, "chaosLastCharRef", func(l *lua.LState) int { l.Push(lua.LNumber(len(sys.sel.charlist) - 1)); return 1 })
	luaRegister(l, "chaosLastStageRef", func(l *lua.LState) int { l.Push(lua.LNumber(len(sys.sel.stagelist))); return 1 })
	luaRegister(l, "chaosSessionFinished", func(*lua.LState) int {
		b := chaosSessionBridge()
		if !b.IsUndefined() && !b.IsNull() {
			sys.bgm.Stop()
			b.Call("finished")
		}
		return 0
	})
	luaRegister(l, "chaosSessionNext", func(l *lua.LState) int {
		b := chaosSessionBridge()
		if b.IsUndefined() || b.IsNull() {
			l.Push(lua.LBool(false))
			return 1
		}
		for {
			pending := b.Get("pending")
			if pending.Type() == js.TypeString && pending.String() != "" {
				var args []string
				if err := json.Unmarshal([]byte(pending.String()), &args); err != nil {
					l.RaiseError("invalid session request: %v", err)
					return 0
				}
				b.Set("pending", "")
				sys.cmdFlags = map[string]string{"-chaos-session": ""}
				for i := 0; i < len(args); i++ {
					if strings.HasPrefix(args[i], "-") {
						key := args[i]
						value := ""
						if i+1 < len(args) {
							i++
							value = args[i]
						}
						sys.cmdFlags[key] = value
					}
				}
				sys.esc = false
				sys.endMatch = false
				sys.paused = false
				sys.rollback = RollbackSystem{}
				sys.preMatchTime = 0
				sys.statsLog.reset()
				sys.resetFrameTime()
				l.Push(lua.LBool(true))
				return 1
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
}

func chaosArmPresentation() {
	b := chaosSessionBridge()
	chaosPresentationPending = !b.IsUndefined() && !b.IsNull()
	if chaosPresentationPending {
		sys.frameSkip = false
		b.Call("phase", "setup")
	}
}

// The first actual fight draw has uploaded its textures. Finish it once, yield
// through a browser paint, then reset the wall clock before simulation resumes.
func chaosPresentFrame() {
	if !chaosPresentationPending {
		return
	}
	chaosPresentationPending = false
	b := chaosSessionBridge()
	b.Call("phase", "gpu-begin")
	if r, ok := gfx.(*Renderer_WebGL); ok {
		r.glc("finish")
	}
	b.Call("phase", "gpu-done")
	b.Set("presented", false)
	b.Call("present")
	for !b.Get("presented").Bool() && !b.Get("stop").Bool() {
		time.Sleep(time.Millisecond)
	}
	sys.resetFrameTime()
}

func chaosCharacterLoaded(reused bool) {
	b := chaosSessionBridge()
	if b.IsUndefined() || b.IsNull() {
		return
	}
	key := "loads"
	if reused {
		key = "reuses"
	}
	b.Set(key, b.Get(key).Int()+1)
}
