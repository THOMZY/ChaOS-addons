import {
    FIGHTER_HURT_DELAY,
    FighterState,
    FrameDelay,
    SpecialMoveButton,
    SpecialMoveDirection,
} from '../../constants/fighter.js';

import { playSound } from '../../engine/soundHandler.js';
import { Fireball } from './special/Fireball.js';

export const SHOTO_INITIAL_VELOCITY = {
    x: {
        [FighterState.WALK_FORWARD]: 3 * 60,
        [FighterState.WALK_BACKWARD]: -(2 * 60),
        [FighterState.JUMP_FORWARD]: 48 * 3 + 12 * 2,
        [FighterState.JUMP_BACKWARD]: -(45 * 4 + 15 * 3),
    },
    jump: -420,
};

export const SHOTO_HADOUKEN_VALID_FROM = [
    FighterState.IDLE,
    FighterState.WALK_FORWARD,
    FighterState.IDLE_TURN,
    FighterState.CROUCH,
    FighterState.CROUCH_DOWN,
    FighterState.CROUCH_UP,
    FighterState.CROUCH_TURN,
    FighterState.LIGHT_PUNCH,
    FighterState.MEDIUM_PUNCH,
    FighterState.HEAVY_PUNCH,
];

const KEN_HURT_HEAD_LIGHT = [
    ['hit-face-1', FIGHTER_HURT_DELAY],
    ['hit-face-1', 3],
    ['hit-face-2', 4],
    ['hit-face-3', 9],
    ['hit-face-3', FrameDelay.TRANSITION],
];

const KEN_HURT_BODY_MEDIUM = [
    ['hit-stomach-1', FIGHTER_HURT_DELAY],
    ['hit-stomach-1', 7],
    ['hit-stomach-2', 9],
    ['hit-stomach-2', FrameDelay.TRANSITION],
];

const KEN_WINNER_POSE = [
    ['winner-pose-1', 12],
    ['winner-pose-2', 10],
    ['winner-pose-3', 10],
    ['winner-pose-4', 50],
    ['winner-pose-3', 8],
    ['winner-pose-2', 8],
    ['winner-pose-5', FrameDelay.TRANSITION],
];

