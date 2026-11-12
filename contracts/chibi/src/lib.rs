//! Deedlords chibi characters: one character per account, and every piece it wears, as NEP-171 NFTs (with the
//! enumeration and metadata extensions).
//!
//! * A character is a token `char:<serial>` that cannot be transferred: it is the account's name and face at the
//!   tables. It holds the character's own traits (body, skin, hair colour, outfit colour: free to change, never tokens)
//!   and what it wears: for each item part, one item token of the account's or nothing.
//! * Every item is a token `<part>:<index>:<serial>` (`hat:6:41` is a Mandarin cap), transferable like any NFT. The
//!   catalogue ([`catalog`]) is generated from the game's own chibi parts; index 0 of each part is the bare default and is
//!   never a token. What a character wears is checked when it is read: an item given away is no longer worn.
//! * Basic items are free: a new character is minted with the basic items it was made with, and each basic item can be
//!   claimed once per account afterwards. Rare, Epic and Legendary items only come out of boxes, bought with NEAR
//!   (`buy_box`), rolled with the chain's randomness (`env::random_seed`), with the same two pity rules as the game the
//!   art comes from.
//! * Storage: an account pays for its own calls with an attached deposit (the excess comes back). The `minter` (the
//!   server's sponsor) may act for any account, so that accounts holding no NEAR get the free things; the contract then
//!   pays their storage out of a free pool that only grows by explicit deposits (`fund_free_pool`) and stops when
//!   empty. A box's storage is paid out of its price; the rest is revenue that only the owner can withdraw, and only
//!   that much.
//!
//! Every successful state change logs `EVENT_JSON:{"standard":"deedlords_chibi","version":"1.0.0","event":..,"data":..}`
//! besides the NEP-171 `nft_mint` events.

#[rustfmt::skip]
pub mod catalog;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, NonFungibleTokenEnumeration, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue};

use catalog::{ITEMS, ITEM_PARTS, TRAITS};

/// Odds of a box, in basis points: Legendary 2%, Epic 15%, the rest Rare.
pub const LEGENDARY_BP: u32 = 200;
pub const EPIC_BP: u32 = 1_500;
/// Nine boxes in a row that gave only Rare: the tenth gives Epic.
pub const EPIC_PITY: u32 = 10;
/// Forty-nine boxes in a row without a Legendary: the fiftieth gives one.
pub const LEGENDARY_PITY: u32 = 50;
pub const NAME_MIN: usize = 2;
pub const NAME_MAX: usize = 20;
/// `characters_of` reads at most this many accounts at once.
pub const MAX_READ: usize = 50;
pub const ITEM_SLOTS: usize = ITEM_PARTS.len();

const RARITY_NAMES: [&str; 4] = ["Basic", "Rare", "Epic", "Legendary"];

/// A whole look, as the game draws it (`Look` in games/ma-soi/look.ts): an index per part.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub body: u8,
    pub skin: u8,
    pub hair: u8,
    pub hair_color: u8,
    pub outfit: u8,
    pub robe: u8,
    pub neck: u8,
    pub hat: u8,
    pub face: u8,
    pub held: u8,
    pub shoes: u8,
    pub pet: u8,
    pub ride: u8,
}

impl Look {
    fn traits(&self) -> [u8; 4] {
        [self.body, self.skin, self.hair_color, self.robe]
    }

    /// The index worn on item part `slot` (in [`ITEM_PARTS`] order).
    fn item(&self, slot: usize) -> u8 {
        match ITEM_PARTS[slot] {
            "outfit" => self.outfit,
            "neck" => self.neck,
            "hat" => self.hat,
            "face" => self.face,
            "held" => self.held,
            "shoes" => self.shoes,
            "pet" => self.pet,
            "ride" => self.ride,
            "hair" => self.hair,
            other => env::panic_str(&format!("no part {other}")),
        }
    }

    fn set_item(&mut self, slot: usize, index: u8) {
        match ITEM_PARTS[slot] {
            "outfit" => self.outfit = index,
            "neck" => self.neck = index,
            "hat" => self.hat = index,
            "face" => self.face = index,
            "held" => self.held = index,
            "shoes" => self.shoes = index,
            "pet" => self.pet = index,
            "ride" => self.ride = index,
            "hair" => self.hair = index,
            other => env::panic_str(&format!("no part {other}")),
        }
    }

