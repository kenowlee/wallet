import { Ref } from '@vue/composition-api';
import {
    bytesToHex,
    TransactionDetails as BtcTransactionDetails,
    TransactionState as BtcTransactionState,
} from '@nimiq/electrum-client';
import { ActiveSwap, SwapState, useSwapsStore } from '../stores/Swaps';
import { TransactionState as NimTransactionState } from '../stores/Transactions';
import { useBtcTransactionsStore } from '../stores/BtcTransactions';
import { NimHtlcDetails, SwapAsset } from './FastspotApi';
import { getElectrumClient, sendTransaction as sendBtcTx } from '../electrum';
import { getNetworkClient, sendTransaction as sendNimTx } from '../network';
import { HTLC_ADDRESS_LENGTH } from './BtcHtlcDetection';

export function getIncomingHtlcAddress(swap: ActiveSwap<any>) {
    switch (swap.to.asset) {
        case SwapAsset.NIM: return swap.contracts[SwapAsset.NIM]!.htlc.address;
        case SwapAsset.BTC: return swap.contracts[SwapAsset.BTC]!.htlc.address;
        default: throw new Error('Unknown TO asset');
    }
}

export function getOutgoingHtlcAddress(swap: ActiveSwap<any>) {
    switch (swap.from.asset) {
        case SwapAsset.NIM: return swap.contracts[SwapAsset.NIM]!.htlc.address;
        case SwapAsset.BTC: return swap.contracts[SwapAsset.BTC]!.htlc.address;
        default: throw new Error('Unknown TO asset');
    }
}

export async function awaitIncoming(swap: Ref<ActiveSwap<SwapState.AWAIT_INCOMING>>) {
    let remoteFundingTx: ReturnType<Nimiq.Client.TransactionDetails['toPlain']>
        | BtcTransactionDetails
        | null = null;

    if (swap.value.to.asset === SwapAsset.BTC) {
        const htlcAddress = getIncomingHtlcAddress(swap.value);

        // eslint-disable-next-line no-async-promise-executor
        remoteFundingTx = await new Promise(async (resolve) => {
            function listener(tx: BtcTransactionDetails) {
                const htlcOutput = tx.outputs.find((out) => out.address === htlcAddress);
                if (!htlcOutput || htlcOutput.value !== swap.value.to.amount + swap.value.to.fee) return false;

                if (
                    tx.replaceByFee
                    // Must wait until mined
                    && ![BtcTransactionState.MINED, BtcTransactionState.CONFIRMED].includes(tx.state)
                ) return false;

                resolve(tx);
                return true;
            }

            const electrumClient = await getElectrumClient();
            // First subscribe to new transactions
            electrumClient.addTransactionListener(listener, [htlcAddress]);

            // Then check history
            const history = await electrumClient.getTransactionsByAddress(htlcAddress);
            for (const tx of history) {
                if (listener(tx)) break;
            }
        });
    }

    if (swap.value.to.asset === SwapAsset.NIM) {
        const nimHtlcData = swap.value.contracts[SwapAsset.NIM]!.htlc as NimHtlcDetails;

        remoteFundingTx = await new Promise<
            ReturnType<Nimiq.Client.TransactionDetails['toPlain']>
        // eslint-disable-next-line no-async-promise-executor
        >(async (resolve) => {
            const htlcAddress = nimHtlcData.address;

            function listener(tx: ReturnType<Nimiq.Client.TransactionDetails['toPlain']>) {
                if (tx.recipient !== htlcAddress) return false;

                let hexData = nimHtlcData.data;
                if (hexData.length !== 156) {
                    // Convert Base64 to HEX
                    hexData = bytesToHex(new Uint8Array(
                        atob(nimHtlcData.data).split('').map((c) => c.charCodeAt(0))));
                }

                // TODO: Reject when unequal (=> handle error)
                if (tx.data.raw !== hexData) return false;

                if (tx.state === NimTransactionState.MINED || tx.state === NimTransactionState.CONFIRMED) {
                    resolve(tx);
                    return true;
                }
                return false;
            }

            const client = await getNetworkClient();
            // First subscribe to new transactions
            client.addTransactionListener(listener, [htlcAddress]);

            // Then check history
            try {
                const history = await client.getTransactionsByAddress(htlcAddress, 0);
                for (const tx of history) {
                    if (listener(tx)) break;
                }
            } catch (error) {
                console.log(error); // eslint-disable-line no-console
            }
        });
    }

    useSwapsStore().setActiveSwap({
        ...swap.value,
        state: SwapState.CREATE_OUTGOING,
        remoteFundingTx: remoteFundingTx!,
    });
}

