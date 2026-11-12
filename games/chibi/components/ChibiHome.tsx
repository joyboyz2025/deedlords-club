"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Arrow, Gem, Spark, User } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { formatNear, shortAccount } from "../../co-ty-phu/chain/adapt";
import { useDevConfig } from "../../co-ty-phu/chain/devSession";
import { useFreeSponsor } from "../../co-ty-phu/chain/useFree";
import { usePlayer, type Player, type PlayerState } from "../../co-ty-phu/chain/usePlayer";
import { Hall, PassengerStub, type HallPage } from "../../co-ty-phu/components/Desk";
import { ITEM_PARTS, LOOK_CHOICES, isItemPart, lookKey, randomLook, rarityOf, starterLook, type ItemPart, type Look, type LookPart } from "../../ma-soi/look";
import { BARE_LOOK, BASIC_ITEMS, kindOf, nameOf, rarityName, wornKinds, type CatalogItem } from "../catalog";
import {
  claimItem,
  createCharacter,
  equip,
  isNameTaken,
  outfitOf,
  readBag,
  readBoxCount,
  readBoxInfo,
  readClaimed,
  type BoxCount,
  type BoxInfo,
  type BoxOpened,
  type Character,
  type ItemToken,
} from "../chain";
import { PART_NAMES_EN, RARITY_EN } from "../names";
import { buyBox, useCharacter, useLookPictures, useReload } from "../useChibi";
import { ChibiStage, Dresser, RarityMark } from "./Dresser";

// The character pages of the hall: making one's character (/character), the shop (/shop) and the bag (/bag). The
// character and everything it wears are NFTs of the chibi contract; free things are made by the house's sponsor, a
// box is paid with the account's own NEAR.

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const tokenUrl = (tokenId: string) => `${CHAIN.explorerUrl}/nft-token/${CHAIN.chibiId}/${encodeURIComponent(tokenId)}`;
/** What a box needs on top of its price: the gas the network holds while it runs (about 0.003 NEAR) and some room. */
const BOX_HOLD = 10_000_000_000_000_000_000_000n;
const SERIAL = (tokenId: string) => Number(tokenId.split(":").pop() ?? 0);

/** The name rules of the contract, checked here first so the person learns at once. `null`: fine. */
export function nameProblem(name: string): string | null {
  const count = [...name].length;
  if (count < 2 || count > 20) return "2 to 20 characters.";
  if (name.trim() !== name || name.includes("  ")) return "No spaces at the ends, and no two in a row.";
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(name)) return "Letters, digits, spaces and - _ . ' only.";
  if (!/\p{L}/u.test(name)) return "At least one letter.";
  return null;
}

type Shell = { state: PlayerState; page: HallPage; children: (player: Player, character: Character | null | undefined) => ReactNode; title: string; lede: string };

/** Every character page: the hall, a sign-in desk for a visitor who is nobody yet, and the page once somebody is. */
function ChibiShell({ state, page, title, lede, children }: Shell) {
  const { player } = state;
  const helper = useDevConfig();
  const sponsor = useFreeSponsor();
  const character = useCharacter(player?.accountId);
  const account = player === undefined ? undefined : player && { accountId: player.accountId, balance: state.balance };
  if (player === undefined)
    return (
      <Hall page={page} account={account}>
        <p className="fd-lede cb-wait">Signing in…</p>
      </Hall>
    );
  if (!player)
    return (
      <Hall page={page} account={account}>
        <div className="fd-hall">
          <section className="fd-wall">
            <h1 className="fd-line">{title}</h1>
            <p className="fd-lede">{lede}</p>
            <p className="fd-lede">Check in first: a guest account is enough, and making a character costs it nothing.</p>
          </section>
          <aside className="fd-ticket" aria-label="Check in">
            <PassengerStub state={state} helper={helper} freePlay={Boolean(sponsor)} />
          </aside>
        </div>
      </Hall>
    );
  return (
    <Hall page={page} account={account}>
      {children(player, character)}
    </Hall>
  );
}

function NeedsCharacter({ what }: { what: string }) {
  return (
    <div className="fd-hall">
      <section className="fd-wall">
        <h1 className="fd-line">First, your character.</h1>
        <p className="fd-lede">{what} belongs to a character. Make yours: it is free, and it is yours as an NFT.</p>
        <Link className="cb-link" href="/character">
          <User size={18} /> Make my character <Arrow size={18} />
        </Link>
      </section>
    </div>
  );
}

