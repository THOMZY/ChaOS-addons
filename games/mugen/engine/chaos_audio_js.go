//go:build js

package main

import "syscall/js"

var chaosAudioRevision = -1

// Poll on the engine thread, never from a JS callback while the audio mixer is
// locked. WAV gain is read by the normalizer; BGM also needs its volume control
// refreshed for music that is already playing.
func chaosPollAudio() {
	bridge := js.Global().Get("chaosAudio")
	if bridge.IsUndefined() || bridge.IsNull() { return }
	revision := bridge.Get("revision").Int()
	if revision == chaosAudioRevision { return }
	chaosAudioRevision = revision
	sys.cfg.Sound.BGMVolume = int(Clamp(int32(bridge.Get("bgm").Int()), 0, 100))
	sys.cfg.Sound.WavVolume = int(Clamp(int32(bridge.Get("sfx").Int()), 0, 100))
	sys.bgm.UpdateVolume()
	bridge.Set("appliedRevision", revision)
	bridge.Set("appliedBgm", sys.cfg.Sound.BGMVolume)
	bridge.Set("appliedSfx", sys.cfg.Sound.WavVolume)
}