export async function createOutgoing(swap: Ref<ActiveSwap<SwapState.CREATE_OUTGOING>>) {
    let fundingTx: ReturnType<Nimiq.Client.TransactionDetails['toPlain']> | BtcTransactionDetails;

    if (swap.value.from.asset === SwapAsset.NIM) {
        // TODO: Catch error
        fundingTx = await sendNimTx(swap.value.fundingSerializedTx);
    }

    if (swap.value.from.asset === SwapAsset.BTC) {
        // TODO: Catch error
        fundingTx = await sendBtcTx(swap.value.fundingSerializedTx);

        useSwapsStore().addFundingData(swap.value.hash, {
            asset: SwapAsset.BTC,
            transactionHash: fundingTx.transactionHash,
            outputIndex: fundingTx.outputs.findIndex((output) => output.address?.length === HTLC_ADDRESS_LENGTH),
        });
        // @ts-ignore
        fundingTx.swapHash = swap.value.hash;

        useBtcTransactionsStore().addTransactions([fundingTx]);
    }

    useSwapsStore().setActiveSwap({
        ...swap.value,
        state: SwapState.AWAIT_SECRET,
        fundingTx: fundingTx!,
    });
}

export async function awaitSecret(swap: Ref<ActiveSwap<SwapState.AWAIT_SECRET>>) {
    let secret: string;

    if (swap.value.from.asset === SwapAsset.NIM) {
        const nimHtlcAddress = getOutgoingHtlcAddress(swap.value);

        // Wait until Fastspot claims the NIM HTLC created by us
        // eslint-disable-next-line no-async-promise-executor
        secret = await new Promise<string>(async (resolve) => {
            function listener(tx: ReturnType<Nimiq.Client.TransactionDetails['toPlain']>) {
                if (tx.sender === nimHtlcAddress && 'preImage' in tx.proof) {
                    // @ts-ignore
                    resolve(tx.proof.preImage);
                    return true;
                }
                return false;
            }

            const client = await getNetworkClient();
            // First subscribe to new transactions
            client.addTransactionListener(listener, [nimHtlcAddress]);

            // Then check history
            try {
                const history = await client.getTransactionsByAddress(nimHtlcAddress, 0);
                for (const tx of history) {
                    if (listener(tx)) break;
                }
            } catch (error) {
                console.error(error); // eslint-disable-line no-console
            }
        });
    }

    if (swap.value.from.asset === SwapAsset.BTC) {
        const btcHtlcAddress = getOutgoingHtlcAddress(swap.value);

        // Wait until Fastspot claims the BTC HTLC created by us
        // eslint-disable-next-line no-async-promise-executor
        secret = await new Promise<string>(async (resolve) => {
            function listener(tx: BtcTransactionDetails) {
                const htlcInput = tx.inputs.find((input) => input.address === btcHtlcAddress);
                if (htlcInput) {
                    resolve(htlcInput.witness[2] as string);
                    return true;
                }
                return false;
            }

            const electrumClient = await getElectrumClient();
            // First subscribe to new transactions
            electrumClient.addTransactionListener(listener, [btcHtlcAddress]);

            // Then check history
            const history = await electrumClient.getTransactionsByAddress(btcHtlcAddress);
            for (const tx of history) {
                if (listener(tx)) break;
            }
        });
    }

    useSwapsStore().setActiveSwap({
        ...swap.value,
        state: SwapState.SETTLE_INCOMING,
        secret: secret!,
    });
}

export async function settleIncoming(swap: Ref<ActiveSwap<SwapState.SETTLE_INCOMING>>) {
    let settlementTx: ReturnType<Nimiq.Client.TransactionDetails['toPlain']> | BtcTransactionDetails;

    if (swap.value.to.asset === SwapAsset.BTC) {
        // Place secret into BTC HTLC redeem transaction

        // const rawTx = BitcoinJS.Transaction.fromHex(signedTransactions.btc.serializedTx);
        // rawTx.ins[0].witness[2] = BitcoinJS.Buffer.from(secret.value, 'hex');
        // const serializedTx = rawTx.toHex();
        const serializedTx = swap.value.settlementSerializedTx.replace(
            '000000000000000000000000000000000000000000000000000000000000000001',
            // @ts-ignore Property 'secret' does not exist on type
            `${swap.value.secret}01`,
        );

        // TODO: Catch error
        settlementTx = await sendBtcTx(serializedTx);

        useBtcTransactionsStore().addTransactions([settlementTx]);
    }

    if (swap.value.to.asset === SwapAsset.NIM) {
        // Place secret into NIM HTLC redeem transaction

        const serializedTx = swap.value.settlementSerializedTx.replace(
            '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925'
            + '0000000000000000000000000000000000000000000000000000000000000000',
            // @ts-ignore Property 'secret' does not exist on type
            `${swap.value.hash!}${swap.value.secret}`,
        );

        // TODO: Catch error
        settlementTx = await sendNimTx(serializedTx);
    }

    useSwapsStore().setActiveSwap({
        ...swap.value,
        state: SwapState.COMPLETE,
        settlementTx: settlementTx!,
    });
}