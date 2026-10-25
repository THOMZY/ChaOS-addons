/**
 * Volume taper for the Game Boy player.
 *
 * The slider is linear to the finger, the ear is not. With a linear gain the
 * first percent is already loud and the whole useful range sits in the first
 * few pixels. We map the position onto a -48 dB … 0 dB curve, the way hardware
 * faders do: an equal step multiplies the amplitude by an equal factor instead
 * of adding the same amount.
 */
export const VOL_MIN_DB = -48;

/** Slider position (0…100) -> linear gain (0…1) on a logarithmic curve. */
export function gainFromVolume(pct) {
  const x = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  return x === 0 ? 0 : 10 ** ((VOL_MIN_DB * (1 - x)) / 20);
}
