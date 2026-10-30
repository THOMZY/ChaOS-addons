import { Control, GamepadThumbstick } from '../constants/control.js';

export const controls = [
    // Player 1
    {
        gamePad: {
            [GamepadThumbstick.DEAD_ZONE]: 0.5,
            [GamepadThumbstick.HORIZONTAL_AXE_ID]: 0,
            [GamepadThumbstick.VERTICAL_AXE_ID]: 1,

            [Control.LEFT]: 14,
            [Control.RIGHT]: 15,
            [Control.UP]: 12,
            [Control.DOWN]: 13,
            [Control.LIGHT_PUNCH]: 2,
            [Control.MEDIUM_PUNCH]: 3,
            [Control.HEAVY_PUNCH]: 5,
            [Control.LIGHT_KICK]: 0,
            [Control.MEDIUM_KICK]: 1,
            [Control.HEAVY_KICK]: 7,
        },
        // Online: ZQSD movement + UIOJKL attacks — uses event.key (lowercase), layout-agnostic
        keyboard: {
            [Control.LEFT]:         'q',
            [Control.RIGHT]:        'd',
            [Control.UP]:           'z',
            [Control.DOWN]:         's',
            [Control.LIGHT_PUNCH]:  'u',
            [Control.MEDIUM_PUNCH]: 'i',
            [Control.HEAVY_PUNCH]:  'o',
            [Control.LIGHT_KICK]:   'j',
            [Control.MEDIUM_KICK]:  'k',
            [Control.HEAVY_KICK]:   'l',
        },
    },
    // Player 2 — virtual keys (injected by network.js in online mode; not physically pressed)
    {
        gamePad: {
            [GamepadThumbstick.DEAD_ZONE]: 0.5,
            [GamepadThumbstick.HORIZONTAL_AXE_ID]: 0,
            [GamepadThumbstick.VERTICAL_AXE_ID]: 1,

            [Control.LEFT]: 14,
            [Control.RIGHT]: 15,
            [Control.UP]: 12,
            [Control.DOWN]: 13,
            [Control.LIGHT_PUNCH]: 2,
            [Control.MEDIUM_PUNCH]: 3,
            [Control.HEAVY_PUNCH]: 5,
            [Control.LIGHT_KICK]: 0,
            [Control.MEDIUM_KICK]: 1,
            [Control.HEAVY_KICK]: 7,
        },
        keyboard: {
            [Control.LEFT]:         '~vl',
            [Control.RIGHT]:        '~vr',
            [Control.UP]:           '~vu',
            [Control.DOWN]:         '~vd',
            [Control.LIGHT_PUNCH]:  '~vp1',
            [Control.MEDIUM_PUNCH]: '~vp2',
            [Control.HEAVY_PUNCH]:  '~vp3',
            [Control.LIGHT_KICK]:   '~vk1',
            [Control.MEDIUM_KICK]:  '~vk2',
            [Control.HEAVY_KICK]:   '~vk3',
        },
    },
];
