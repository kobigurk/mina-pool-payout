import { Block } from "./queries";
import { stakeIsLocked, Stake } from "./stakes";
// per foundation and o1 rules, the maximum fee is 5%, excluding fees and supercharged coinbase
// see https://minaprotocol.com/docs/advanced/foundation-delegation-program
const npsCommissionRate = 0.05

export async function getPayouts(blocks: Block[], stakers: Stake[], totalStake: number, commissionRate: number):
  Promise<[payoutJson: PayoutTransaction[], storePayout: PayoutDetails[], blocksIncluded: number[], totalPayout: number]> {

  // Initialize some stuff
  let blocksIncluded: number[] = [];
  let storePayout: PayoutDetails[] = [];

  // for each block, calculate the effective stake of each staker
  blocks.forEach((block: Block) => {

    // Keep a log of all blocks we processed
    blocksIncluded.push(block.blockheight);

    if (typeof (block.coinbase) === 'undefined' || block.coinbase == 0) {
      // no coinbase, don't need to do anything
    } else {

      const winner = getWinner(stakers, block);

      let effectiveStakes: { [key: string]: number } = {};
      let effectivePortions: { [key: string]: number } = {};

      const transactionFees = block.usercommandtransactionfees || 0;
      const totalRewards = block.coinbase + block.feetransfertoreceiver - block.feetransferfromcoinbase;

      // Determine the supercharged discount for the block
      //  unlocked accounts will get a double share less this discount based on the ratio of fees : coinbase
      //  unlocked accounts generate extra coinbase, but if fees are significant, that coinbase would have a lower relative weight
      const superchargedWeightingDiscount = transactionFees / block.coinbase;

      let sumUnweightedStakes = 0;
      let sumEffectiveStakes = 0;
      stakers.forEach((staker: Stake) => {
        const effectiveStake = (stakeIsLocked(staker, block) || staker.shareClass == "NPS") ? staker.stakingBalance : staker.stakingBalance * (2 - superchargedWeightingDiscount);
        effectiveStakes[staker.publicKey] = effectiveStake;
        sumUnweightedStakes += staker.stakingBalance;
        sumEffectiveStakes += effectiveStake;
      });

      stakers.forEach((staker: Stake) => {
        const commission = staker.shareClass == "NPS" ? npsCommissionRate : commissionRate;
        effectivePortions[staker.publicKey] = effectiveStakes[staker.publicKey]/sumEffectiveStakes * commission * totalRewards;
      });

      // Sense check the effective pool stakes must be at least equal to total_staking_balance and less than 2x
      if (sumEffectiveStakes < sumUnweightedStakes) {
        throw new Error('Share must not be less than total stake');
      }
      if (sumEffectiveStakes > sumUnweightedStakes * 2) {
        throw new Error('Weighted share must not be greater than 2x total stake');
      }

      stakers.forEach((staker: Stake) => {
        staker.total += effectivePortions[staker.publicKey];

        // Store this data in a structured format for later querying and for the payment script, handled seperately
        storePayout.push({
          publicKey: staker.publicKey,
          blockHeight: block.blockheight,
          globalSlot: block.globalslotsincegenesis,
          publicKeyUntimedAfter: staker.untimedAfterSlot,
          shareClass: staker.shareClass,
          stateHash: block.statehash,
          stakingBalance: staker.stakingBalance,
          effectiveStakes: effectiveStakes[staker.publicKey],
          sumEffectiveStakes: sumEffectiveStakes,
          superchargedWeightingDiscount: superchargedWeightingDiscount,
          dateTime: block.blockdatetime,
          coinbase: block.coinbase,
          totalRewards: totalRewards,
          payout: effectivePortions[staker.publicKey],
        });
      });
    }
  });

  let payoutJson: PayoutTransaction[] = [];
  let totalPayout = 0;
  stakers.forEach((staker: Stake) => {
    const amount = staker.total;
    if (amount > 0) {
      payoutJson.push({
        publicKey: staker.publicKey,
        amount: amount,
        fee: 0,
      });
      totalPayout += amount;
    }
  });
  return [payoutJson, storePayout, blocksIncluded, totalPayout];
}

function getWinner(stakers: Stake[], block: Block): Stake {
  const winners = stakers.filter(x => x.publicKey == block.winnerpublickey);
  if (winners.length != 1) {
    throw new Error("Should have exactly 1 winner.");
  }
  return winners[0];
}

export type PayoutDetails = {
  publicKey: string,
  blockHeight: number,
  globalSlot: number,
  publicKeyUntimedAfter: number,
  shareClass: "NPS"|"Common",
  stateHash: string,
  effectiveStakes: number,
  stakingBalance: number,
  sumEffectiveStakes: number,
  superchargedWeightingDiscount: number,
  dateTime: number,
  coinbase: number,
  totalRewards: number,
  payout: number
};

export type PayoutTransaction = {
  publicKey: string,
  amount: number,
  fee: number,
};
