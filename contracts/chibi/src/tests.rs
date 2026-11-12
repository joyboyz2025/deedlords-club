use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::NonFungibleTokenEnumeration;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

use crate::catalog::{ITEMS, ITEM_PARTS};
use crate::*;

const OWNER: &str = "deedlords.testnet";
const MINTER: &str = "free.deedlords.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";
const PRICE: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn context(predecessor: &str, deposit: u128, seed: u8) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acc("chibi.deedlords.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(50))
        .random_seed([seed; 32]);
    testing_env!(builder.build());
}

fn contract() -> Contract {
    context(OWNER, 0, 0);
    let mut c = Contract::new(acc(OWNER), acc(MINTER), U128(PRICE));
    context(OWNER, 2 * NEAR, 0);
    c.fund_free_pool();
    c
}

/// A boy with short hair (2), a conical hat (1), a paper fan (1) and the everyday shirt (0, bare).
fn basic_look() -> Look {
    Look { body: 0, skin: 1, hair: 2, hair_color: 0, outfit: 0, robe: 3, neck: 0, hat: 1, face: 0, held: 1, shoes: 0, pet: 0, ride: 0 }
}

fn made(c: &mut Contract, account: &str, name: &str) -> CharacterView {
    context(MINTER, 0, 1);
    c.create_character(Some(acc(account)), name.to_string(), basic_look())
}

fn transfers_to(account: &str) -> u128 {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id == acc(account))
        .flat_map(|r| r.actions.iter())
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

#[test]
fn the_catalogue_is_the_games() {
    assert_eq!(ITEM_PARTS.len(), 9);
    // Every part has its bare default, basic at index 0; boxes have something of every rarity to give.
    for items in ITEMS.iter() {
        assert_eq!(items[0].0, 0);
    }
    for rarity in 1..=3u8 {
        assert!(ITEMS.iter().any(|items| items.iter().any(|(r, _)| *r == rarity)), "no item of rarity {rarity}");
    }
}

#[test]
fn the_minter_makes_a_character_for_free() {
    let mut c = contract();
    let pool = c.free_pool.as_yoctonear();
    let view = made(&mut c, ALICE, "Hải Lord");
    assert_eq!(view.name, "Hải Lord");
    assert_eq!(view.look, basic_look());
    assert_eq!(view.worn.len(), 3, "hair, hat, held");
    assert_eq!(view.worn["hat"], "hat:1:2");
    // The character and three items are Alice's NFTs.
    let tokens = c.nft_tokens_for_owner(acc(ALICE), None, None);
    assert_eq!(tokens.len(), 4);
    assert!(tokens.iter().any(|t| t.token_id == view.token_id));
    assert_eq!(c.tokens.nft_token("hair:2:4".into()).unwrap().metadata.unwrap().title.as_deref(), Some("Short"));
    // The pool paid; the minter attached nothing and gets nothing back.
    assert!(c.free_pool.as_yoctonear() < pool);
    assert_eq!(transfers_to(MINTER), 0);
    assert!(get_logs().iter().any(|l| l.contains("\"nft_mint\"")));
    assert!(get_logs().iter().any(|l| l.contains("\"character_created\"")));
    assert_eq!(c.character_of(acc(BOB)), None);
    assert_eq!(c.characters_of(vec![acc(BOB), acc(ALICE)]), vec![None, Some(view)]);
}

#[test]
fn an_account_pays_for_its_own_character() {
    let mut c = contract();
    let pool = c.free_pool.as_yoctonear();
    context(ALICE, NEAR, 1);
    c.create_character(None, "Alice".into(), basic_look());
    assert_eq!(c.free_pool.as_yoctonear(), pool, "the pool is for the minter's calls only");
    let back = transfers_to(ALICE);
    assert!(back > 0 && back < NEAR, "the rest of the deposit comes back");
}

#[test]
#[should_panic(expected = "attach at least")]
fn an_account_without_a_deposit_cannot_make_its_own() {
    let mut c = contract();
    context(ALICE, 0, 1);
    c.create_character(None, "Alice".into(), basic_look());
}

#[test]
#[should_panic(expected = "only the minter acts for another account")]
fn nobody_else_makes_a_character_for_an_account() {
    let mut c = contract();
    context(BOB, NEAR, 1);
    c.create_character(Some(acc(ALICE)), "Alice".into(), basic_look());
}

#[test]
#[should_panic(expected = "basic items only")]
fn a_new_character_wears_no_rare_item() {
    let mut c = contract();
    context(MINTER, 0, 1);
    c.create_character(Some(acc(ALICE)), "Alice".into(), Look { outfit: 5, ..basic_look() });
}

