// node set-fee.js <basis points>: the owner of game.<parent> sets the fee for matches opened from now on (testnet).
// Signed by the owner's full-access key from ~/.near-credentials/testnet, with the 1 yoctoNEAR the method requires.
// Matches already open keep the fee they were opened with. DEEDLORDS_PARENT (default deedlords.testnet), NEAR_RPC.
const os = require("os");
const path = require("path");
const { connect, keyStores } = require("near-api-js");

const PARENT = process.env.DEEDLORDS_PARENT ?? "deedlords.testnet";
const GAME = `game.${PARENT}`;
const RPC = process.env.NEAR_RPC ?? "https://near-testnet.drpc.org";

(async () => {
  if (!PARENT.endsWith(".testnet")) throw new Error("this script only runs on testnet");
  const bps = Number(process.argv[2]);
  if (!Number.isInteger(bps) || bps < 0 || bps > 500) throw new Error("usage: node set-fee.js <0..500 basis points>");
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore, headers: { "user-agent": "deedlords-dev/0.1" } });
  const owner = await near.account(PARENT);
  const config = await owner.viewFunction({ contractId: GAME, methodName: "get_config", args: {} });
  if (config.owner !== PARENT) throw new Error(`${GAME} is owned by ${config.owner}, not ${PARENT}`);
  console.log(`${GAME}: fee ${config.fee_bps} -> ${bps} basis points, signed by ${PARENT}`);
  const outcome = await owner.functionCall({ contractId: GAME, methodName: "set_fee", args: { fee_bps: bps }, gas: 30_000_000_000_000n, attachedDeposit: 1n });
  console.log(`tx ${outcome.transaction.hash}`);
  const after = await owner.viewFunction({ contractId: GAME, methodName: "get_config", args: {} });
  console.log(`fee now ${after.fee_bps}`);
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
