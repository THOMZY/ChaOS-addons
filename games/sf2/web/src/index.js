import { StreetFighterGame } from './StreetFighterGame.js';
import { isOnline } from './network.js';

function launchGame() {
	const game = new StreetFighterGame();
	if (isOnline) game.initOnline();
	game.start();
}

window.addEventListener('load', function () {
	if (isOnline) {
		// Online mode: auto-start without requiring a click
		launchGame();
	} else {
		window.addEventListener('click', launchGame, { once: true });
	}
});
