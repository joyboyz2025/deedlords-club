//! On-chain randomness (SPEC §3.2).
//!
//! Every 32-byte block of randomness is `sha256(random_seed ‖ match_id ‖ draws_le ‖ salt)`, where `random_seed` is
//! `env::random_seed()` of the receipt being executed, `draws` is the match's persistent counter (incremented once per
//! hash, before hashing, so no two hashes of a match ever share an input) and `salt` names the consumer (`b"die"` or
//! `b"below"`). Bytes of a block are consumed in order; a new block is hashed when they run out.
//!
//! * `die()`: takes the next byte `b`; bytes `>= 252` are rejected (252 = 42 × 6), accepted ones give `b % 6 + 1`.
//! * `below(n)`: takes the next 4 bytes as a little-endian `u32` `v`; values `>= floor(2^32 / n) * n` are rejected,
//!   accepted ones give `v % n`. A `u32` that does not fit in the remaining bytes of a block forces a new block.
//!
//! Both are therefore exactly uniform (no modulo bias): the accepted range is a whole multiple of the modulus.

use deedlords_engine::Rng;

/// Hash function used for the blocks. `env::sha256_array` in the contract; injectable so the sampling logic can be
/// tested without the NEAR environment.
pub type Hasher = fn(&[u8]) -> [u8; 32];

/// The contract's hasher.
pub fn near_sha256(input: &[u8]) -> [u8; 32] {
    near_sdk::env::sha256_array(input)
}

pub struct ChainRng<'a> {
    seed: [u8; 32],
    match_id: &'a str,
    draws: &'a mut u64,
    hasher: Hasher,
    block: [u8; 32],
    /// Next unread byte of `block`; 32 means empty.
    cursor: usize,
}

/// Accepted die faces: `Some(1..=6)` for bytes below 252, `None` (reject) otherwise.
pub const fn die_from_byte(byte: u8) -> Option<u8> {
    if byte < 252 {
        Some(byte % 6 + 1)
    } else {
        None
    }
}

/// Exclusive upper bound of accepted `u32` values for `below(n)`: the largest multiple of `n` not above `2^32`.
pub const fn below_limit(n: u32) -> u64 {
    (1u64 << 32) / n as u64 * n as u64
}

/// `Some(v % n)` when `v` is in the accepted range, `None` (reject) otherwise.
pub const fn below_from_u32(value: u32, n: u32) -> Option<u32> {
    if (value as u64) < below_limit(n) {
        Some(value % n)
    } else {
        None
    }
}

impl<'a> ChainRng<'a> {
    pub fn new(seed: [u8; 32], match_id: &'a str, draws: &'a mut u64, hasher: Hasher) -> Self {
        ChainRng { seed, match_id, draws, hasher, block: [0; 32], cursor: 32 }
    }

    fn refill(&mut self, salt: &[u8]) {
        *self.draws += 1;
        let mut input = Vec::with_capacity(32 + self.match_id.len() + 8 + salt.len());
        input.extend_from_slice(&self.seed);
        input.extend_from_slice(self.match_id.as_bytes());
        input.extend_from_slice(&self.draws.to_le_bytes());
        input.extend_from_slice(salt);
        self.block = (self.hasher)(&input);
        self.cursor = 0;
    }
}

impl Rng for ChainRng<'_> {
    fn die(&mut self) -> u8 {
        loop {
            if self.cursor >= 32 {
                self.refill(b"die");
            }
            let byte = self.block[self.cursor];
            self.cursor += 1;
            if let Some(face) = die_from_byte(byte) {
                return face;
            }
        }
    }

    fn below(&mut self, n: u32) -> u32 {
        if n <= 1 {
            // The engine never asks below(0); below(1) has a single outcome and needs no randomness.
            return 0;
        }
        loop {
            if self.cursor + 4 > 32 {
                self.refill(b"below");
            }
            let bytes = [self.block[self.cursor], self.block[self.cursor + 1], self.block[self.cursor + 2], self.block[self.cursor + 3]];
            self.cursor += 4;
            if let Some(value) = below_from_u32(u32::from_le_bytes(bytes), n) {
                return value;
            }
        }
    }
}