export function createShotoAnimations({
    hurtHeadLight = KEN_HURT_HEAD_LIGHT,
    hurtBodyMedium = KEN_HURT_BODY_MEDIUM,
    winnerPose = KEN_WINNER_POSE,
} = {}) {
    return {
        [FighterState.IDLE]: [
            ['idle-1', 4],
            ['idle-2', 4],
            ['idle-3', 4],
            ['idle-4', 4],
            ['idle-3', 4],
            ['idle-2', 4],
        ],
        [FighterState.WALK_FORWARD]: [
            ['forwards-1', 3],
            ['forwards-2', 6],
            ['forwards-3', 4],
            ['forwards-4', 4],
            ['forwards-5', 4],
            ['forwards-6', 6],
        ],
        [FighterState.WALK_BACKWARD]: [
            ['backwards-1', 3],
            ['backwards-2', 6],
            ['backwards-3', 4],
            ['backwards-4', 4],
            ['backwards-5', 4],
            ['backwards-6', 6],
        ],
        [FighterState.JUMP_START]: [
            ['jump-land', 3],
            ['jump-land', FrameDelay.TRANSITION],
        ],
        [FighterState.JUMP_UP]: [
            ['jump-up-1', 8],
            ['jump-up-2', 8],
            ['jump-up-3', 8],
            ['jump-up-4', 8],
            ['jump-up-5', 8],
            ['jump-up-6', FrameDelay.TRANSITION],
        ],
        [FighterState.JUMP_FORWARD]: [
            ['jump-roll-1', 13],
            ['jump-roll-2', 5],
            ['jump-roll-3', 3],
            ['jump-roll-4', 3],
            ['jump-roll-5', 3],
            ['jump-roll-6', 5],
            ['jump-roll-6', FrameDelay.FREEZE],
        ],
        [FighterState.JUMP_BACKWARD]: [
            ['jump-roll-6', 15],
            ['jump-roll-5', 3],
            ['jump-roll-4', 3],
            ['jump-roll-3', 3],
            ['jump-roll-2', 3],
            ['jump-roll-1', FrameDelay.FREEZE],
        ],
        [FighterState.JUMP_LAND]: [
            ['jump-land', 2],
            ['jump-land', 5],
            ['jump-land', FrameDelay.TRANSITION],
        ],
        [FighterState.CROUCH]: [['crouch-3', FrameDelay.FREEZE]],
        [FighterState.CROUCH_DOWN]: [
            ['crouch-1', 2],
            ['crouch-2', 2],
            ['crouch-3', 2],
            ['crouch-3', FrameDelay.TRANSITION],
        ],
        [FighterState.CROUCH_UP]: [
            ['crouch-3', 2],
            ['crouch-2', 2],
            ['crouch-1', 2],
            ['crouch-1', FrameDelay.TRANSITION],
        ],
        [FighterState.IDLE_TURN]: [
            ['idle-turn-3', 2],
            ['idle-turn-2', 2],
            ['idle-turn-1', 2],
            ['idle-turn-1', FrameDelay.TRANSITION],
        ],
        [FighterState.CROUCH_TURN]: [
            ['crouch-turn-3', 2],
            ['crouch-turn-2', 2],
            ['crouch-turn-1', 2],
            ['crouch-turn-1', FrameDelay.TRANSITION],
        ],
        [FighterState.LIGHT_PUNCH]: [
            ['light-punch-1', 2],
            ['light-punch-2', 4],
            ['light-punch-1', 4],
            ['light-punch-1', FrameDelay.TRANSITION],
        ],
        [FighterState.MEDIUM_PUNCH]: [
            ['med-punch-1', 1],
            ['med-punch-2', 2],
            ['med-punch-3', 4],
            ['med-punch-2', 3],
            ['med-punch-1', 3],
            ['med-punch-1', FrameDelay.TRANSITION],
        ],
        [FighterState.HEAVY_PUNCH]: [
            ['med-punch-1', 3],
            ['med-punch-2', 2],
            ['heavy-punch-1', 6],
            ['med-punch-2', 6],
            ['med-punch-1', 12],
            ['med-punch-1', FrameDelay.TRANSITION],
        ],
        [FighterState.LIGHT_KICK]: [
            ['med-punch-1', 3],
            ['light-kick-1', 3],
            ['light-kick-2', 8],
            ['light-kick-1', 4],
            ['med-punch-1', 1],
            ['med-punch-1', FrameDelay.TRANSITION],
        ],
        [FighterState.MEDIUM_KICK]: [
            ['med-punch-1', 5],
            ['light-kick-1', 6],
            ['med-kick-1', 12],
            ['light-kick-1', 7],
            ['light-kick-1', FrameDelay.TRANSITION],
        ],
        [FighterState.HEAVY_KICK]: [
            ['heavy-kick-1', 2],
            ['heavy-kick-2', 4],
            ['heavy-kick-3', 8],
            ['heavy-kick-4', 10],
            ['heavy-kick-5', 7],
            ['heavy-kick-5', FrameDelay.TRANSITION],
        ],
        [FighterState.HURT_HEAD_LIGHT]: hurtHeadLight,
        [FighterState.HURT_HEAD_MEDIUM]: [
            ['hit-face-1', FIGHTER_HURT_DELAY],
            ['hit-face-1', 3],
            ['hit-face-2', 4],
            ['hit-face-3', 9],
            ['hit-face-3', FrameDelay.TRANSITION],
        ],
        [FighterState.HURT_HEAD_HEAVY]: [
            ['hit-face-3', FIGHTER_HURT_DELAY],
            ['hit-face-3', 7],
            ['hit-face-4', 4],
            ['stun-3', 9],
            ['stun-3', FrameDelay.TRANSITION],
        ],
        [FighterState.HURT_BODY_LIGHT]: [
            ['hit-stomach-1', FIGHTER_HURT_DELAY],
            ['hit-stomach-1', 11],
            ['hit-stomach-1', FrameDelay.TRANSITION],
        ],
        [FighterState.HURT_BODY_MEDIUM]: hurtBodyMedium,
        [FighterState.HURT_BODY_HEAVY]: [
            ['hit-stomach-2', FIGHTER_HURT_DELAY],
            ['hit-stomach-2', 3],
            ['hit-stomach-3', 4],
            ['hit-stomach-4', 4],
            ['stun-3', 9],
            ['stun-3', FrameDelay.TRANSITION],
        ],
        [FighterState.SPECIAL_1]: [
            ['special-1', 2],
            ['special-2', 8],
            ['special-3', 2],
            ['special-4', 40],
            ['special-4', FrameDelay.TRANSITION],
        ],
        [FighterState.WINNER_POSE]: winnerPose,
    };
}

export function createHadoukenSpecialMoves() {
    return [
        {
            state: FighterState.SPECIAL_1,
            sequence: [
                SpecialMoveDirection.DOWN,
                SpecialMoveDirection.FORWARD_DOWN,
                SpecialMoveDirection.FORWARD,
                SpecialMoveButton.ANY_PUNCH,
            ],
            cursor: 0,
        },
    ];
}

export function installHadoukenState(fighter, validFrom = SHOTO_HADOUKEN_VALID_FROM) {
    fighter.states[FighterState.SPECIAL_1] = {
        init: handleHadoukenInit.bind(fighter),
        update: handleHadoukenState.bind(fighter),
        shadow: [1.6, 1, 22, 0],
        validFrom,
    };

    fighter.states[FighterState.IDLE].validFrom.push(FighterState.SPECIAL_1);
}

function handleHadoukenInit(_, strength) {
    this.resetVelocities();
    playSound(this.voiceHadouken, 0.09);
    this.fireball = { fired: false, strength };
}

function handleHadoukenState(time) {
    if (!this.fireball.fired && this.animationFrame === 3) {
        this.fireball.fired = true;
        this.entityList.add.call(this.entityList, Fireball, time, this, this.fireball.strength);
    }

    if (!this.isAnimationCompleted()) return;
    this.changeState(FighterState.IDLE, time);
}