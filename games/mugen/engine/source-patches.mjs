// Patches against the pinned browser fork. Apply in a private build copy;
// refuse changed upstream code rather than silently mixing replay timelines.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_PATCHES = [
  {
    file: 'src/system.go',
    find: '\tvar p *Char\n\tsys.workingChar = p',
    replace: '\tchaosRestoreChar(pn, cdef)\n\tvar p *Char\n\tsys.workingChar = p',
  },
  {
    file: 'src/sound.go',
    find: 'if lc != 0 && sys.cfg.Sound.BGMRAMBuffer && bgm.format != "xmp" {',
    replace:
      'if lc != 0 && sys.cfg.Sound.BGMRAMBuffer && bgm.format != "xmp" && chaosAllowBgmPredecode() {',
  },
  {
    file: 'src/system.go',
    find: 'sys.chars[pn][0].gi().def == cdef && sys.chars[pn][0].ocd().existed',
    replace:
      'sys.chars[pn][0].gi().def == cdef && (sys.chars[pn][0].ocd().existed || chaosCanReuseChar(pn, cdef))',
  },
  {
    file: 'src/system.go',
    find: '\t//sys.chars[pn][0].ocd().existed = true\n\n\treturn 1',
    replace: '\t//sys.chars[pn][0].ocd().existed = true\n\tchaosRememberChar(pn)\n\n\treturn 1',
  },
  {
    file: 'src/system_js.go',
    find: 'func (w *Window) pollEvents() {\n\tpollGamepads()',
    replace:
      'func (w *Window) pollEvents() {\n\tchaosPollAudio()\n\tchaosPollSession()\n\tpollGamepads()',
  },
  {
    file: 'src/script.go',
    find: 'func systemScriptInit(l *lua.LState) {',
    replace: 'func systemScriptInit(l *lua.LState) {\n\tchaosRegisterSession(l)',
  },
  {
    file: 'src/system.go',
    find: '\t// Now switch to rollback if applicable\n',
    replace: '\tchaosArmPresentation()\n\t// Now switch to rollback if applicable\n',
  },
  {
    file: 'src/system.go',
    find: '\t\tgfx.EndFrame()\n',
    replace: '\t\tgfx.EndFrame()\n\t\tchaosPresentFrame()\n',
  },
  {
    file: 'src/system.go',
    find: '\tif sameChar {\n\t\tp = sys.chars[pn][0]',
    replace: '\tchaosCharacterLoaded(sameChar)\n\tif sameChar {\n\t\tp = sys.chars[pn][0]',
  },
  {
    file: 'third_party/ggpo/peer.go',
    find: 'type Peer struct {',
    replace:
      'type Peer struct {\n\t// Called before confirmed inputs are discarded; never speculative.\n\tOnConfirmedInputs func(int, [][]byte)\n\tchaosNextConfirmed int',
  },
  {
    file: 'third_party/ggpo/peer.go',
    find: '\t\t\t\tp.sync.SetLastConfirmedFrame(totalMinConfirmed)',
    replace:
      '\t\t\t\tif p.OnConfirmedInputs != nil {\n\t\t\t\t\tfor p.chaosNextConfirmed <= totalMinConfirmed {\n\t\t\t\t\t\tvalues, _ := p.sync.GetConfirmedInputs(p.chaosNextConfirmed)\n\t\t\t\t\t\tp.OnConfirmedInputs(p.chaosNextConfirmed, values)\n\t\t\t\t\t\tp.chaosNextConfirmed++\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\tp.sync.SetLastConfirmedFrame(totalMinConfirmed)',
  },
  {
    file: 'src/script.go',
    find: 'if sys.netConnection != nil && runtime.GOOS != "js" {',
    replace: 'if sys.netConnection != nil { // ChaOS VFS supports positioned replay writes.',
  },
  {
    file: 'src/rollback.go',
    find: '\t\trs.session.recording = sys.netConnection.recording',
    replace:
      '\t\trs.session.recording = sys.netConnection.recording\n\t\tchaosAttachConfirmed(rs.session)',
  },
  {
    file: 'src/rollback.go',
    find: 'func (rs *RollbackSession) SaveReplay() {',
    replace:
      'func (rs *RollbackSession) SaveReplay() {\n\tif chaosStreamingReplay() { return } // Written once from confirmed GGPO input.',
  },
  {
    file: 'src/netplay.go',
    find: 'func seekReplaySyncMarker(f *os.File) (int64, error) {',
    replace:
      'func seekReplaySyncMarker(f *os.File) (int64, error) {\n\tif chaosStreamingReplay() {\n\t\t// Frames and sync records are multiples of eight bytes. Scan without\n\t\t// io.ReadAll: a growing file has no EOF while the host is playing.\n\t\tvar marker [len(replaySyncMagic)]byte\n\t\tfor skipped := int64(0); skipped < replaySyncSearchLimit; skipped += int64(len(marker)) {\n\t\t\tif _, err := io.ReadFull(f, marker[:]); err != nil { return 0, err }\n\t\t\tif string(marker[:]) == replaySyncMagic { return skipped, nil }\n\t\t}\n\t\treturn 0, fmt.Errorf("live replay sync marker not found")\n\t}',
  },
  {
    file: 'src/system.go',
    find: '\tif s.replayFile != nil {\n\t\tif s.anyHardButton() {\n\t\t\ts.await(s.gameRenderSpeed() * 4)\n\t\t} else {\n\t\t\ts.await(s.gameRenderSpeed())\n\t\t}\n\t\treturn s.replayFile.Update()\n\t}',
    replace:
      '\tif s.replayFile != nil {\n\t\t// Accelerate wall-clock playback without changing simulation steps.\n\t\ts.await(s.gameRenderSpeed() * chaosReplaySpeed())\n\t\treturn s.replayFile.Update()\n\t}',
  },
];

export function applySourcePatches(root) {
  // Check all anchors first, including multiple patches in one file.
  const files = new Map();
  for (const patch of SOURCE_PATCHES) {
    const text =
      files.get(patch.file) ??
      readFileSync(join(root, patch.file), 'utf8').replaceAll('\r\n', '\n');
    const at = text.indexOf(patch.find);
    if (at < 0 || text.indexOf(patch.find, at + 1) >= 0)
      throw new Error(`source patch for ${patch.file} no longer matches the pinned engine`);
    files.set(patch.file, text.slice(0, at) + patch.replace + text.slice(at + patch.find.length));
  }
  for (const [file, text] of files) writeFileSync(join(root, file), text);
  for (const file of [
    'chaos_replay.go',
    'chaos_replay_js.go',
    'chaos_audio_js.go',
    'chaos_session_js.go',
  ])
    copyFileSync(new URL('./' + file, import.meta.url), join(root, 'src', file));
}
