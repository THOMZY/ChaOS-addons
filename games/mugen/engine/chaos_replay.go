package main

import (
	"runtime"

	ggpo "github.com/ikemen-engine/ggpo"
)

var chaosReplaySpeed = func() int { return 1 }

func chaosStreamingReplay() bool { return runtime.GOOS == "js" }

// Read the authoritative queues before GGPO discards them. Recording simulated
// frames here would publish predictions that can change after a rollback.
func chaosAttachConfirmed(rs *RollbackSession) {
	if !chaosStreamingReplay() || rs.recording == nil { return }
	peer, ok := rs.backend.(*ggpo.Peer)
	if !ok { return }
	peer.OnConfirmedInputs = func(_ int, values [][]byte) {
		inputs, axes := decodeInputs(values)
		for i := 0; i < REPLAY_NUM_INPUTS; i++ {
			var bits InputBits
			var analog [6]int8
			if i < len(inputs) { bits = inputs[i]; analog = axes[i] }
			if err := writeReplayInput(rs.recording, bits, analog); err != nil {
				panic(err)
			}
		}
	}
}