// ----- /character -------------------------------------------------------------------------------------------------

export function CharacterHome() {
  const state = usePlayer();
  return (
    <ChibiShell
      state={state}
      page="character"
      title="Your character, your face at every table."
      lede="Pick a name and a chibi look. The character and every piece it wears are NFTs on NEAR, minted for you for free."
    >
      {(player, character) =>
        character === undefined ? (
          <p className="fd-lede cb-wait">Reading your character…</p>
        ) : character === null ? (
          <MakeCharacter player={player} />
        ) : (
          <CharacterCard character={character} />
        )
      }
    </ChibiShell>
  );
}

function MakeCharacter({ player }: { player: Player }) {
  const [look, setLook] = useState<Look>(BARE_LOOK);
  const [name, setName] = useState("");
  const [taken, setTaken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Somebody new starts as an ordinary person in an everyday shirt, then dresses up.
  useEffect(() => setLook(starterLook()), []);

  const problem = name === "" ? null : nameProblem(name);
  useEffect(() => {
    setTaken(null);
    if (!name || nameProblem(name)) return;
    const timer = setTimeout(() => {
      isNameTaken(name).then(
        (yes) => setTaken(yes ? name : null),
        () => undefined,
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [name]);

  const minted = wornKinds(look);
  const mint = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await createCharacter(player.session, name, look);
    } catch (error) {
      setFailed(problemText(error));
      setBusy(false);
    }
  };
  const ready = name !== "" && !problem && taken !== name && !busy;

  return (
    <div className="fd-hall cb-hall">
      <section className="fd-wall">
        <h1 className="fd-line">Who is boarding?</h1>
        <p className="fd-lede">
          Pick a look from the wardrobe and give it a name nobody has. Your character sits at every Deedlords table in your place, and what it wears is yours to keep, trade or
          dress up in later.
        </p>
        <section className="fd-board cb-board" aria-label="Wardrobe">
          <h2 className="fd-board__title">
            <User size={24} /> <span>Wardrobe</span>
            <span className="fd-board__state">
              <span className="fd-chip">Basic pieces · free</span>
            </span>
          </h2>
          <Dresser
            look={look}
            onChange={setLook}
            allowed={(part, index) => !isItemPart(part) || rarityOf(part, index) === 0}
            onShuffle={() => setLook(randomLook())}
            hint="Rare, Epic and Legendary pieces come out of boxes in the shop, once your character exists."
          />
        </section>
      </section>
      <aside className="fd-ticket" aria-label="Your character">
        <section className="fd-stub">
          <h2 className="fd-stub__title">Boarding name</h2>
          <label className="cb-field">
            <span>Name, shown at every table</span>
            <input value={name} maxLength={24} autoComplete="nickname" spellCheck={false} placeholder="Lord of Monaco" onChange={(event) => setName(event.target.value)} />
          </label>
          {problem && <p className="fd-problem">{problem}</p>}
          {taken === name && name !== "" && <p className="fd-problem">“{name}” is taken. Try another.</p>}
        </section>
        <section className="fd-stub">
          <h2 className="fd-stub__title">Minted to you</h2>
          <ul className="cb-mint">
            <li>
              <b>Character</b> <span>{name || "your name"}</span>
            </li>
            {minted.map((kind) => {
              const [part, index] = kind.split(":");
              return (
                <li key={kind}>
                  <b>{PART_NAMES_EN[part as LookPart]}</b> <span>{nameOf(part as LookPart, Number(index))}</span>
                </li>
              );
            })}
          </ul>
          <p className="fd-fine">
            {1 + minted.length} NFTs on {CHAIN.chibiId}, owned by {shortAccount(player.accountId)}. The house pays their storage and the gas: your account needs no NEAR.
          </p>
          {failed && <p className="fd-problem">{failed}</p>}
          <button type="button" className="fd-go" disabled={!ready} onClick={mint}>
            {busy ? "Minting…" : "Mint my character · Free"}
            {!busy && <Arrow size={20} />}
          </button>
        </section>
      </aside>
    </div>
  );
}

function CharacterCard({ character }: { character: Character }) {
  const worn = ITEM_PARTS.filter((part) => character.look[part] > 0);
  return (
    <div className="fd-hall cb-hall">
      <section className="fd-wall">
        <h1 className="fd-line">{character.name}</h1>
        <p className="fd-lede">Your character on NEAR {CHAIN.network}. It sits at every Deedlords table in your place, by this name and this face.</p>
        <section className="fd-board cb-board" aria-label="Your character">
          <h2 className="fd-board__title">
            <User size={24} /> <span>On board</span>
          </h2>
          <div className="cb-card">
            <ChibiStage look={character.look} label={`${character.name}, drag to turn`} />
            <ul className="cb-worn">
              {worn.length === 0 && <li className="cb-worn__none">Nothing but the basics.</li>}
              {worn.map((part) => (
                <li key={part}>
                  <small>{PART_NAMES_EN[part]}</small>
                  <span>
                    <RarityMark part={part} index={character.look[part]} /> {nameOf(part, character.look[part])}
                  </span>
                  {character.worn[part] && (
                    <a href={tokenUrl(character.worn[part])} target="_blank" rel="noreferrer">
                      {character.worn[part]}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="cb-actions">
            <Link className="cb-link" href="/bag">
              Dress up from your bag <Arrow size={18} />
            </Link>
            <Link className="cb-link" href="/shop">
              <Gem size={18} /> The shop <Arrow size={18} />
            </Link>
          </div>
        </section>
      </section>
      <aside className="fd-ticket" aria-label="Character NFT">
        <section className="fd-stub">
          <h2 className="fd-stub__title">Character NFT</h2>
          <dl className="cb-facts">
            <div>
              <dt>Token</dt>
              <dd>
                <a href={tokenUrl(character.tokenId)} target="_blank" rel="noreferrer">
                  {character.tokenId}
                </a>
              </dd>
            </div>
            <div>
              <dt>Contract</dt>
              <dd>{CHAIN.chibiId}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd title={character.accountId}>{shortAccount(character.accountId)}</dd>
            </div>
          </dl>
          <p className="fd-fine">A character stays with its account: its pieces can be traded, the character itself cannot. Its name is yours alone in the whole hall.</p>
        </section>
      </aside>
    </div>
  );
}

// ----- /bag -------------------------------------------------------------------------------------------------------

export function BagHome() {
  const state = usePlayer();
  return (
    <ChibiShell state={state} page="bag" title="Your bag." lede="Everything your character owns, as NFTs. Dress up in any of it.">
      {(player, character) =>
        character === undefined ? (
          <p className="fd-lede cb-wait">Reading your bag…</p>
        ) : character === null ? (
          <NeedsCharacter what="A bag" />
        ) : (
          <Bag player={player} character={character} />
        )
      }
    </ChibiShell>
  );
}

/** The kinds held, with their tokens: `hat:4` → [`hat:4:12`, …]. */
function tokensByKind(bag: ItemToken[]): Map<string, string[]> {
  const kinds = new Map<string, string[]>();
  for (const token of bag) kinds.set(token.kind, [...(kinds.get(token.kind) ?? []), token.tokenId]);
  return kinds;
}

/** The tokens a look wears, preferring the ones worn now. */
function wornTokens(look: Look, character: Character, held: Map<string, string[]>): Record<string, string | null> {
  const worn: Record<string, string | null> = {};
  for (const part of ITEM_PARTS) {
    const index = look[part];
    const now = character.worn[part];
    worn[part] = index === 0 ? null : now && now.startsWith(`${kindOf(part, index)}:`) ? now : (held.get(kindOf(part, index))?.[0] ?? null);
  }
  return worn;
}

function Bag({ player, character }: { player: Player; character: Character }) {
  const [bag, setBag] = useState<ItemToken[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Look>(character.look);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [round, reload] = useReload();

  useEffect(() => {
    readBag(player.accountId).then(setBag, (error) => setFailed(problemText(error)));
  }, [player.accountId, round]);
  // Back to what is worn when that changes on chain, not each time the character is read again (once a minute).
  const wornKey = lookKey(character.look);
  useEffect(() => setDraft(character.look), [wornKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const held = useMemo(() => tokensByKind(bag ?? []), [bag]);
  const changed = lookKey(draft) !== lookKey(character.look);
  const save = async () => {
    setBusy(true);
    setFailed(null);
    setSaved(false);
    try {
      const worn = wornTokens(draft, character, held);
      await equip(player.session, outfitOf(character, { traits: { body: draft.body, skin: draft.skin, hairColor: draft.hairColor, robe: draft.robe }, worn }));
      setSaved(true);
    } catch (error) {
      setFailed(problemText(error));
    }
    setBusy(false);
  };
  const toggle = (token: ItemToken) => setDraft((look) => ({ ...look, [token.part]: look[token.part] === token.index ? 0 : token.index }));
  const sorted = [...(bag ?? [])].sort((a, b) => b.rarity - a.rarity || ITEM_PARTS.indexOf(a.part) - ITEM_PARTS.indexOf(b.part) || a.index - b.index);

  return (
    <div className="fd-hall cb-hall">
      <section className="fd-wall">
        <h1 className="fd-line">{character.name}’s bag.</h1>
        <p className="fd-lede">Try things on, then wear the look. Every piece below is an NFT you hold: what you give away or trade is no longer worn.</p>
        <section className="fd-board cb-board" aria-label="Dress up">
          <h2 className="fd-board__title">
            <User size={24} /> <span>Dress up</span>
          </h2>
          {bag === null ? (
            <p className="fd-board__note">{failed ?? "Reading your NFTs…"}</p>
          ) : (
            <Dresser
              look={draft}
              onChange={(look) => {
                setSaved(false);
                setDraft(look);
              }}
              allowed={(part, index) => !isItemPart(part) || index === 0 || held.has(kindOf(part, index))}
              badge={(part, index) => {
                const count = isItemPart(part) && index > 0 ? (held.get(kindOf(part, index))?.length ?? 0) : 0;
                return count > 1 ? `×${count}` : null;
              }}
              hint={bag.length === 0 ? "Your bag holds no pieces yet: take basic ones free in the shop, or open a box." : null}
            />
          )}
        </section>
        <section className="fd-board" aria-label="Your NFTs">
          <h2 className="fd-board__title">
            <Gem size={24} /> <span>In the bag</span>
            <span className="fd-board__state">
              <span className="fd-chip">{bag === null ? "…" : `${bag.length} ${bag.length === 1 ? "piece" : "pieces"}`}</span>
            </span>
          </h2>
          {bag !== null && bag.length > 0 && (
            <ul className="cb-items">
              {sorted.map((token) => {
                const wearing = draft[token.part] === token.index;
                return (
                  <li key={token.tokenId} data-rarity={token.rarity}>
                    <button type="button" aria-pressed={wearing} onClick={() => toggle(token)}>
                      <span className="cb-items__name">
                        <RarityMark part={token.part} index={token.index} /> {token.name}
                      </span>
                      <small>
                        {RARITY_EN[token.rarity]} · {PART_NAMES_EN[token.part]}
                      </small>
                    </button>
                    <a href={tokenUrl(token.tokenId)} target="_blank" rel="noreferrer" title="This NFT on NearBlocks">
                      {token.tokenId}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          <Link className="cb-link" href="/shop">
            <Gem size={18} /> More in the shop <Arrow size={18} />
          </Link>
        </section>
      </section>
      <aside className="fd-ticket" aria-label="Wear this look">
        <section className="fd-stub">
          <h2 className="fd-stub__title">Wear this look</h2>
          <p className="fd-small">Every table shows your character as you dress it here. Changing costs nothing: the house pays the gas.</p>
          {failed && bag !== null && <p className="fd-problem">{failed}</p>}
          {saved && !changed && <p className="cb-done">Worn. The tables show it now.</p>}
          <button type="button" className="fd-go" disabled={!changed || busy || bag === null} onClick={save}>
            {busy ? "Dressing…" : changed ? "Wear this look" : "This is the look you wear"}
            {!busy && changed && <Arrow size={20} />}
          </button>
          {changed && (
            <button type="button" className="fd-pill" onClick={() => setDraft(character.look)}>
              Back to what I wear
            </button>
          )}
          <button type="button" className="fd-pill" onClick={reload}>
            Read the bag again
          </button>
        </section>
      </aside>
    </div>
  );
}

// ----- /shop ------------------------------------------------------------------------------------------------------

export function ShopHome() {
  const state = usePlayer();
  return (
    <ChibiShell state={state} page="shop" title="The shop." lede="Basic pieces are free to mint. Rare, Epic and Legendary ones only come out of boxes, paid in NEAR.">
      {(player, character) =>
        character === undefined ? (
          <p className="fd-lede cb-wait">Opening the shop…</p>
        ) : character === null ? (
          <NeedsCharacter what="What you buy" />
        ) : (
          <Shop player={player} character={character} balance={state.balance} refreshBalance={state.refreshBalance} />
        )
      }
    </ChibiShell>
  );
}

const SHOP_PARTS: ItemPart[] = ["outfit", "hat", "held", "neck", "face", "shoes", "hair"];
const percent = (bp: number) => `${(bp / 100).toLocaleString("en", { maximumFractionDigits: 1 })}%`;

function Shop({ player, character, balance, refreshBalance }: { player: Player; character: Character; balance: bigint | null | undefined; refreshBalance: () => Promise<void> }) {
  const [box, setBox] = useState<BoxInfo | null>(null);
  const [count, setCount] = useState<BoxCount | null>(null);
  const [claimed, setClaimed] = useState<Set<string> | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [opened, setOpened] = useState<BoxOpened | null>(null);
  const [wearing, setWearing] = useState(false);
  const [worn, setWorn] = useState(false);

  useEffect(() => {
    readBoxInfo().then(setBox, () => undefined);
    readBoxCount(player.accountId).then(setCount, () => undefined);
    readClaimed(
      player.accountId,
      BASIC_ITEMS.map((item) => item.kind),
    ).then(setClaimed, (error) => setFailed(problemText(error)));
  }, [player.accountId]);

  const looks = useMemo(() => BASIC_ITEMS.map((item) => ({ ...character.look, [item.part]: item.index })), [character]);
  const pictures = useLookPictures(looks, 150, "figure");
  const revealLook = opened && LOOK_CHOICES[opened.part as LookPart] ? { ...character.look, [opened.part]: opened.index } : null;
  const [revealPicture] = useLookPictures([revealLook], 240, "figure");

  const claim = async (item: CatalogItem) => {
    setClaiming(item.kind);
    setFailed(null);
    try {
      await claimItem(player.session, item.part, item.index);
      setClaimed((before) => new Set(before ?? []).add(item.kind));
    } catch (error) {
      setFailed(problemText(error));
    }
    setClaiming(null);
  };

  const enough = box !== null && typeof balance === "bigint" && balance >= box.price + BOX_HOLD;
  const open = async () => {
    if (!box) return;
    setBuying(true);
    setFailed(null);
    setOpened(null);
    setWorn(false);
    try {
      let result = await buyBox(player, box.price);
      if (!result) {
        // A wallet does not say what came out: the newest piece in the bag did.
        const newest = (await readBag(player.accountId)).sort((a, b) => SERIAL(b.tokenId) - SERIAL(a.tokenId))[0];
        if (newest) result = { tokenId: newest.tokenId, part: newest.part, index: newest.index, rarity: newest.rarity, name: newest.name };
      }
      setOpened(result);
      readBoxCount(player.accountId).then(setCount, () => undefined);
      void refreshBalance();
    } catch (error) {
      setFailed(problemText(error));
    }
    setBuying(false);
  };
  const wearIt = async () => {
    if (!opened) return;
    setWearing(true);
    setFailed(null);
    try {
      await equip(player.session, outfitOf(character, { worn: { [opened.part]: opened.tokenId } }));
      setWorn(true);
    } catch (error) {
      setFailed(problemText(error));
    }
    setWearing(false);
  };

  return (
    <div className="fd-hall cb-hall">
      <section className="fd-wall">
        <h1 className="fd-line">The shop.</h1>
        <p className="fd-lede">Basic pieces are free: take one of each, minted to you as an NFT. Rare, Epic and Legendary pieces only come out of boxes, paid in NEAR.</p>
        <section className="fd-board cb-board" aria-label="Boxes">
          <h2 className="fd-board__title">
            <Spark size={24} /> <span>Mystery box</span>
            <span className="fd-board__state">
              <span className="fd-chip">{box ? `${formatNear(box.price.toString())} NEAR` : "…"}</span>
            </span>
          </h2>
          <div className="cb-box">
            <div className="cb-box__crate" aria-hidden="true">
              <span>?</span>
            </div>
            <div>
              <p className="cb-box__line">One piece you cannot get anywhere else, rolled by the contract with the chain’s own randomness.</p>
              {box && (
                <dl className="cb-odds">
                  <div data-rarity="1">
                    <dt>Rare</dt>
                    <dd>{percent(box.rareBp)}</dd>
                  </div>
                  <div data-rarity="2">
                    <dt>Epic</dt>
                    <dd>{percent(box.epicBp)}</dd>
                  </div>
                  <div data-rarity="3">
                    <dt>Legendary</dt>
                    <dd>{percent(box.legendaryBp)}</dd>
                  </div>
                </dl>
              )}
              {box && (
                <p className="cb-box__fine">
                  {box.epicPity - 1} boxes in a row with only Rare: the {box.epicPity}th is Epic. {box.legendaryPity - 1} in a row without a Legendary: the {box.legendaryPity}th is
                  one.
                  {count && count.opened > 0 && ` You opened ${count.opened}; ${box.legendaryPity - count.sinceLegendary} to go to a sure Legendary.`}
                </p>
              )}
            </div>
          </div>
        </section>
        <section className="fd-board" aria-label="Basic pieces">
          <h2 className="fd-board__title">
            <Gem size={24} /> <span>Basic counter</span>
            <span className="fd-board__state">
              <span className="fd-chip">Free · one of each</span>
            </span>
          </h2>
          {SHOP_PARTS.map((part) => (
            <section key={part} className="cb-shelf" aria-label={PART_NAMES_EN[part]}>
              <h3>{PART_NAMES_EN[part]}</h3>
              <ul>
                {BASIC_ITEMS.map((item, i) => {
                  if (item.part !== part) return null;
                  const has = claimed?.has(item.kind) ?? false;
                  return (
                    <li key={item.kind}>
                      <span className="cb-shelf__pic">{pictures[i] ? <img src={pictures[i]!} alt="" /> : null}</span>
                      <strong>{item.name}</strong>
                      {has ? (
                        <span className="cb-shelf__has">In your bag</span>
                      ) : (
                        <button type="button" className="cb-take" disabled={claimed === null || claiming !== null} onClick={() => claim(item)}>
                          {claiming === item.kind ? "Minting…" : "Take · Free"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </section>
      </section>
      <aside className="fd-ticket" aria-label="Open a box">
        <section className="fd-stub">
          <h2 className="fd-stub__title">Open a box</h2>
          <dl className="cb-facts">
            <div>
              <dt>Price</dt>
              <dd>{box ? `${formatNear(box.price.toString())} NEAR` : "…"}</dd>
            </div>
            <div>
              <dt>You hold</dt>
              <dd>{typeof balance === "bigint" ? `${formatNear(balance.toString(), 3)} NEAR` : balance === null ? "0 NEAR" : "…"}</dd>
            </div>
          </dl>
          {failed && <p className="fd-problem">{failed}</p>}
          <button type="button" className="fd-go" disabled={!enough || buying} onClick={open}>
            {buying ? "Opening…" : box ? `Open a box · ${formatNear(box.price.toString())} NEAR` : "Open a box"}
            {!buying && <Arrow size={20} />}
          </button>
          {box && !enough && !buying && (
            <p className="fd-fine">
              A box is paid with your own NEAR: {formatNear((box.price + BOX_HOLD).toString(), 2)} NEAR with the gas. Send test NEAR to your account on the{" "}
              <Link href="/account">account page</Link>.
            </p>
          )}
        </section>
        {opened && (
          <section className="fd-stub cb-reveal" data-rarity={opened.rarity} aria-live="polite">
            <h2 className="fd-stub__title">{RARITY_EN[opened.rarity as 1 | 2 | 3] ?? rarityName(0)}!</h2>
            <span className="cb-reveal__pic">{revealPicture ? <img src={revealPicture} alt={`${character.name} wearing ${opened.name}`} /> : null}</span>
            <p className="cb-reveal__name">{opened.name}</p>
            <p className="fd-fine">
              <a href={tokenUrl(opened.tokenId)} target="_blank" rel="noreferrer">
                {opened.tokenId}
              </a>
              , minted to you.
            </p>
            {worn ? (
              <p className="cb-done">Worn. Every table shows it now.</p>
            ) : (
              <button type="button" className="fd-go" disabled={wearing} onClick={wearIt}>
                {wearing ? "Dressing…" : "Wear it now"}
              </button>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}