    fn from_traits(traits: [u8; 4]) -> Look {
        Look { body: traits[0], skin: traits[1], hair_color: traits[2], robe: traits[3], ..Look::default() }
    }
}

/// What `equip` changes: the character's own traits, and the item tokens it wears (at most one per part; every part
/// not named goes back to its bare default).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outfit {
    pub body: u8,
    pub skin: u8,
    pub hair_color: u8,
    pub robe: u8,
    pub worn: Vec<TokenId>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Character {
    serial: u64,
    name: String,
    /// body, skin, hair colour, outfit colour.
    traits: [u8; 4],
    /// Per item part: (index, serial of the token) or (0, 0) for the bare default. Fixed size: equipping never changes
    /// the storage an account uses.
    worn: [(u8, u64); ITEM_SLOTS],
    created_at: u64,
}

/// A character as read: its name, its look with only the items its account still holds, and the token of each.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterView {
    pub account_id: AccountId,
    pub token_id: TokenId,
    pub name: String,
    pub look: Look,
    /// Part name to token id, for the items worn.
    pub worn: BTreeMap<String, TokenId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxCount {
    pub opened: u32,
    /// Boxes in a row that gave only Rare.
    pub since_epic: u32,
    /// Boxes in a row without a Legendary.
    pub since_legendary: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxOpened {
    pub token_id: TokenId,
    pub part: String,
    pub index: u8,
    pub rarity: u8,
    pub name: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    /// The server's sponsor: may make, dress and give basic items to any account, paid out of the free pool.
    minter: AccountId,
    box_price: NearToken,
    /// What the contract still pays for the storage of the minter's free calls. Grows only by `fund_free_pool`.
    free_pool: NearToken,
    /// Box income after storage, not yet withdrawn. Only `withdraw_revenue` moves it, and only this much.
    revenue: NearToken,
    tokens: NonFungibleToken,
    characters: LookupMap<AccountId, Character>,
    /// Lower-cased names, to the account that has each.
    names: LookupMap<String, AccountId>,
    /// `<account>|<kind>` of every basic item an account was given: once each.
    claimed: LookupSet<String>,
    boxes: LookupMap<AccountId, BoxCount>,
    /// Last serial handed out; token serials are unique across the contract.
    serial: u64,
    /// Hashes of randomness drawn so far: no two draws share an input.
    draws: u64,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "deedlords_chibi", "version": "1.0.0", "event": event, "data": data })));
}

fn slot_of(part: &str) -> usize {
    ITEM_PARTS.iter().position(|p| *p == part).unwrap_or_else(|| env::panic_str(&format!("{part} is not an item part")))
}

fn item_entry(slot: usize, index: u8) -> (u8, &'static str) {
    *ITEMS[slot].get(index as usize).unwrap_or_else(|| env::panic_str(&format!("{} has no item {index}", ITEM_PARTS[slot])))
}

pub fn kind_of(slot: usize, index: u8) -> String {
    format!("{}:{index}", ITEM_PARTS[slot])
}

pub fn item_token_id(slot: usize, index: u8, serial: u64) -> TokenId {
    format!("{}:{index}:{serial}", ITEM_PARTS[slot])
}

/// `(slot, index, serial)` of an item token's id, or `None` for anything else (a character's token among them).
pub fn parse_item_token(token_id: &str) -> Option<(usize, u8, u64)> {
    let mut parts = token_id.split(':');
    let (part, index, serial) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let slot = ITEM_PARTS.iter().position(|p| *p == part)?;
    let index: u8 = index.parse().ok()?;
    let serial: u64 = serial.parse().ok()?;
    if index == 0 || (index as usize) >= ITEMS[slot].len() || index.to_string().len() != token_id.split(':').nth(1)?.len() {
        return None;
    }
    Some((slot, index, serial))
}

fn check_traits(traits: [u8; 4]) {
    for (value, (part, count)) in traits.iter().zip(TRAITS.iter()) {
        require!(*value < *count, format!("{part} must be below {count}"));
    }
}

