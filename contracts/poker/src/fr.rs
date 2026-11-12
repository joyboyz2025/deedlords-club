//! Numbers modulo the order of BN254 G1: the little the shuffle proof's verifier needs besides the host functions.
//! Not constant-time; everything it is used on is public.

use crate::curve::SCALAR;

/// Four 64-bit limbs, least significant first, always below [`ORDER`].
pub type Fr = [u64; 4];

pub const ORDER: Fr = [0x43e1_f593_f000_0001, 0x2833_e848_79b9_7091, 0xb850_45b6_8181_585d, 0x3064_4e72_e131_a029];
pub const ONE: Fr = [1, 0, 0, 0];

/// Reads 32 little-endian bytes. The caller answers for the value being below the order.
pub fn from_bytes(bytes: &[u8]) -> Fr {
    let mut limbs = [0u64; 4];
    for (limb, chunk) in limbs.iter_mut().zip(bytes.chunks(8)) {
        *limb = u64::from_le_bytes(chunk.try_into().unwrap());
    }
    limbs
}

pub fn to_bytes(value: &Fr) -> [u8; SCALAR] {
    let mut bytes = [0u8; SCALAR];
    for (chunk, limb) in bytes.chunks_mut(8).zip(value) {
        chunk.copy_from_slice(&limb.to_le_bytes());
    }
    bytes
}

fn less(a: &Fr, b: &Fr) -> bool {
    for i in (0..4).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

/// `a + b` modulo the order. The plain sum cannot overflow: the order is below 2^254.
pub fn add(a: &Fr, b: &Fr) -> Fr {
    let mut sum = [0u64; 4];
    let mut carry = 0u128;
    for i in 0..4 {
        let value = u128::from(a[i]) + u128::from(b[i]) + carry;
        sum[i] = value as u64;
        carry = value >> 64;
    }
    if less(&sum, &ORDER) {
        return sum;
    }
    let mut borrow = 0u128;
    for i in 0..4 {
        let value = (1u128 << 64) + u128::from(sum[i]) - u128::from(ORDER[i]) - borrow;
        sum[i] = value as u64;
        borrow = 1 - (value >> 64);
    }
    sum
}

/// `a * b` modulo the order, by doubling and adding over the bits of `b`.
pub fn mul(a: &Fr, b: &Fr) -> Fr {
    let mut product = [0u64; 4];
    for bit in (0..254).rev() {
        product = add(&product, &product);
        if b[bit / 64] >> (bit % 64) & 1 == 1 {
            product = add(&product, a);
        }
    }
    product
}
