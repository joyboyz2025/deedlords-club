//! Poker hand ranking. A card is 0..52: its rank is `card % 13` (0 is a two, 12 an ace), its suit `card / 13`.

/// Strength of five cards: a higher number beats a lower one, equal numbers split the pot. The top bits are the
/// category (0 high card .. 8 straight flush), then up to five ranks that break ties, four bits each.
pub fn rank5(cards: [u8; 5]) -> u32 {
    let mut ranks = cards.map(|card| card % 13);
    ranks.sort_unstable_by(|a, b| b.cmp(a));
    let flush = cards.iter().all(|card| card / 13 == cards[0] / 13);
    // Groups of equal ranks as (count, rank), the biggest group first and then the highest rank.
    let mut groups: Vec<(u8, u8)> = vec![];
    for rank in ranks {
        match groups.last_mut() {
            Some(group) if group.1 == rank => group.0 += 1,
            _ => groups.push((1, rank)),
        }
    }
    groups.sort_unstable_by(|a, b| b.cmp(a));
    let wheel = ranks == [12, 3, 2, 1, 0];
    let straight = groups.len() == 5 && (ranks[0] - ranks[4] == 4 || wheel);
    let category = match (groups[0].0, groups.get(1).map_or(0, |group| group.0)) {
        _ if straight && flush => 8,
        (4, _) => 7,
        (3, 2) => 6,
        _ if flush => 5,
        _ if straight => 4,
        (3, _) => 3,
        (2, 2) => 2,
        (2, _) => 1,
        _ => 0,
    };
    // A straight is decided by its top card alone; in the wheel (A-2-3-4-5) that is the five.
    let ties: Vec<u8> = if straight { vec![if wheel { 3 } else { ranks[0] }] } else { groups.iter().map(|group| group.1).collect() };
    ties.iter().fold(category, |score, &rank| score << 4 | u32::from(rank)) << (4 * (5 - ties.len()))
}

/// The best five of seven cards.
pub fn rank7(cards: [u8; 7]) -> u32 {
    let mut best = 0;
    for a in 0..7 {
        for b in a + 1..7 {
            let mut five = [0u8; 5];
            let mut n = 0;
            for (index, &card) in cards.iter().enumerate() {
                if index != a && index != b {
                    five[n] = card;
                    n += 1;
                }
            }
            best = best.max(rank5(five));
        }
    }
    best
}