#[test]
#[should_panic(expected = "that name is taken")]
fn names_are_unique_in_any_case() {
    let mut c = contract();
    made(&mut c, ALICE, "Lord Hai");
    made(&mut c, BOB, "LORD HAI");
}

#[test]
#[should_panic(expected = "already has a character")]
fn one_character_per_account() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    made(&mut c, ALICE, "Alice Two");
}

#[test]
fn names_are_checked() {
    for bad in ["A", " Alice", "Alice ", "Al  ice", "<script>", "12345", "abcdefghijklmnopqrstu"] {
        let result = std::panic::catch_unwind(|| check_name(bad));
        assert!(result.is_err(), "{bad:?} should be refused");
    }
    assert_eq!(check_name("Bà Chúa Đất"), "bà chúa đất");
    assert_eq!(check_name("o'neil_2.0"), "o'neil_2.0");
}

#[test]
#[should_panic(expected = "skin must be below 5")]
fn traits_are_checked() {
    let mut c = contract();
    context(MINTER, 0, 1);
    c.create_character(Some(acc(ALICE)), "Alice".into(), Look { skin: 5, ..basic_look() });
}

#[test]
fn a_basic_item_is_claimed_once() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(MINTER, 0, 1);
    let id = c.claim(Some(acc(ALICE)), "hat".into(), 4);
    assert_eq!(c.tokens.nft_token(id.clone()).unwrap().owner_id, acc(ALICE));
    assert_eq!(c.claimed_of(acc(ALICE), vec!["hat:4".into(), "hat:1".into(), "hat:5".into()]), vec![true, true, false]);
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        context(MINTER, 0, 1);
        c.claim(Some(acc(ALICE)), "hat".into(), 4)
    }));
    assert!(again.is_err());
}

#[test]
#[should_panic(expected = "only basic items are free")]
fn a_rare_item_is_not_claimed() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(MINTER, 0, 1);
    c.claim(Some(acc(ALICE)), "hat".into(), 6);
}

#[test]
#[should_panic(expected = "make a character first")]
fn claiming_needs_a_character() {
    let mut c = contract();
    context(MINTER, 0, 1);
    c.claim(Some(acc(ALICE)), "hat".into(), 4);
}

#[test]
#[should_panic(expected = "the free pool is empty")]
fn the_free_pool_runs_out() {
    context(OWNER, 0, 0);
    let mut c = Contract::new(acc(OWNER), acc(MINTER), U128(PRICE));
    made(&mut c, ALICE, "Alice");
}

#[test]
fn equipping_wears_own_items_only_and_costs_no_storage() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(MINTER, 0, 1);
    let straw = c.claim(Some(acc(ALICE)), "hat".into(), 4);
    let pool = c.free_pool.as_yoctonear();
    context(MINTER, 0, 1);
    let view = c.equip(Some(acc(ALICE)), Outfit { body: 1, skin: 2, hair_color: 5, robe: 0, worn: vec![straw.clone(), "hair:2:4".into()] });
    assert_eq!(view.look, Look { body: 1, skin: 2, hair: 2, hair_color: 5, robe: 0, hat: 4, ..Look::default() });
    assert_eq!(c.free_pool.as_yoctonear(), pool, "dressing up uses no storage");
    // Alice may dress herself without a deposit too.
    context(ALICE, 0, 1);
    let bare = c.equip(None, Outfit { body: 1, skin: 2, hair_color: 5, robe: 0, worn: vec![] });
    assert!(bare.worn.is_empty());
}

#[test]
#[should_panic(expected = "is not this account's")]
fn nobody_wears_another_accounts_item() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    made(&mut c, BOB, "Bob");
    context(BOB, 0, 1);
    c.equip(None, Outfit { body: 0, skin: 0, hair_color: 0, robe: 0, worn: vec!["hat:1:2".into()] });
}

#[test]
#[should_panic(expected = "two items for hat")]
fn one_item_per_part() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(MINTER, 0, 1);
    let straw = c.claim(Some(acc(ALICE)), "hat".into(), 4);
    context(ALICE, 0, 1);
    c.equip(None, Outfit { body: 0, skin: 0, hair_color: 0, robe: 0, worn: vec![straw, "hat:1:2".into()] });
}

#[test]
fn an_item_given_away_is_no_longer_worn() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(ALICE, 1, 1);
    c.nft_transfer(acc(BOB), "hat:1:2".into(), None, None);
    let view = c.character_of(acc(ALICE)).unwrap();
    assert_eq!(view.look.hat, 0);
    assert!(!view.worn.contains_key("hat"));
    assert_eq!(c.tokens.nft_token("hat:1:2".into()).unwrap().owner_id, acc(BOB));
}

