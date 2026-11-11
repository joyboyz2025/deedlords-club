//! On-chain randomness for the market draw, the same construction as the Deedlords board contract.
//!
//! Every 32-byte block is `sha256(random_seed ‖ match_id ‖ draws_le ‖ "below")`, where `random_seed` is
//! `env::random_seed()` of the receipt being executed and `draws` is the match's persistent counter, incremented once
//! per hash before hashing, so no two hashes of a match share an input. `below(n)` reads the block four bytes at a
//! time as little-endian `u32`s and rejects values `>= floor(2^32 / n) * n`, so the result is exactly uniform.

use near_sdk::env;

pub struct ChainRng<'a> {
    seed: [u8; 32],
    match_id: &'a str,
    draws: &'a mut u64,
}

impl<'a> ChainRng<'a> {
    pub fn new(seed: [u8; 32], match_id: &'a str, draws: &'a mut u64) -> Self {
        ChainRng { seed, match_id, draws }
    }

    pub fn below(self, n: u32) -> u32 {
        if n <= 1 {
            return 0;
        }
        let limit = (1u64 << 32) / u64::from(n) * u64::from(n);
        loop {
            *self.draws += 1;
            let mut input = Vec::with_capacity(32 + self.match_id.len() + 8 + 5);
            input.extend_from_slice(&self.seed);
            input.extend_from_slice(self.match_id.as_bytes());
            input.extend_from_slice(&self.draws.to_le_bytes());
            input.extend_from_slice(b"below");
            for bytes in env::sha256_array(&input).chunks_exact(4) {
                let value = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                if u64::from(value) < limit {
                    return value % n;
                }
            }
        }
    }
}
