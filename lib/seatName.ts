// How a seat is named at a table. A guest's account is 64 hex digits, which says nothing to the other players and
// fills a table of nine with "a2aeb31…". Everyone is shown the same short handle for it instead, worked out from the
// account itself: an animal and two digits ("Otter27"). It is a label only: the account is still what plays, what the
// contract pays and what the explorer shows. A named account (alice.near, p1.deedlords.testnet) keeps its own name,
// and a character's name, where its owner made one, comes before both.

const ANIMALS = [
  "Otter", "Panda", "Tiger", "Koala", "Lynx", "Heron", "Bison", "Gecko", "Lemur", "Moose", "Orca", "Raven",
  "Robin", "Shark", "Sloth", "Stork", "Swan", "Viper", "Whale", "Zebra", "Badger", "Beaver", "Bobcat", "Condor",
  "Cougar", "Coyote", "Dingo", "Falcon", "Ferret", "Gibbon", "Iguana", "Jackal", "Jaguar", "Marten", "Osprey", "Parrot",
  "Puffin", "Python", "Rabbit", "Salmon", "Toucan", "Turtle", "Walrus", "Weasel", "Wombat", "Magpie", "Marlin", "Mantis",
];

/** An implicit account: the 64 hex digits of a key. A guest's game account is one, and so is an EVM wallet's. */
export const isGuestAccount = (accountId: string): boolean => /^[0-9a-f]{64}$/.test(accountId);

/** The handle everyone is shown for an implicit account: at most eight letters and digits, the same on every page. */
export function guestHandle(accountId: string): string {
  const animal = ANIMALS[parseInt(accountId.slice(0, 6), 16) % ANIMALS.length];
  const number = parseInt(accountId.slice(6, 10), 16) % 100;
  return `${animal}${String(number).padStart(2, "0")}`;
}

/** A seat's name when its player has no character: the handle of an implicit account, else the account as `short` writes it. */
export const seatName = (accountId: string, short: (accountId: string) => string): string => (isGuestAccount(accountId) ? guestHandle(accountId) : short(accountId));
