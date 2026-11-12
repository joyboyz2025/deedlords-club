//! Who takes what from the middle at a showdown, side pots included.
//!
//! A seat that went all in for less than the others can only win, from each seat, as much as it put in itself. So the
//! chips are cut into layers at every amount a seat still in has put in: the layer up to the smallest amount is played
//! for by all of them, the next one by those who put in more, and so on. A layer only one seat reached goes back to it:
//! that is the part of its bet nobody called.

/// The chips each seat takes. `put[seat]` is what the seat put into the hand; `score[seat]` is the strength of its hand
/// when it is still in, `None` when it folded or was not dealt in. Chips that do not divide among tied hands go one
/// each to the tied seats that come first in `order`, which lists the seats still in.
///
/// With nobody still in, every seat takes back its own.
pub fn share(put: &[u32], score: &[Option<u32>], order: &[usize]) -> Vec<u32> {
    let mut levels: Vec<u32> = (0..put.len()).filter(|&seat| score[seat].is_some()).map(|seat| put[seat]).collect();
    levels.sort_unstable();
    levels.dedup();
    if levels.is_empty() {
        return put.to_vec();
    }
    let mut won = vec![0; put.len()];
    let mut below = 0;
    for (index, &level) in levels.iter().enumerate() {
        // The top layer also takes what a seat that folded put in above it.
        let top = index + 1 == levels.len();
        let layer: u32 = put.iter().map(|&chips| if top { chips.saturating_sub(below) } else { chips.min(level) - chips.min(below) }).sum();
        let reached = |seat: usize| score[seat].is_some() && put[seat] >= level;
        let best = (0..put.len()).filter(|&seat| reached(seat)).filter_map(|seat| score[seat]).max();
        let winners: Vec<usize> = order.iter().copied().filter(|&seat| reached(seat) && score[seat] == best).collect();
        let (each, odd) = (layer / winners.len() as u32, layer as usize % winners.len());
        for (place, &seat) in winners.iter().enumerate() {
            won[seat] += each + u32::from(place < odd);
        }
        below = level;
    }
    won
}