/// The name as kept (trimmed of nothing: a name with spaces at its ends is refused) and its lower-cased key.
pub fn check_name(name: &str) -> String {
    let count = name.chars().count();
    require!((NAME_MIN..=NAME_MAX).contains(&count), format!("a name has {NAME_MIN} to {NAME_MAX} characters"));
    require!(name.trim() == name && !name.contains("  "), "no spaces at the ends of a name, and no two in a row");
    require!(
        name.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '\'')),
        "a name has letters, digits, spaces and - _ . ' only"
    );
    require!(name.chars().any(|c| c.is_alphabetic()), "a name has at least one letter");
    name.to_lowercase()
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, minter_id: AccountId, box_price: U128) -> Self {
        Self {
            owner: owner_id.clone(),
            minter: minter_id,
            box_price: NearToken::from_yoctonear(box_price.0),
            free_pool: NearToken::from_yoctonear(0),
            revenue: NearToken::from_yoctonear(0),
            tokens: NonFungibleToken::new(b"o".to_vec(), owner_id, Some(b"m".to_vec()), Some(b"e".to_vec()), None::<Vec<u8>>),
            characters: LookupMap::new(b"c".to_vec()),
            names: LookupMap::new(b"n".to_vec()),
            claimed: LookupSet::new(b"k".to_vec()),
            boxes: LookupMap::new(b"b".to_vec()),
            serial: 0,
            draws: 0,
        }
    }

    // ----- a character -------------------------------------------------------------------------------------------

    /// Makes the account's character: a name nobody has (any case), traits, and basic items only. Mints the character
    /// and one token of each item it wears. `owner`: the account, when the minter makes it; others make their own.
    #[payable]
    pub fn create_character(&mut self, owner: Option<AccountId>, name: String, look: Look) -> CharacterView {
        let (account, by_minter) = self.actor(owner);
        require!(self.characters.get(&account).is_none(), "this account already has a character");
        let key = check_name(&name);
        require!(self.names.get(&key).is_none(), "that name is taken");
        let traits = look.traits();
        check_traits(traits);
        for slot in 0..ITEM_SLOTS {
            let index = look.item(slot);
            let (rarity, _) = item_entry(slot, index);
            require!(rarity == 0, format!("a new character wears basic items only ({} {index} is not)", ITEM_PARTS[slot]));
        }

        let before = env::storage_usage();
        let serial = self.next_serial();
        let token_id = format!("char:{serial}");
        let metadata = TokenMetadata {
            title: Some(name.clone()),
            description: Some(format!("{name}, a Deedlords character. Its look is read from character_of.")),
            copies: Some(1),
            issued_at: Some((env::block_timestamp() / 1_000_000).to_string()),
            extra: Some(json!({ "kind": "character" }).to_string()),
            ..TokenMetadata::default()
        };
        self.tokens.internal_mint_with_refund(token_id.clone(), account.clone(), Some(metadata), None);
        let mut minted = vec![token_id.clone()];
        let mut worn = [(0u8, 0u64); ITEM_SLOTS];
        for (slot, entry) in worn.iter_mut().enumerate() {
            let index = look.item(slot);
            if index == 0 {
                continue;
            }
            let item_serial = self.mint_item(&account, slot, index);
            self.claimed.insert(format!("{account}|{}", kind_of(slot, index)));
            minted.push(item_token_id(slot, index, item_serial));
            *entry = (index, item_serial);
        }
        self.characters.insert(account.clone(), Character { serial, name: name.clone(), traits, worn, created_at: env::block_timestamp() });
        self.names.insert(key, account.clone());
        let ids: Vec<&str> = minted.iter().map(String::as_str).collect();
        NftMint { owner_id: &account, token_ids: &ids, memo: Some("character") }.emit();
        self.settle(before, by_minter);
        let view = self.view_of(&account).expect("just made");
        emit("character_created", json!({ "account_id": account, "token_id": token_id, "name": name, "tokens": minted }));
        view
    }

    /// Mints one basic item to the account, once per kind per account, free. Needs a character.
    #[payable]
    pub fn claim(&mut self, owner: Option<AccountId>, part: String, index: u8) -> TokenId {
        let (account, by_minter) = self.actor(owner);
        require!(self.characters.get(&account).is_some(), "make a character first");
        let slot = slot_of(&part);
        let (rarity, _) = item_entry(slot, index);
        require!(index > 0, "the bare default is not an item");
        require!(rarity == 0, "only basic items are free: rarer ones come out of boxes");
        let key = format!("{account}|{}", kind_of(slot, index));
        require!(!self.claimed.contains(&key), "this account already took that item");
        let before = env::storage_usage();
        self.claimed.insert(key);
        let serial = self.mint_item(&account, slot, index);
        let token_id = item_token_id(slot, index, serial);
        NftMint { owner_id: &account, token_ids: &[&token_id], memo: Some("basic") }.emit();
        self.settle(before, by_minter);
        emit("claimed", json!({ "account_id": account, "token_id": token_id }));
        token_id
    }

    /// Dresses the account's character: its traits, and the item tokens it wears (its own, one per part at most).
    #[payable]
    pub fn equip(&mut self, owner: Option<AccountId>, outfit: Outfit) -> CharacterView {
        let (account, by_minter) = self.actor(owner);
        let mut character = self.characters.get(&account).cloned().unwrap_or_else(|| env::panic_str("make a character first"));
        let traits = [outfit.body, outfit.skin, outfit.hair_color, outfit.robe];
        check_traits(traits);
        require!(outfit.worn.len() <= ITEM_SLOTS, "one item per part at most");
        let mut worn = [(0u8, 0u64); ITEM_SLOTS];
        for token_id in &outfit.worn {
            let (slot, index, serial) = parse_item_token(token_id).unwrap_or_else(|| env::panic_str(&format!("{token_id} is not an item")));
            require!(self.tokens.owner_by_id.get(token_id).as_ref() == Some(&account), format!("{token_id} is not this account's"));
            require!(worn[slot].0 == 0, format!("two items for {}", ITEM_PARTS[slot]));
            worn[slot] = (index, serial);
        }
        let before = env::storage_usage();
        character.traits = traits;
        character.worn = worn;
        self.characters.insert(account.clone(), character);
        self.settle(before, by_minter);
        let view = self.view_of(&account).expect("has a character");
        emit("equipped", json!({ "account_id": account, "look": view.look, "worn": view.worn }));
        view
    }

    /// Buys and opens a box: one Rare, Epic or Legendary item, rolled with the chain's randomness. Costs `box_price`
    /// (the rest of the deposit comes back); the item's storage is paid out of the price. Needs a character.
    #[payable]
    pub fn buy_box(&mut self) -> BoxOpened {
        let account = env::predecessor_account_id();
        require!(self.characters.get(&account).is_some(), "make a character first");
        let attached = env::attached_deposit();
        require!(attached >= self.box_price, format!("a box costs {} yoctoNEAR", self.box_price.as_yoctonear()));

        let mut count = self.boxes.get(&account).cloned().unwrap_or_default();
        let rarity = if count.since_legendary + 1 >= LEGENDARY_PITY {
            3
        } else if count.since_epic + 1 >= EPIC_PITY {
            2
        } else {
            let roll = self.below(&account, b"rarity", 10_000);
            if roll < LEGENDARY_BP {
                3
            } else if roll < LEGENDARY_BP + EPIC_BP {
                2
            } else {
                1
            }
        };
        let pool: Vec<(usize, u8)> = (0..ITEM_SLOTS)
            .flat_map(|slot| {
                ITEMS[slot].iter().enumerate().filter(move |(_, (r, _))| *r == rarity).map(move |(index, _)| (slot, index as u8))
            })
            .collect();
        let (slot, index) = pool[self.below(&account, b"item", pool.len() as u32) as usize];

        count.opened += 1;
        count.since_epic = if rarity == 1 { count.since_epic + 1 } else { 0 };
        count.since_legendary = if rarity == 3 { 0 } else { count.since_legendary + 1 };

        let before = env::storage_usage();
        self.boxes.insert(account.clone(), count);
        let serial = self.mint_item(&account, slot, index);
        let token_id = item_token_id(slot, index, serial);
        NftMint { owner_id: &account, token_ids: &[&token_id], memo: Some("box") }.emit();
        self.flush();
        let cost = storage_cost(env::storage_usage().saturating_sub(before));
        let price = self.box_price.as_yoctonear();
        require!(cost <= price, "the box price does not cover the item's storage");
        self.revenue = self.revenue.saturating_add(NearToken::from_yoctonear(price - cost));
        refund(&account, attached.as_yoctonear() - price);

        let opened =
            BoxOpened { token_id, part: ITEM_PARTS[slot].to_string(), index, rarity, name: ITEMS[slot][index as usize].1.to_string() };
        emit("box_opened", json!({ "account_id": account, "box": opened }));
        opened
    }

    // ----- views -------------------------------------------------------------------------------------------------

    pub fn character_of(&self, account_id: AccountId) -> Option<CharacterView> {
        self.view_of(&account_id)
    }

    /// Characters of up to [`MAX_READ`] accounts, in order: `null` for an account with none.
    pub fn characters_of(&self, account_ids: Vec<AccountId>) -> Vec<Option<CharacterView>> {
        require!(account_ids.len() <= MAX_READ, format!("at most {MAX_READ} accounts at once"));
        account_ids.iter().map(|account| self.view_of(account)).collect()
    }

    pub fn name_taken(&self, name: String) -> bool {
        self.names.get(&name.to_lowercase()).is_some()
    }

    /// For each kind (`hat:6`), whether the account already took that basic item.
    pub fn claimed_of(&self, account_id: AccountId, kinds: Vec<String>) -> Vec<bool> {
        require!(kinds.len() <= 200, "at most 200 kinds at once");
        kinds.iter().map(|kind| self.claimed.contains(&format!("{account_id}|{kind}"))).collect()
    }

    pub fn box_count_of(&self, account_id: AccountId) -> BoxCount {
        self.boxes.get(&account_id).cloned().unwrap_or_default()
    }

    /// The box's price and odds, as shown on the shop.
    pub fn box_info(&self) -> Value {
        json!({
            "price": U128(self.box_price.as_yoctonear()),
            "legendaryBp": LEGENDARY_BP,
            "epicBp": EPIC_BP,
            "rareBp": 10_000 - LEGENDARY_BP - EPIC_BP,
            "epicPity": EPIC_PITY,
            "legendaryPity": LEGENDARY_PITY,
        })
    }

    pub fn settings(&self) -> Value {
        json!({
            "owner": self.owner,
            "minter": self.minter,
            "boxPrice": U128(self.box_price.as_yoctonear()),
            "freePool": U128(self.free_pool.as_yoctonear()),
            "revenue": U128(self.revenue.as_yoctonear()),
            "serial": self.serial,
        })
    }

    // ----- owner -------------------------------------------------------------------------------------------------

    /// Adds the attached deposit to the free pool. Anyone may.
    #[payable]
    pub fn fund_free_pool(&mut self) -> U128 {
        let attached = env::attached_deposit();
        require!(attached.as_yoctonear() > 0, "attach what to add");
        self.free_pool = self.free_pool.saturating_add(attached);
        emit("free_pool_funded", json!({ "by": env::predecessor_account_id(), "amount": U128(attached.as_yoctonear()) }));
        U128(self.free_pool.as_yoctonear())
    }

    pub fn set_minter(&mut self, minter_id: AccountId) {
        self.only_owner();
        self.minter = minter_id;
    }

    pub fn set_box_price(&mut self, box_price: U128) {
        self.only_owner();
        self.box_price = NearToken::from_yoctonear(box_price.0);
    }

    /// Sends the box revenue (all of it, or `amount`) to the owner.
    pub fn withdraw_revenue(&mut self, amount: Option<U128>) -> Promise {
        self.only_owner();
        let amount = amount.map(|a| a.0).unwrap_or(self.revenue.as_yoctonear());
        require!(amount > 0 && amount <= self.revenue.as_yoctonear(), "more than the revenue");
        self.revenue = NearToken::from_yoctonear(self.revenue.as_yoctonear() - amount);
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount))
    }
}

