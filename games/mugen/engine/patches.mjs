// Script fixes applied to the engine's Lua files when the bundle is built.
// Each one names the exact text it replaces: if the pinned commit changes that
// text, the build stops instead of shipping a half-applied fix.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PATCHES = [
  {
    file: 'external/script/main.lua',
    find: '\t\t\t\tcharRef = ref\n\t\t\t\tmain.t_charDef[charKey]',
    replace: '\t\t\t\tcharRef = chaosLastCharRef()\n\t\t\t\tmain.t_charDef[charKey]',
  },
  {
    file: 'external/script/main.lua',
    find: '\t\t\tstageRef = #main.t_selStages + 1\n\t\t\tmain.t_stageDef[stageKey]',
    replace: '\t\t\tstageRef = chaosLastStageRef()\n\t\t\tmain.t_stageDef[stageKey]',
  },
  {
    file: 'external/script/main.lua',
    find: 'function main.f_commandLine()\n',
    replace:
      'function main.f_chaosFinish()\n\treplayStop(); exitNetPlay(); exitReplay(); chaosSessionFinished()\nend\nfunction main.f_commandLine()\n',
  },
  {
    file: 'external/script/main.lua',
    find: '\t\twhile not connected() do\n\t\t\tif esc() then\n\t\t\t\texitNetPlay()\n\t\t\t\tos.exit()',
    replace:
      "\t\twhile not connected() do\n\t\t\tif esc() then\n\t\t\t\tif flags['-chaos-session'] ~= nil then main.f_chaosFinish(); return end\n\t\t\t\texitNetPlay()\n\t\t\t\tos.exit()",
  },
  {
    file: 'external/script/main.lua',
    find: '\t\t\treplayStop()\n\t\t\texitNetPlay()\n\t\t\texitReplay()\n\t\t\tprint(getSessionWarning())\n\t\t\tos.exit()',
    replace:
      "\t\t\treplayStop()\n\t\t\texitNetPlay()\n\t\t\texitReplay()\n\t\t\tprint(getSessionWarning())\n\t\t\tif flags['-chaos-session'] ~= nil then chaosSessionFinished(); return end\n\t\t\tos.exit()",
  },
  {
    file: 'external/script/main.lua',
    find: '\tif not loadMotif then\n\t\tloadFightScreen()\n\tend\n\tlocal ref = #main.t_selChars',
    replace:
      "\tif not loadMotif and not main.chaosFightLoaded then\n\t\tloadFightScreen()\n\t\tmain.chaosFightLoaded = flags['-chaos-session'] ~= nil\n\tend\n\tlocal ref = #main.t_selChars",
  },
  {
    file: 'external/script/main.lua',
    find: '\tos.exit()\nend\n\n--initiate quick match only',
    replace:
      "\tif flags['-chaos-session'] ~= nil then main.f_chaosFinish(); return end\n\tos.exit()\nend\n\n--initiate quick match only",
  },
  {
    file: 'external/script/main.lua',
    find: '\tmain.f_commandLine()\nend\n\n--;===========================================================\n--; LOAD DATA',
    replace:
      "\trepeat\n\t\tmain.f_commandLine()\n\tuntil getCommandLineValue('-chaos-session') == nil or not chaosSessionNext()\n\tos.exit()\nend\n\n--;===========================================================\n--; LOAD DATA",
  },
  {
    file: 'external/script/main.lua',
    find: '\t\trefresh()\n\t\tif not synchronize() then',
    replace:
      "\t\trefresh()\n\t\treplayRecord('save/chaos-live.replay')\n\t\tif not synchronize() then",
  },
  {
    file: 'external/script/main.lua',
    find: "\tif flags['-ip'] ~= nil then\n\t\tenterNetPlay(flags['-ip'])",
    replace:
      "\tif flags['-chaos-replay'] ~= nil then\n\t\tif not enterReplay(flags['-chaos-replay']) or not synchronize() then\n\t\t\tprint(getSessionWarning())\n\t\t\tif flags['-chaos-session'] ~= nil then main.f_chaosFinish(); return end\n\t\t\tos.exit(2)\n\t\tend\n\tend\n\tif flags['-ip'] ~= nil then\n\t\tenterNetPlay(flags['-ip'])",
  },
  {
    file: 'external/script/main.lua',
    // A quick match started with -ip loads both fighters asynchronously in the
    // browser build, and each side pumps frames while it loads. The peers then
    // reach game() with different netplay clocks and the match aborts with
    // "Synchronization error". The menu flow avoids it with the loading
    // handshake the VS screen runs; the quick match needs the same barrier.
    // netLoadingReady() returns true at once when there is no netplay session.
    find: '\t\t-- loop above already does this.)\n\t\trefresh()\n\tend\n\tgame()\n',
    replace:
      '\t\t-- loop above already does this.)\n\t\trefresh()\n\tend\n\twhile not netLoadingReady() do\n\t\tif esc() and flags[\'-chaos-session\'] ~= nil then main.f_chaosFinish(); return end\n\t\trefresh()\n\tend\n\tmain.f_printTable({ready = true}, "save/chaos-ready")\n\tgame()\n',
  },
];

export function applyPatches(root) {
  for (const patch of PATCHES) {
    const path = join(root, patch.file);
    const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    const at = text.indexOf(patch.find);
    if (at < 0 || text.indexOf(patch.find, at + 1) >= 0)
      throw new Error(`patch for ${patch.file} no longer matches the pinned engine`);
    writeFileSync(path, text.slice(0, at) + patch.replace + text.slice(at + patch.find.length));
  }
}
