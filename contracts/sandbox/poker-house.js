// The account that plays the house at Deedlords Poker on TESTNET (games/poker/house.ts): `pokerhouse.<parent>`,
// created from the parent with test NEAR and a key of its own. Refuses mainnet. The key is written to the NEAR
// credentials directory (~/.near-credentials/testnet), never the repo, never printed.
//
//   node poker-house.js            what it would do, and the account's balance if it exists
//   node poker-house.js run        creates the account (one transaction signed by the parent), or tops it up
//
// POKER_PARENT (default deedlords.testnet), POKER_HOUSE_NEAR (default 3), NEAR_RPC (default FastNEAR testnet).
// POKER_HOUSE_NAME (default pokerhouse) names another house account: tables of several seats can seat pokerhouse2
// and pokerhouse3 too (games/poker/table/house.ts).
// Why its own account: its key sits on a web server and stakes at every table it joins. What this account holds is
// all that key, or a player who beats the house, can take.

const os = require("node:os");
const path = require("node:path");
const { connect, keyStores, KeyPair, utils } = require("near-api-js");

const PARENT = process.env.POKER_PARENT ?? "deedlords.testnet";
const AMOUNT = process.env.POKER_HOUSE_NEAR ?? "3";
const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const HOUSE = `${process.env.POKER_HOUSE_NAME ?? "pokerhouse"}.${PARENT}`;
const near = (yocto) => utils.format.formatNearAmount(String(yocto), 4);

async function main() {
  if (!PARENT.endsWith(".testnet")) throw new Error("POKER_PARENT must be a .testnet account: this script never runs on mainnet");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const chain = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore });
  if ((await chain.connection.provider.status()).chain_id !== "testnet") throw new Error("the RPC is not testnet's");
  if (!(await keyStore.getKey("testnet", PARENT))) throw new Error(`no key for ${PARENT} in ~/.near-credentials/testnet`);

  const want = BigInt(utils.format.parseNearAmount(AMOUNT));
  const parent = await chain.account(PARENT);
  const state = await (await chain.account(HOUSE)).state().catch(() => null);
  console.log(state ? `${HOUSE} holds ${near(state.amount)} NEAR` : `${HOUSE} does not exist yet`);
  const missing = state ? want - BigInt(state.amount) : want;
  if (process.argv[2] !== "run") return console.log(missing > 0n ? `"run" would ${state ? "send it" : "create it with"} ${near(missing)} NEAR from ${PARENT}` : "nothing to do");
  if (!state) {
    const key = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("testnet", HOUSE, key);
    await parent.createAccount(HOUSE, key.getPublicKey(), want);
    console.log(`created ${HOUSE} with ${near(want)} NEAR`);
  } else if (missing > 0n) {
    await parent.sendMoney(HOUSE, missing);
    console.log(`sent ${near(missing)} NEAR to ${HOUSE}`);
  } else console.log("nothing to do");
}

main().catch((e) => {
  console.error(String(e && (e.message || e)));
  process.exit(1);
});