impl Contract {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    /// The account a call is for, and whether the minter makes it for somebody else (paid out of the free pool).
    fn actor(&self, owner: Option<AccountId>) -> (AccountId, bool) {
        let caller = env::predecessor_account_id();
        match owner {
            Some(account) if account != caller => {
                require!(caller == self.minter, "only the minter acts for another account");
                (account, true)
            }
            _ => (caller, false),
        }
    }

    fn next_serial(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }

    fn mint_item(&mut self, account: &AccountId, slot: usize, index: u8) -> u64 {
        let (rarity, name) = item_entry(slot, index);
        let serial = self.next_serial();
        let metadata = TokenMetadata {
            title: Some(name.to_string()),
            description: Some(format!("{} {}, a piece of a Deedlords character.", RARITY_NAMES[rarity as usize], name.to_lowercase())),
            issued_at: Some((env::block_timestamp() / 1_000_000).to_string()),
            extra: Some(json!({ "part": ITEM_PARTS[slot], "index": index, "rarity": rarity }).to_string()),
            ..TokenMetadata::default()
        };
        self.tokens.internal_mint_with_refund(item_token_id(slot, index, serial), account.clone(), Some(metadata), None);
        serial
    }

    fn flush(&mut self) {
        self.characters.flush();
        self.names.flush();
        self.boxes.flush();
    }

