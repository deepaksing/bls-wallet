import { BigNumber } from "ethers";
import { expect } from "chai";

import { initBlsWalletSigner, Bundle, Operation } from "../src/signer";

import Range from "./helpers/Range";

const weiPerToken = BigNumber.from(10).pow(18);

const samples = (() => {
  const dummy256HexString = "0x" + "0123456789".repeat(10).slice(0, 64);
  const contractAddress = dummy256HexString;
  // Random addresses
  const walletAddress = "0x1337AF0f4b693fd1c36d7059a0798Ff05a60DFFE";
  const otherWalletAddress = "0x42C8157D539825daFD6586B119db53761a2a91CD";

  const bundleTemplate: Operation = {
    nonce: BigNumber.from(123),
    actions: [
      {
        ethValue: BigNumber.from(0),
        contractAddress,
        encodedFunction: "0x00",
      },
      {
        ethValue: BigNumber.from(1),
        contractAddress,
        encodedFunction: "0x00",
      },
    ],
  };

  const privateKey = dummy256HexString;
  const otherPrivateKey = "0xaa" + privateKey.slice(4);

  return {
    contractAddress,
    bundleTemplate,
    privateKey,
    otherPrivateKey,
    walletAddress,
    otherWalletAddress,
  };
})();

describe("index", () => {
  it("signs and verifies transaction", async () => {
    const { bundleTemplate, privateKey, otherPrivateKey, walletAddress } =
      samples;

    const { sign, verify } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey,
    });

    const bundle = sign(bundleTemplate, walletAddress);

    expect(bundle.signature).to.deep.equal([
      "0x21135f40b38f55236ceb637ad8f2d6d4e8081bc1c37ea08273838f839008b9cd",
      "0x16515fb0821c039e127dd8e4a70c7004aec1baf698802fc16e7cf8d2ae0bb14a",
    ]);

    expect(verify(bundle, walletAddress)).to.equal(true);

    const { sign: signWithOtherPrivateKey } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey: otherPrivateKey,
    });

    const bundleBadSig = {
      ...bundle,
      signature: signWithOtherPrivateKey(bundleTemplate, walletAddress)
        .signature,
    };

    expect(verify(bundleBadSig, walletAddress)).to.equal(false);

    const bundleBadMessage: Bundle = {
      senderPublicKeys: bundle.senderPublicKeys,
      operations: [
        {
          ...bundle.operations[0],
          actions: [
            {
              ...bundle.operations[0].actions[0],
              // Pretend the client signed to pay a million tokens
              ethValue: weiPerToken.mul(1000000),
            },
            ...bundle.operations[0].actions.slice(1),
          ],
        },
      ],
      signature: bundle.signature,
    };

    expect(verify(bundleBadMessage, walletAddress)).to.equal(false);
  });

  it("aggregates transactions", async () => {
    const {
      bundleTemplate,
      privateKey,
      otherPrivateKey,
      walletAddress,
      otherWalletAddress,
    } = samples;

    const { sign, aggregate, verify } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey,
    });
    const { sign: signWithOtherPrivateKey } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey: otherPrivateKey,
    });

    const bundle1 = sign(bundleTemplate, walletAddress);
    const bundle2 = signWithOtherPrivateKey(bundleTemplate, otherWalletAddress);
    const aggBundle = aggregate([bundle1, bundle2]);

    expect(aggBundle.signature).to.deep.equal([
      "0x20c3afd45d2c7cd72003752377cf6853569bccd23abf962967a9245091b69c3b",
      "0x1ff4a18f1e920206f849e50df41e7bab6377d3908a8198d9c9268ca01ae70552",
    ]);

    expect(verify(bundle1, walletAddress)).to.equal(true);
    expect(verify(bundle2, otherWalletAddress)).to.equal(true);

    expect(verify(bundle1, otherWalletAddress)).to.equal(false);
    expect(verify(bundle2, walletAddress)).to.equal(false);

    const aggBundleBadMessage: Bundle = {
      ...aggBundle,
      operations: [
        aggBundle.operations[0],
        {
          ...aggBundle.operations[1],

          // Pretend this client signed to pay a million tokens
          actions: [
            {
              ...aggBundle.operations[1].actions[0],
              ethValue: weiPerToken.mul(1000000),
            },
            ...aggBundle.operations[1].actions.slice(1),
          ],
        },
      ],
    };

    expect(verify(aggBundleBadMessage, walletAddress)).to.equal(false);
    expect(verify(aggBundleBadMessage, otherWalletAddress)).to.equal(false);
  });

  it("can aggregate transactions which already have multiple subTransactions", async () => {
    const { bundleTemplate, privateKey, walletAddress } = samples;

    const { sign, aggregate, verify } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey,
    });

    const bundles = Range(4).map((i) =>
      sign(
        {
          ...bundleTemplate,
          actions: [
            {
              ...bundleTemplate.actions[0],
              ethValue: BigNumber.from(i),
            },
          ],
        },
        walletAddress,
      ),
    );

    const aggBundle1 = aggregate(bundles.slice(0, 2));
    const aggBundle2 = aggregate(bundles.slice(2, 4));

    const aggAggBundle = aggregate([aggBundle1, aggBundle2]);

    expect(verify(aggAggBundle, walletAddress)).to.equal(true);
  });

  it("generates expected publicKeyStr", async () => {
    const { privateKey } = samples;

    const { getPublicKeyStr } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey,
    });

    expect(getPublicKeyStr()).to.equal(
      [
        "0x",
        "027c3c0483be2722a29a0229bef64b2d8c1f8d4e954b0203d01ce342608b6eb8",
        "060c1136ac3aef9ba4b2a0272920fba5528f6e97b376c511bc746e47414a0d04",
        "11a697990758be620b0f09d3ad5bebe359964b74a29b89bdeb60671d243997fa",
        "2075298b12a51948b7a40dc69bdc91698ed95e5d2a69d04845af64aaf2eb1537",
      ].join(""),
    );
  });

  it("aggregates an empty bundle", async () => {
    const { privateKey } = samples;

    const { aggregate } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey,
    });

    const emptyBundle = aggregate([]);
    const emptyBundle2 = aggregate([emptyBundle]);

    expect(emptyBundle2.operations.length).to.equal(0);
  });

  it("verifies an empty bundle", async () => {
    const { privateKey } = samples;

    const { aggregate, verify } = await initBlsWalletSigner({
      chainId: 123,
      verificationGateway: "0xC8CD2BE653759aed7B0996315821AAe71e1FEAdF",
      privateKey,
    });

    const emptyBundle = aggregate([]);

    expect(verify(emptyBundle, samples.walletAddress)).to.equal(true);
  });
});
