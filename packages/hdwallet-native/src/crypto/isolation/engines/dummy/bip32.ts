export * from "../../core/bip32";
import * as BIP32 from "../../core/bip32";

import * as bip32crypto from "bip32/src/crypto";
import * as tinyecc from "tiny-secp256k1";
import { TextEncoder } from "web-encoding";

import { ByteArray, Uint32, checkType, safeBufferFrom } from "../../types";
import { Digest, SecP256K1 } from "../../core";
import { ChainCode } from "../../core/bip32";

export class Seed implements BIP32.Seed {
    readonly #seed: Buffer;

    constructor(seed: Uint8Array) {
      this.#seed = safeBufferFrom(seed);
    }

    toMasterKey(hmacKey?: string | Uint8Array): Node {
        if (hmacKey !== undefined && typeof hmacKey !== "string" && !(hmacKey instanceof Uint8Array)) throw new Error("bad hmacKey type");

        // AFIAK all BIP32 implementations use the "Bitcoin seed" string for this derivation, even if they aren't otherwise Bitcoin-related
        hmacKey = hmacKey ?? "Bitcoin seed";
        if (typeof hmacKey === "string") hmacKey = new TextEncoder().encode(hmacKey.normalize("NFKD"));
        const I = safeBufferFrom(bip32crypto.hmacSHA512(safeBufferFrom(hmacKey), this.#seed));
        const IL = I.slice(0, 32);
        const IR = I.slice(32, 64);
        return new Node(IL, IR);
    }
}

export class Node implements BIP32.Node, SecP256K1.ECDSARecoverableKey, SecP256K1.ECDHKey {
    readonly #privateKey: Buffer & ByteArray<32>;
    readonly chainCode: Buffer & BIP32.ChainCode;
    #publicKey: SecP256K1.CompressedPoint | undefined;

    constructor(privateKey: Uint8Array, chainCode: Uint8Array) {
        // We avoid handing the private key to any non-platform code -- including our type-checking machinery.
        if (privateKey.length !== 32) throw new Error("bad private key length");
        this.#privateKey = safeBufferFrom(privateKey) as Buffer & ByteArray<32>;
        this.chainCode = safeBufferFrom(checkType(BIP32.ChainCode, chainCode)) as Buffer & ChainCode;
    }

    get publicKey() {
        this.#publicKey = this.#publicKey ?? checkType(SecP256K1.CompressedPoint, tinyecc.pointFromScalar(this.#privateKey, true));
        return this.#publicKey;
    }

    async ecdsaSign(msg: SecP256K1.Message, counter?: Uint32): Promise<SecP256K1.RecoverableSignature> {
        SecP256K1.Message.assert(msg);
        counter === undefined || Uint32.assert(counter);

        // When running tests, this will keep us aware of any codepaths that don't pass in the preimage
        if (typeof expect === "function") expect(SecP256K1.MessageWithPreimage.test(msg)).toBeTruthy();

        const entropy = (counter === undefined ? undefined : Buffer.alloc(32));
        entropy?.writeUInt32BE(counter ?? 0, 24);
        return SecP256K1.RecoverableSignature.fromSignature(
            checkType(SecP256K1.Signature, (tinyecc as typeof tinyecc & {
                signWithEntropy: (message: Buffer, privateKey: Buffer, entropy?: Buffer) => Buffer,
            }).signWithEntropy(Buffer.from(msg), this.#privateKey, entropy)),
            msg,
            this.publicKey,
        );
    }

    derive(index: Uint32): this {
        Uint32.assert(index);

        let serP = Buffer.alloc(37);
        if (index < 0x80000000) {
            serP.set(SecP256K1.CompressedPoint.from(this.publicKey), 0);
        } else {
            serP.set(this.#privateKey, 1);
        }
        serP.writeUInt32BE(index, 33);
        
        const I = bip32crypto.hmacSHA512(this.chainCode, serP);
        const IL = I.slice(0, 32);
        const IR = I.slice(32, 64);
        const ki = tinyecc.privateAdd(this.#privateKey, IL);
        if (ki === null) throw new Error("ki is null; this should be cryptographically impossible");
        return new Node(ki, IR) as this;
    }
  
    async ecdh(publicKey: SecP256K1.CurvePoint, digestAlgorithm?: Digest.AlgorithmName<32>): Promise<ByteArray<32>> {
        SecP256K1.CurvePoint.assert(publicKey);
        digestAlgorithm === undefined || Digest.AlgorithmName(32).assert(digestAlgorithm);

        return checkType(ByteArray(32), await this._ecdh(publicKey, digestAlgorithm));
    }

    async ecdhRaw(publicKey: SecP256K1.CurvePoint): Promise<SecP256K1.UncompressedPoint> {
        return checkType(SecP256K1.UncompressedPoint, await this._ecdh(publicKey, null));
    }

    private async _ecdh(publicKey: SecP256K1.CurvePoint, digestAlgorithm?: Digest.AlgorithmName<32> | null): Promise<ByteArray<32> | SecP256K1.UncompressedPoint> {
        SecP256K1.CurvePoint.assert(publicKey);
        digestAlgorithm === undefined || digestAlgorithm === null || Digest.AlgorithmName(32).assert(digestAlgorithm);

        const sharedFieldElement = checkType(SecP256K1.UncompressedPoint, tinyecc.pointMultiply(Buffer.from(publicKey), this.#privateKey, false));
        if (digestAlgorithm === null) return sharedFieldElement;

        let out = SecP256K1.CurvePoint.x(sharedFieldElement);
        if (digestAlgorithm !== undefined) out = Digest.Algorithms[digestAlgorithm](out);
        return out;
    }
}
