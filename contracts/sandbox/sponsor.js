// The account that sponsors free play on TESTNET (see lib/chain/sponsor.ts): `free.<parent>`, created from the parent
// with a little test NEAR and a key of its own. Refuses mainnet. The key is written to the NEAR credentials directory
// (~/.near-credentials/testnet), never the repo, never printed.
//
//   node sponsor.js            what it would do, and the account's balance if it exists
//   node sponsor.js run        creates the account (one transaction signed by the parent), or tops it up to the amount
//
// DEEDLORDS_PARENT (default deedlords.testnet), DEEDLORDS_SPONSOR_NEAR (default 1), NEAR_RPC (default FastNEAR testnet).
// Why its own account: a relayer's key sits on a web server. What this account holds is all that key can lose.

const os = require("node:os");
const path = require("node:path");
const { connect, keyStores, KeyPair, utils } = require("near-api-js");

const PARENT = process.env.DEEDLORDS_PARENT ?? "deedlords.testnet";
const AMOUNT = process.env.DEEDLORDS_SPONSOR_NEAR ?? "1";
const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const SPONSOR = `free.${PARENT}`;
const near = (yocto) => utils.format.formatNearAmount(String(yocto), 4);

async function main() {
  if (!PARENT.endsWith(".testnet")) throw new Error("DEEDLORDS_PARENT must be a .testnet account: this script never runs on mainnet");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const chain = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore, headers: { "user-agent": "deedlords-dev/0.1" } });
  const status = await chain.connection.provider.status();
  if (status.chain_id !== "testnet") throw new Error(`expected chain testnet, the RPC reports ${status.chain_id}`);
  if (!(await keyStore.getKey("testnet", PARENT))) throw new Error(`no key for ${PARENT} in ~/.near-credentials/testnet`);

  const want = BigInt(utils.format.parseNearAmount(AMOUNT));
  const parent = await chain.account(PARENT);
  const sponsor = await chain.account(SPONSOR);
  const state = await sponsor.state().catch(() => null);
  const run = process.argv[2] === "run";

  if (!state) {
    console.log(`${SPONSOR} does not exist. ${run ? "Creating it" : "Would create it"} with ${AMOUNT} NEAR from ${PARENT} (${near((await parent.state()).amount)} NEAR).`);
    if (!run) return console.log("Nothing sent. `node sponsor.js run` does it.");
    const key = KeyPair.fromRandom("ed25519");
    await keyStore.setKey("testnet", SPONSOR, key); // before the transaction: a key nobody kept would strand the account
    const made = await parent.createAccount(SPONSOR, key.getPublicKey(), want);
    console.log(`created: ${made.transaction.hash}`);
  } else {
    const has = BigInt(state.amount);
    console.log(`${SPONSOR} holds ${near(has)} NEAR.`);
    if (has >= want) return;
    console.log(`${run ? "Sending" : "Would send"} ${near(want - has)} NEAR from ${PARENT} to bring it to ${AMOUNT}.`);
    if (!run) return console.log("Nothing sent. `node sponsor.js run` does it.");
    const sent = await parent.sendMoney(SPONSOR, want - has);
    console.log(`sent: ${sent.transaction.hash}`);
  }
  console.log(`${SPONSOR} now holds ${near((await sponsor.state()).amount)} NEAR. Point the web app at it: DEEDLORDS_SPONSOR_ACCOUNT=${SPONSOR}`);
}

main().catch((error) => {
  console.error(String(error.message ?? error));
  process.exit(1);
});
