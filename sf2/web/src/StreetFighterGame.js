import {
	pollGamepads,
	registerGamepadEvents,
	registerKeyboardEvents,
} from './engine/InputHandler.js';

import { isOnline } from './network.js';
import { BattleScene } from './scenes/BattleScene.js';
import { getContext } from './utils/context.js';

export class StreetFighterGame {
	context = getContext();

	frameTime = {
		previous: 0,
		secondsPassed: 0,
	};

	constructor() {
		this.scene = new BattleScene();
	}

	// Patch finishRound to fire a custom event for the network layer.
	initOnline() {
		const origFinishRound = this.scene.finishRound.bind(this.scene);
		this.scene.finishRound = (winner, time) => {
			origFinishRound(winner, time);
			window.dispatchEvent(new CustomEvent('sf2:round_end_internal', {
				detail: { loserSlot: 1 - winner.playerId },
			}));
		};
	}

	// Main Game Loop
	frame(time) {
		window.requestAnimationFrame(this.frame.bind(this));

		this.frameTime = {
			secondsPassed: (time - this.frameTime.previous) / 1000,
			previous: time,
		};

		pollGamepads();
		this.scene.update(this.frameTime, this.context);
		this.scene.draw(this.context);
	}

	start() {
		// In online mode, network.js drives all input via setKeyState — skip native keyboard
		if (!isOnline) registerKeyboardEvents();
		registerGamepadEvents();

		window.requestAnimationFrame(this.frame.bind(this));
	}
}