#[test]
#[should_panic(expected = "a character stays with its account")]
fn a_character_is_not_transferred() {
    let mut c = contract();
    let view = made(&mut c, ALICE, "Alice");
    context(ALICE, 1, 1);
    c.nft_transfer(acc(BOB), view.token_id, None, None);
}

#[test]
fn a_box_gives_a_rarer_item_for_its_price() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(ALICE, PRICE + NEAR, 7);
    let opened = c.buy_box();
    assert!(opened.rarity >= 1);
    let slot = ITEM_PARTS.iter().position(|p| *p == opened.part).unwrap();
    assert_eq!(ITEMS[slot][opened.index as usize].0, opened.rarity);
    assert_eq!(c.tokens.nft_token(opened.token_id.clone()).unwrap().owner_id, acc(ALICE));
    assert_eq!(transfers_to(ALICE), NEAR, "everything above the price comes back");
    let revenue = c.revenue.as_yoctonear();
    assert!(revenue > 0 && revenue < PRICE, "the price less the item's storage");
    assert_eq!(c.box_count_of(acc(ALICE)).opened, 1);
    assert!(get_logs().iter().any(|l| l.contains("\"box_opened\"")));
    // What came out of the box can be worn.
    context(ALICE, 0, 1);
    let view = c.equip(None, Outfit { body: 0, skin: 1, hair_color: 0, robe: 3, worn: vec![opened.token_id.clone()] });
    assert_eq!(view.worn[&opened.part], opened.token_id);
}

#[test]
#[should_panic(expected = "a box costs")]
fn a_box_is_paid_for() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(ALICE, PRICE - 1, 7);
    c.buy_box();
}

#[test]
#[should_panic(expected = "make a character first")]
fn a_box_needs_a_character() {
    let mut c = contract();
    context(ALICE, PRICE, 7);
    c.buy_box();
}

#[test]
fn the_odds_are_about_right_and_pity_holds() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    let mut by_rarity = [0u32; 4];
    let mut since_epic = 0;
    let mut since_legendary = 0;
    for n in 0..2_000u32 {
        context(ALICE, PRICE, (n % 251) as u8);
        let opened = c.buy_box();
        by_rarity[opened.rarity as usize] += 1;
        since_epic = if opened.rarity == 1 { since_epic + 1 } else { 0 };
        since_legendary = if opened.rarity == 3 { 0 } else { since_legendary + 1 };
        assert!(since_epic < EPIC_PITY, "ten Rare in a row");
        assert!(since_legendary < LEGENDARY_PITY, "fifty without a Legendary");
    }
    // Pity lifts Epic and Legendary above their base 15% and 2%; Rare stays the most common.
    assert!(by_rarity[1] > by_rarity[2] && by_rarity[2] > by_rarity[3] && by_rarity[3] > 0, "{by_rarity:?}");
    assert!(by_rarity[2] > 300 && by_rarity[2] < 600, "{by_rarity:?}");
    assert!(by_rarity[3] > 40 && by_rarity[3] < 120, "{by_rarity:?}");
    assert_eq!(by_rarity[0], 0);
}

#[test]
fn the_owner_withdraws_the_revenue_and_nothing_more() {
    let mut c = contract();
    made(&mut c, ALICE, "Alice");
    context(ALICE, PRICE, 7);
    c.buy_box();
    let revenue = c.revenue.as_yoctonear();
    context(OWNER, 0, 1);
    let too_much = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw_revenue(Some(U128(revenue + 1)))));
    assert!(too_much.is_err());
    context(OWNER, 0, 1);
    let _ = c.withdraw_revenue(None);
    assert_eq!(c.revenue.as_yoctonear(), 0);
    assert_eq!(transfers_to(OWNER), revenue);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_sets_the_price() {
    let mut c = contract();
    context(ALICE, 0, 1);
    c.set_box_price(U128(1));
}

#[test]
fn item_token_ids_parse() {
    assert_eq!(parse_item_token("hat:6:41"), Some((2, 6, 41)));
    assert_eq!(parse_item_token("hat:0:41"), None);
    assert_eq!(parse_item_token("hat:06:41"), None);
    assert_eq!(parse_item_token("hat:99:41"), None);
    assert_eq!(parse_item_token("char:1"), None);
    assert_eq!(parse_item_token("cape:1:1"), None);
    assert_eq!(c_supply(), 0);
}

fn c_supply() -> u128 {
    contract().nft_total_supply().0
}