    /// Charges the storage used since `before`: to the free pool for the minter, else to the attached deposit. The
    /// rest of the deposit goes back to the caller.
    fn settle(&mut self, before: u64, by_minter: bool) {
        self.flush();
        let cost = storage_cost(env::storage_usage().saturating_sub(before));
        let attached = env::attached_deposit().as_yoctonear();
        let kept = if by_minter {
            require!(self.free_pool.as_yoctonear() >= cost, "the free pool is empty: try again later");
            self.free_pool = NearToken::from_yoctonear(self.free_pool.as_yoctonear() - cost);
            0
        } else {
            require!(attached >= cost, format!("attach at least {cost} yoctoNEAR for storage"));
            cost
        };
        refund(&env::predecessor_account_id(), attached - kept);
    }

    fn view_of(&self, account: &AccountId) -> Option<CharacterView> {
        let character = self.characters.get(account)?;
        let mut look = Look::from_traits(character.traits);
        let mut worn = BTreeMap::new();
        for (slot, (index, serial)) in character.worn.iter().enumerate() {
            if *index == 0 {
                continue;
            }
            let token_id = item_token_id(slot, *index, *serial);
            if self.tokens.owner_by_id.get(&token_id).as_ref() == Some(account) {
                look.set_item(slot, *index);
                worn.insert(ITEM_PARTS[slot].to_string(), token_id);
            }
        }
        Some(CharacterView {
            account_id: account.clone(),
            token_id: format!("char:{}", character.serial),
            name: character.name.clone(),
            look,
            worn,
        })
    }

    /// A uniform number below `n`, from `sha256(random_seed ‖ account ‖ draws ‖ salt)`; rejection keeps it unbiased.
    fn below(&mut self, account: &AccountId, salt: &[u8], n: u32) -> u32 {
        require!(n > 0, "nothing to draw from");
        let limit = (u32::MAX / n) * n;
        loop {
            self.draws += 1;
            let mut input = env::random_seed_array().to_vec();
            input.extend_from_slice(account.as_bytes());
            input.extend_from_slice(&self.draws.to_le_bytes());
            input.extend_from_slice(salt);
            let block = env::sha256_array(&input);
            for chunk in block.chunks_exact(4) {
                let value = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                if value < limit {
                    return value % n;
                }
            }
        }
    }
}

fn storage_cost(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * bytes as u128
}

fn refund(account: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(account.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

// ----- NEP-171 -------------------------------------------------------------------------------------------------------

#[near]
impl NonFungibleTokenCore for Contract {
    /// Items move like any NFT; a character stays with its account.
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        require!(!token_id.starts_with("char:"), "a character stays with its account");
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        require!(!token_id.starts_with("char:"), "a character stays with its account");
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<std::collections::HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Deedlords Chibi".to_string(),
            symbol: "CHIBI".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}
